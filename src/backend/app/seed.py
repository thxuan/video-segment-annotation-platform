"""Explicit, idempotent local demo initialization; never runs at API startup."""
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_engine
from app.media import probe_duration_ms, resolve_video_path
from app.models import Task, Tenant, User
from app.security import hash_password


def demo_id(name: str):
    return uuid5(NAMESPACE_URL, f"video-segment-annotation-platform/demo/{name}")


def main():
    settings = get_settings()
    password = settings.demo_password.get_secret_value()
    if not settings.allow_demo_seed or len(password) < 12 or password.startswith("replace-"):
        raise SystemExit("请先配置本地 APP_ALLOW_DEMO_SEED 和至少 12 位 APP_DEMO_PASSWORD")
    path = resolve_video_path(settings.resolved_video_dir, "pusht-demo.mp4")
    if not path.is_file():
        raise SystemExit("演示视频缺失，请先在项目根目录运行 python tools/prepare_demo.py")
    duration = probe_duration_ms(path, settings.ffprobe_binary)
    with Session(get_engine()) as db, db.begin():
        for name in ("A", "B"):
            tenant_id = demo_id(f"tenant-{name}")
            if db.get(Tenant, tenant_id) is None:
                db.add(Tenant(id=tenant_id, name=f"租户 {name}"))
        db.flush()
        accounts = [
            ("admin", "平台管理员", "admin", None),
            ("a1", "标注员 A1", "annotator", demo_id("tenant-A")),
            ("a2", "标注员 A2", "annotator", demo_id("tenant-A")),
            ("b1", "标注员 B1", "annotator", demo_id("tenant-B")),
        ]
        for username, display_name, role, tenant_id in accounts:
            account_id = demo_id(f"user-{username}")
            existing = db.scalar(select(User).where(User.username == username))
            if existing and existing.id != account_id:
                raise RuntimeError(f"账号名 {username} 已被非演示账号使用；未修改已有数据")
            if db.get(User, account_id) is None:
                db.add(User(id=account_id, username=username, display_name=display_name, role=role,
                            tenant_id=tenant_id, password_hash=hash_password(password), is_active=True))
        db.flush()
        fixtures = [
            ("A-01", "A", "available", None),
            ("A-02", "A", "available", None),
            ("A-03", "A", "available", None),
            ("A-04", "A", "in_progress", "a1"),
            ("A-05", "A", "in_progress", "a2"),
            ("B-01", "B", "available", None),
            ("B-02", "B", "in_progress", "b1"),
        ]
        for label, tenant, status, owner in fixtures:
            task_id = demo_id(f"task-{label}")
            if db.get(Task, task_id) is None:
                db.add(Task(
                    id=task_id, title=f"Push-T 推方块示教 · {label}",
                    tenant_id=demo_id(f"tenant-{tenant}"), video_key="pusht-demo.mp4",
                    duration_ms=duration, status=status,
                    assignee_id=demo_id(f"user-{owner}") if owner else None,
                ))
    print("演示数据已就绪：2 个租户、4 个账号、7 个任务；已有数据和密码保持不变。")
    print("账号：admin / a1 / a2 / b1；初次密码见项目 .env 的 APP_DEMO_PASSWORD。")


if __name__ == "__main__":
    main()
