"""Focused frame-index helpers and route wiring, without a business database."""
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app import media, tasks


@pytest.fixture(autouse=True)
def reset_cache():
    media._frame_times.cache_clear()
    yield
    media._frame_times.cache_clear()


def test_frame_index_uses_presentation_times_and_invalidates_changed_file(tmp_path, monkeypatch):
    path = tmp_path / "clip.mp4"
    path.write_bytes(b"mock")
    calls = []
    payload = {"format": {"start_time": "2"}, "frames": [
        {"best_effort_timestamp_time": value}
        for value in ["2.067", "2", "2.033367", "2.033367", "1.9", "2.2"]
    ]}

    def run(args, **kwargs):
        calls.append(args)
        assert kwargs["timeout"] == 60
        assert "frame=best_effort_timestamp_time:format=start_time" in args
        return subprocess.CompletedProcess(args, 0, json.dumps(payload))

    monkeypatch.setattr(subprocess, "run", run)
    values = media.probe_frame_times_ms(path, "ffprobe", 200)
    assert values == [0, 34, 67]
    values.append(99)  # Caller cannot mutate the cached tuple.
    assert media.probe_frame_times_ms(path, "ffprobe", 200) == [0, 34, 67]
    assert len(calls) == 1
    path.write_bytes(b"changed")
    media.probe_frame_times_ms(path, "ffprobe", 200)
    assert len(calls) == 2


@pytest.mark.parametrize("frames", [[], [{}], [{"best_effort_timestamp_time": "NaN"}],
                                    [{"best_effort_timestamp_time": "Infinity"}]])
def test_bad_frame_metadata_is_rejected(tmp_path, monkeypatch, frames):
    path = tmp_path / "clip.mp4"
    path.touch()
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs:
                        subprocess.CompletedProcess([], 0, json.dumps({"frames": frames})))
    with pytest.raises(ValueError):
        media.probe_frame_times_ms(path, "ffprobe", 1000)


def test_frame_route_checks_visibility_before_reading_video(monkeypatch):
    def denied(*args):
        raise HTTPException(404, "任务不存在或无权访问")

    def unexpected(*args):
        pytest.fail("frame probing must not run before visibility succeeds")

    monkeypatch.setattr(tasks, "find_visible_task", denied)
    monkeypatch.setattr(tasks, "probe_frame_times_ms", unexpected)
    with pytest.raises(HTTPException) as caught:
        tasks.task_frames(uuid4(), SimpleNamespace(user=object()), object())
    assert caught.value.status_code == 404


def test_frame_route_returns_index_and_reports_probe_failure(monkeypatch, tmp_path):
    task_id, user, db = uuid4(), object(), object()

    def visible(given_id, given_user, given_db):
        assert (given_id, given_user, given_db) == (task_id, user, db)
        return SimpleNamespace(video_key="clip.mp4", duration_ms=200)

    monkeypatch.setattr(tasks, "find_visible_task", visible)
    monkeypatch.setattr(tasks, "get_settings", lambda: SimpleNamespace(
        resolved_video_dir=tmp_path, ffprobe_binary="ffprobe"))
    monkeypatch.setattr(tasks, "probe_frame_times_ms", lambda *args: [0, 34, 67])
    auth = SimpleNamespace(user=user)
    assert tasks.task_frames(task_id, auth, db) == {"frame_times_ms": [0, 34, 67]}

    def timeout(*args):
        raise subprocess.TimeoutExpired("ffprobe", 60)

    monkeypatch.setattr(tasks, "probe_frame_times_ms", timeout)
    with pytest.raises(HTTPException) as caught:
        tasks.task_frames(task_id, auth, db)
    assert caught.value.status_code == 503
