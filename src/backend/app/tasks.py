from typing import Annotated
import subprocess
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy import and_, case, func, or_, select, true

from app.auth import CurrentSession, Db, require_admin
from app.config import get_settings
from app.media import probe_frame_times_ms, resolve_video_path
from app.models import Segment, Task, Tenant, User
from app.schemas import SegmentInput, TaskDetail, TaskPage, TaskRead, TaskStatus, TenantRead

router = APIRouter(tags=["tasks"])


def visibility(user: User):
    if user.role == "admin":
        return true()
    if user.role != "annotator" or user.tenant_id is None:
        return Task.id.is_(None)
    return and_(
        Task.tenant_id == user.tenant_id,
        or_(Task.status == "available", Task.assignee_id == user.id),
    )


def serialize_task(task: Task, db) -> TaskRead:
    tenant = db.get(Tenant, task.tenant_id)
    assignee = db.get(User, task.assignee_id) if task.assignee_id else None
    return TaskRead(
        id=task.id, title=task.title, tenant_id=task.tenant_id, tenant_name=tenant.name,
        duration_ms=task.duration_ms, status=task.status,
        assignee_id=task.assignee_id, assignee_name=assignee.display_name if assignee else None,
        created_at=task.created_at, submitted_at=task.submitted_at, revision=task.revision,
    )


def find_visible_task(task_id: UUID, user: User, db) -> Task:
    task = db.scalar(select(Task).where(Task.id == task_id, visibility(user)))
    if task is None:
        raise HTTPException(404, "任务不存在或无权访问")
    return task


@router.get("/tenants", response_model=list[TenantRead])
def tenants(db: Db, admin: Annotated[User, Depends(require_admin)]):
    return [TenantRead(id=tenant.id, name=tenant.name) for tenant in db.scalars(select(Tenant).order_by(Tenant.name))]


@router.get("/tasks", response_model=TaskPage)
def tasks(
    auth: CurrentSession, db: Db,
    status: TaskStatus | None = None, tenant_id: UUID | None = None,
    page: Annotated[int, Query(ge=1, le=100_000)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
):
    if tenant_id is not None and auth.user.role != "admin":
        raise HTTPException(403, "仅管理员可以指定租户筛选")
    conditions = [visibility(auth.user)]
    if status is not None:
        conditions.append(Task.status == status)
    if tenant_id is not None:
        conditions.append(Task.tenant_id == tenant_id)
    total = db.scalar(select(func.count()).select_from(Task).where(*conditions)) or 0
    status_order = case({"available": 0, "in_progress": 1, "submitted": 2}, value=Task.status, else_=3)
    rows = db.scalars(select(Task).where(*conditions).order_by(status_order, Task.created_at.desc(), Task.id).offset((page - 1) * page_size).limit(page_size))
    return TaskPage(items=[serialize_task(task, db) for task in rows], total=total, page=page, page_size=page_size)


def serialize_detail(task: Task, db) -> TaskDetail:
    segments = [SegmentInput(start_ms=s.start_ms, end_ms=s.end_ms) for s in db.scalars(
        select(Segment).where(Segment.task_id == task.id).order_by(Segment.start_ms)
    )]
    return TaskDetail(**serialize_task(task, db).model_dump(), segments=segments,
                      effective_ms=sum(s.end_ms - s.start_ms for s in segments))


@router.get("/tasks/{task_id}", response_model=TaskDetail)
def task_detail(task_id: UUID, auth: CurrentSession, db: Db):
    return serialize_detail(find_visible_task(task_id, auth.user, db), db)


@router.get("/tasks/{task_id}/frames")
def task_frames(task_id: UUID, auth: CurrentSession, db: Db):
    task = find_visible_task(task_id, auth.user, db)
    settings = get_settings()
    try:
        path = resolve_video_path(settings.resolved_video_dir, task.video_key)
        frames = probe_frame_times_ms(path, settings.ffprobe_binary, task.duration_ms)
    except FileNotFoundError:
        raise HTTPException(404, "视频文件或帧分析工具缺失") from None
    except (ValueError, OSError, subprocess.SubprocessError):
        raise HTTPException(503, "暂时无法读取视频帧，请重试；仍可用播放器和秒数输入定位") from None
    return {"frame_times_ms": frames}


@router.get("/tasks/{task_id}/video")
def task_video(task_id: UUID, auth: CurrentSession, db: Db):
    task = find_visible_task(task_id, auth.user, db)
    try:
        path = resolve_video_path(get_settings().resolved_video_dir, task.video_key)
    except ValueError:
        raise HTTPException(404, "视频不可用") from None
    if not path.is_file():
        raise HTTPException(404, "视频文件缺失，请联系管理员")
    return FileResponse(path, media_type="video/mp4", headers={"Cache-Control": "no-store"})
