"""Guarded configuration for disposable API/DB/browser tests. Never print secrets."""
import argparse
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys

from dotenv import dotenv_values
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / ".cache/automation-tests.env"
VIDEO_DIR = ROOT / ".cache/automation-videos"
DATABASE = "annotation_automation_tests"


def prepare():
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    if not CONFIG.exists():
        password = secrets.token_hex(24)
        with CONFIG.open("x", encoding="utf-8", newline="\n") as output:
            output.write(
                f"AUTOMATION_TEST_PASSWORD={password}\n"
                f"APP_AUTOMATION_DATABASE_URL=postgresql+psycopg://{DATABASE}:{password}"
                f"@127.0.0.1:55435/{DATABASE}\n"
                f"AUTOMATION_DEMO_PASSWORD={secrets.token_urlsafe(24)}\n"
            )
    source = ROOT / "storage/videos/pusht-demo.mp4"
    if not source.is_file():
        raise RuntimeError("Missing local demo video; follow README preparation first")
    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    clean_uploads()
    shutil.copyfile(source, VIDEO_DIR / source.name)


def clean_uploads():
    # Only UUID-named outputs of uploads inside this exact owned cache directory.
    directory = VIDEO_DIR.resolve()
    if directory != ROOT.resolve() / ".cache/automation-videos":
        raise RuntimeError("Refusing cleanup outside automation video directory")
    if directory.is_dir():
        for candidate in directory.iterdir():
            if candidate.is_file() and re.fullmatch(r"[a-f0-9]{32}\.(mp4|part)", candidate.name):
                candidate.unlink()


def guarded_url():
    raw = dotenv_values(CONFIG).get("APP_AUTOMATION_DATABASE_URL")
    if not raw:
        raise RuntimeError("Run tools/automation_environment.py prepare first")
    url = make_url(raw)
    if url.query or (url.drivername, url.host, url.port, url.database, url.username) != (
        "postgresql+psycopg", "127.0.0.1", 55435, DATABASE, DATABASE,
    ):
        raise RuntimeError("Refusing a database outside the disposable automation environment")
    return raw


def configure():
    raw = guarded_url()
    values = dotenv_values(CONFIG)
    binary = shutil.which("ffprobe")
    bundled = ROOT / ".cache/media-tools/node_modules/@ffprobe-installer/win32-x64/ffprobe.exe"
    if not binary and bundled.is_file():
        binary = str(bundled)
    if not binary:
        raise RuntimeError("ffprobe not found; follow README media preparation first")
    os.environ.update({
        "APP_DATABASE_URL": raw,
        "APP_VIDEO_DIR": str(VIDEO_DIR),
        "APP_FFPROBE_BINARY": binary,
        "APP_COOKIE_SECURE": "false",
        "APP_SESSION_HOURS": "12",
        "APP_MAX_UPLOAD_MB": "512",
        "APP_ALLOWED_ORIGINS": '["http://testserver","http://127.0.0.1:5184","http://127.0.0.1:5880"]',
        "APP_ALLOW_DEMO_SEED": "true",
        "APP_DEMO_PASSWORD": values["AUTOMATION_DEMO_PASSWORD"],
    })
    return raw


def migrate():
    configure()
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=ROOT / "src/backend", capture_output=True, timeout=60,
    )
    if result.returncode:
        raise RuntimeError("Automation database migration failed (credentials withheld)")


def seed_twice():
    configure()
    sys.path.insert(0, str(ROOT / "src/backend"))
    from app.db import get_engine
    from app.models import Task, Tenant, User
    from app.seed import demo_id, main
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    def snapshot():
        with Session(get_engine()) as db:
            return [db.execute(select(*model.__table__.columns).order_by(model.id)).all()
                    for model in (Tenant, User, Task)]

    # Keep seed's local-.env instructions out of test logs.
    import contextlib
    import io
    with contextlib.redirect_stdout(io.StringIO()):
        main()
        # A repeated seed must preserve subsequent work, not just an untouched seed.
        with Session(get_engine()) as db, db.begin():
            task = db.get(Task, demo_id("task-A-03"))
            task.status = "in_progress"
            task.assignee_id = demo_id("user-a2")
            task.revision = 4
            task.title = "Automation seed must preserve edited task"
        first = snapshot()
        main()
    assert snapshot() == first, "Repeated seed changed existing data/passwords"
    assert [len(rows) for rows in first] == [2, 4, 7], "Seed must start on an empty test DB"
    print("Real seed repeated: 2 tenants / 4 users / 7 tasks; unchanged on retry")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["prepare", "migrate", "seed"])
    args = parser.parse_args()
    try:
        {"prepare": prepare, "migrate": migrate, "seed": seed_twice}[args.command]()
    except Exception:
        # Connection exceptions can embed passwords. Diagnostics stay credential-free.
        print(f"Automation environment {args.command} failed; check prerequisites and isolated DB", file=sys.stderr)
        sys.exit(1)
