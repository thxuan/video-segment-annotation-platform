from datetime import date, datetime, timedelta
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import Date, cast, func, select

from app.auth import CurrentSession, Db, require_admin
from app.models import Segment, Task, Tenant, User
from app.rules import BEIJING, utc_day_bounds
from app.tasks import serialize_task

router = APIRouter(prefix="/stats", tags=["statistics"])
Admin = Annotated[User, Depends(require_admin)]


def date_conditions(start_date, end_date, tenant_id):
    try:
        start, end = utc_day_bounds(start_date, end_date)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    conditions = [Task.status == "submitted", Task.submitted_at >= start, Task.submitted_at < end]
    if tenant_id is not None:
        conditions.append(Task.tenant_id == tenant_id)
    return conditions


def task_totals():
    return select(Segment.task_id, func.sum(Segment.end_ms - Segment.start_ms).label("effective_ms")).group_by(
        Segment.task_id
    ).subquery()


def personal_statement(user):
    totals = task_totals()
    day = cast(func.timezone("Asia/Shanghai", Task.submitted_at), Date)
    return select(
        day.label("date"), func.count(Task.id).label("task_count"),
        func.coalesce(func.sum(totals.c.effective_ms), 0).label("effective_ms"),
    ).select_from(Task).outerjoin(totals, totals.c.task_id == Task.id).where(
        Task.status == "submitted", Task.assignee_id == user.id,
        Task.tenant_id == user.tenant_id,
    ).group_by(day).order_by(day)


def personal_report(rows, today, year=None):
    if year is not None and not 1 <= year < today.year:
        raise HTTPException(422, "请选择已结束的历史年份")
    start, end = (today - timedelta(days=364), today) if year is None else (date(year, 1, 1), date(year, 12, 31))
    items = [{"date": row["date"], "task_count": int(row["task_count"]),
              "effective_ms": int(row["effective_ms"])} for row in rows]
    return {
        "timezone": "Asia/Shanghai", "start_date": start, "end_date": end,
        "year": year, "as_of": today,
        "years": list(range(today.year - 1, min([today.year] + [row["date"].year for row in items]) - 1, -1)),
        "task_count": sum(row["task_count"] for row in items),
        "effective_ms": sum(row["effective_ms"] for row in items),
        "today_count": sum(row["task_count"] for row in items if row["date"] == today),
        "active_days": sum(row["task_count"] > 0 for row in items),
        "items": [row for row in items if start <= row["date"] <= min(end, today)],
    }


@router.get("/me")
def personal(auth: CurrentSession, db: Db, year: Annotated[int | None, Query(ge=1, le=9998)] = None):
    if auth.user.role != "annotator":
        raise HTTPException(403, "个人统计仅供标注员使用")
    today = datetime.now(BEIJING).date()
    if year is not None and year >= today.year:
        raise HTTPException(422, "请选择已结束的历史年份")
    rows = db.execute(personal_statement(auth.user)).mappings().all()
    return personal_report(rows, today, year)


@router.get("/daily")
def daily(admin: Admin, db: Db, start_date: date, end_date: date, tenant_id: UUID | None = None):
    conditions = date_conditions(start_date, end_date, tenant_id)
    totals = task_totals()
    day = cast(func.timezone("Asia/Shanghai", Task.submitted_at), Date)
    rows = db.execute(select(
        day.label("date"), Tenant.id.label("tenant_id"), Tenant.name.label("tenant_name"),
        User.id.label("user_id"), User.display_name.label("user_name"),
        func.count(Task.id).label("task_count"), func.sum(totals.c.effective_ms).label("effective_ms"),
    ).join(totals, totals.c.task_id == Task.id).join(Tenant, Task.tenant_id == Tenant.id).join(
        User, Task.assignee_id == User.id
    ).where(*conditions).group_by(day, Tenant.id, Tenant.name, User.id, User.display_name).order_by(
        day.desc(), Tenant.name, User.display_name, User.id
    )).mappings().all()
    return {"timezone": "Asia/Shanghai", "start_date": start_date, "end_date": end_date,
            "effective_ms": sum(r["effective_ms"] for r in rows),
            "task_count": sum(r["task_count"] for r in rows), "items": [dict(r) for r in rows]}


@router.get("/tasks")
def details(admin: Admin, db: Db, day: date, tenant_id: UUID, user_id: UUID,
            page: Annotated[int, Query(ge=1, le=100_000)] = 1):
    conditions = date_conditions(day, day, tenant_id) + [Task.assignee_id == user_id]
    totals = task_totals()
    total = db.scalar(select(func.count()).select_from(Task).join(totals, totals.c.task_id == Task.id).where(*conditions))
    rows = db.execute(select(Task, totals.c.effective_ms).join(totals, totals.c.task_id == Task.id).where(
        *conditions
    ).order_by(Task.submitted_at.desc(), Task.id).offset((page - 1) * 20).limit(20)).all()
    return {"total": total, "page": page, "page_size": 20,
            "items": [{**serialize_task(task, db).model_dump(), "effective_ms": duration} for task, duration in rows]}
