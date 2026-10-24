import subprocess

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Task
from tools.automation_environment import VIDEO_DIR


@pytest.fixture
def upload(world, tmp_path, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "video_dir", tmp_path)
    client, headers = world.client("admin")
    url = f"/api/tasks?title=isolated-upload&tenant_id={world.tenants['a']}"

    def count():
        with Session(world.engine) as db:
            return db.scalar(select(func.count()).select_from(Task).where(Task.tenant_id == world.tenants["a"]))

    return client, headers, url, tmp_path, count


@pytest.mark.parametrize("case,expected", [
    ("empty", 422), ("not-mp4", 422), ("truncated-mp4", 422),
    ("content-length-limit", 413), ("stream-limit", 413),
    ("incomplete", 422), ("invalid-length", 400),
    ("probe-unavailable", 503), ("probe-timeout", 422),
    ("blank-title", 422), ("unknown-tenant", 422),
])
def test_upload_failures_leave_neither_tasks_nor_partial_files(upload, monkeypatch, case, expected):
    client, headers, url, directory, count = upload
    before = count()
    content = b"\0\0\0\x18ftypmp42" + b"\0" * 64
    if case == "empty":
        content = b""
    elif case == "not-mp4":
        content = b"this is not a video"
    elif case in ("content-length-limit", "stream-limit"):
        monkeypatch.setattr(get_settings(), "max_upload_mb", 1)
        if case == "content-length-limit":
            headers["Content-Length"] = str(1024 * 1024 + 1)
        else:
            content = iter([content, b"x" * (1024 * 1024)])
    elif case == "incomplete":
        headers["Content-Length"] = str(len(content) + 10)
    elif case == "invalid-length":
        headers["Content-Length"] = "invalid"
    elif case.startswith("probe-"):
        from app import workflow

        def fail_probe(*args):
            if case == "probe-unavailable":
                raise FileNotFoundError("injected")
            raise subprocess.TimeoutExpired("ffprobe", 30)

        monkeypatch.setattr(workflow, "probe_duration_ms", fail_probe)
    elif case == "blank-title":
        url = url.replace("isolated-upload", "%20%20")
    elif case == "unknown-tenant":
        from uuid import uuid4
        url = url.split("tenant_id=")[0] + f"tenant_id={uuid4()}"
    response = client.post(url, headers=headers, content=content)
    assert response.status_code == expected
    assert count() == before
    assert list(directory.iterdir()) == []


def test_real_upload_probe_and_authenticated_range_responses(upload):
    client, headers, url, directory, count = upload
    clip = (VIDEO_DIR / "pusht-demo.mp4").read_bytes()
    response = client.post(url, headers={**headers, "Content-Type": "video/mp4"}, content=clip)
    assert response.status_code == 201
    data = response.json()
    assert data["status"] == "available" and data["duration_ms"] > 3000
    assert count() == 1
    assert len(list(directory.glob("*.mp4"))) == 1
    assert not list(directory.glob("*.part"))
    path = f"/api/tasks/{data['id']}/video"
    partial = client.get(path, headers={"Range": "bytes=0-15"})
    assert partial.status_code == 206 and partial.content == clip[:16]
    assert partial.headers["content-range"] == f"bytes 0-15/{len(clip)}"
    suffix = client.get(path, headers={"Range": "bytes=-10"})
    assert suffix.status_code == 206 and suffix.content == clip[-10:]
    invalid = client.get(path, headers={"Range": f"bytes={len(clip)}-"})
    assert invalid.status_code == 416
    assert invalid.headers["content-range"] == f"bytes */{len(clip)}"
    # A separate client proves that media cookies/permissions are enforced server-side.
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as anonymous:
        denied = anonymous.get(path, headers={"Range": "bytes=0-15"})
        assert denied.status_code == 401
        assert "content-range" not in denied.headers
    frames = client.get(f"/api/tasks/{data['id']}/frames")
    assert frames.status_code == 200
    times = frames.json()["frame_times_ms"]
    assert times == sorted(set(times)) and times[0] >= 0 and times[-1] < data["duration_ms"]


@pytest.mark.parametrize("phase", ["before-commit", "lost-commit-ack"])
def test_upload_database_failures_preserve_file_database_consistency(upload, monkeypatch, phase):
    client, headers, url, directory, count = upload
    original = Session.commit
    triggered = False

    def commit(db):
        nonlocal triggered
        if triggered:
            return original(db)
        triggered = True
        if phase == "lost-commit-ack":
            original(db)
        raise OperationalError("injected commit acknowledgement failure", {}, Exception("injected"))

    monkeypatch.setattr(Session, "commit", commit)
    response = client.post(url, headers=headers, content=(VIDEO_DIR / "pusht-demo.mp4").read_bytes())
    assert triggered and response.status_code == 503
    assert not list(directory.glob("*.part"))
    # Once commit has started its result can be ambiguous: finalized files are retained.
    assert len(list(directory.glob("*.mp4"))) == 1
    assert count() == (1 if phase == "lost-commit-ack" else 0)
    if phase == "lost-commit-ack":
        task = client.get("/api/tasks").json()["items"][0]
        assert client.get(f"/api/tasks/{task['id']}/video", headers={"Range": "bytes=0-15"}).status_code == 206


def test_upload_flush_failure_cleans_finalized_file(upload, monkeypatch):
    client, headers, url, directory, count = upload
    original = Session.flush

    def flush(db, *args, **kwargs):
        if any(isinstance(item, Task) for item in db.new):
            raise OperationalError("injected pre-commit failure", {}, Exception("injected"))
        return original(db, *args, **kwargs)

    monkeypatch.setattr(Session, "flush", flush)
    response = client.post(url, headers=headers, content=(VIDEO_DIR / "pusht-demo.mp4").read_bytes())
    assert response.status_code == 503
    assert count() == 0 and list(directory.iterdir()) == []
