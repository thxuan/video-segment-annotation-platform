from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID, uuid4
import subprocess

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import delete, select
from starlette.concurrency import run_in_threadpool

from app.auth import AuthContext, Db, require_csrf
from app.config import get_settings
from app.media import probe_duration_ms, resolve_video_path
from app.models import Segment, Task, Tenant
from app.rules import canonical_segments
from app.schemas import AnnotationInput, TaskDetail
from app.tasks import serialize_detail

router = APIRouter(tags=["workflow"])
WriteAuth = Annotated[AuthContext, Depends(require_csrf)]


def annotator(auth: AuthContext):
    if auth.user.role != "annotator":
        raise HTTPException(403, "仅标注员可以领取和标注任务")


def locked_task(task_id: UUID, auth: AuthContext, db) -> Task:
    # Lock acquisition precedes state/revision checks for every task mutation.
    task = db.scalar(select(Task).where(
        Task.id == task_id, Task.tenant_id == auth.user.tenant_id
    ).with_for_update())
    if task is None:
        raise HTTPException(404, "任务不存在或无权访问")
    return task


@router.post("/tasks/{task_id}/claim", response_model=TaskDetail)
def claim(task_id: UUID, auth: WriteAuth, db: Db):
    annotator(auth)
    task = locked_task(task_id, auth, db)
    if task.status != "available":
        raise HTTPException(409, "任务已被领取，请刷新任务列表")
    task.assignee_id = auth.user.id
    task.status = "in_progress"
    task.revision += 1
    db.flush()
    result = serialize_detail(task, db)
    db.commit()
    return result


def write_annotations(task_id: UUID, body: AnnotationInput, auth: AuthContext, db, *, submit: bool):
    annotator(auth)
    task = locked_task(task_id, auth, db)
    if task.assignee_id != auth.user.id:
        raise HTTPException(404, "任务不存在或无权访问")
    try:
        intervals = canonical_segments(body.segments, task.duration_ms, submit=submit)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    if task.status == "submitted":
        current = serialize_detail(task, db)
        # A lost response may be retried with the original revision and payload.
        if submit and intervals == [(s.start_ms, s.end_ms) for s in current.segments]:
            return current
        raise HTTPException(409, "任务已提交，不可修改片段")
    if task.status != "in_progress":
        raise HTTPException(409, "请先领取任务")
    if task.revision != body.expected_revision:
        raise HTTPException(409, "任务已在其他页面更新；请先重新载入，再确认片段")
    db.execute(delete(Segment).where(Segment.task_id == task.id))
    db.add_all([Segment(task_id=task.id, start_ms=start, end_ms=end) for start, end in intervals])
    task.revision += 1
    if submit:
        task.status = "submitted"
        task.submitted_at = datetime.now(timezone.utc)
    db.flush()
    result = serialize_detail(task, db)
    db.commit()
    return result


@router.put("/tasks/{task_id}/segments", response_model=TaskDetail)
def save_segments(task_id: UUID, body: AnnotationInput, auth: WriteAuth, db: Db):
    return write_annotations(task_id, body, auth, db, submit=False)


@router.post("/tasks/{task_id}/submit", response_model=TaskDetail)
def submit_task(task_id: UUID, body: AnnotationInput, auth: WriteAuth, db: Db):
    return write_annotations(task_id, body, auth, db, submit=True)


@router.post("/tasks", response_model=TaskDetail, status_code=201, openapi_extra={
    "requestBody": {"required": True, "content": {"video/mp4": {"schema": {"type": "string", "format": "binary"}}}}
})
async def publish_task(
    request: Request, auth: WriteAuth, db: Db,
    tenant_id: UUID, title: Annotated[str, Query(min_length=1, max_length=200)],
):
    if auth.user.role != "admin":
        raise HTTPException(403, "需要管理员权限")
    title = title.strip()
    if not title:
        raise HTTPException(422, "请输入任务标题")
    if db.get(Tenant, tenant_id) is None:
        raise HTTPException(422, "请选择有效租户")
    settings = get_settings()
    maximum = settings.max_upload_mb * 1024 * 1024
    try:
        content_length = int(request.headers.get("content-length", "0"))
    except ValueError:
        raise HTTPException(400, "无效的文件长度")
    if content_length > maximum:
        raise HTTPException(413, f"视频不能超过 {settings.max_upload_mb} MB")
    root = settings.resolved_video_dir
    root.mkdir(parents=True, exist_ok=True)
    key = f"{uuid4().hex}.mp4"
    destination = resolve_video_path(root, key)
    temporary = destination.with_suffix(".part")
    commit_started = False
    try:
        size = 0
        with temporary.open("xb") as output:
            async for chunk in request.stream():
                size += len(chunk)
                if size > maximum:
                    raise HTTPException(413, f"视频不能超过 {settings.max_upload_mb} MB")
                output.write(chunk)
        if size == 0 or (content_length and size != content_length):
            raise HTTPException(422, "视频为空或上传不完整")
        with temporary.open("rb") as source:
            if b"ftyp" not in source.read(32):
                raise HTTPException(422, "请选择有效的 MP4 视频")
        try:
            duration = await run_in_threadpool(probe_duration_ms, temporary, settings.ffprobe_binary)
        except FileNotFoundError as exc:
            raise HTTPException(503, "视频校验服务不可用，请联系管理员") from exc
        except (ValueError, KeyError, subprocess.SubprocessError) as exc:
            raise HTTPException(422, "无法读取视频，请选择完整且编码受支持的 MP4 文件") from exc
        temporary.replace(destination)
        task = Task(title=title, tenant_id=tenant_id, video_key=key, duration_ms=duration, status="available")
        db.add(task)
        db.flush()
        result = serialize_detail(task, db)
        # If commit acknowledgement is lost, keep the finalized file: deleting it
        # could break a transaction that PostgreSQL has actually committed.
        commit_started = True
        db.commit()
        return result
    finally:
        temporary.unlink(missing_ok=True)
        if not commit_started:
            destination.unlink(missing_ok=True)
