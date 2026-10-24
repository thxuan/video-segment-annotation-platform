from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    Boolean, CheckConstraint, DateTime, ForeignKey, ForeignKeyConstraint,
    Index, Integer, MetaData, String, UniqueConstraint, Uuid, func, text,
)
from sqlalchemy.dialects.postgresql import ExcludeConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention={
        "ix": "ix_%(table_name)s_%(column_0_name)s",
        "uq": "uq_%(table_name)s_%(column_0_name)s",
        "ck": "ck_%(table_name)s_%(constraint_name)s",
        "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
        "pk": "pk_%(table_name)s",
    })


class Tenant(Base):
    __tablename__ = "tenants"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    name: Mapped[str] = mapped_column(String(100), unique=True)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("role IN ('admin', 'annotator')", name="valid_role"),
        CheckConstraint(
            "(role = 'admin' AND tenant_id IS NULL) OR "
            "(role = 'annotator' AND tenant_id IS NOT NULL)", name="role_tenant",
        ),
        UniqueConstraint("id", "tenant_id", name="uq_users_id_tenant"),
    )

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    display_name: Mapped[str] = mapped_column(String(100))
    role: Mapped[str] = mapped_column(String(20))
    tenant_id: Mapped[UUID | None] = mapped_column(ForeignKey("tenants.id"), index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class LoginSession(Base):
    __tablename__ = "login_sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    csrf_token: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (
        CheckConstraint("duration_ms > 0", name="positive_duration"),
        CheckConstraint("revision >= 0", name="positive_revision"),
        CheckConstraint(
            "(status = 'available' AND assignee_id IS NULL AND submitted_at IS NULL) OR "
            "(status = 'in_progress' AND assignee_id IS NOT NULL AND submitted_at IS NULL) OR "
            "(status = 'submitted' AND assignee_id IS NOT NULL AND submitted_at IS NOT NULL)",
            name="state_consistency",
        ),
        ForeignKeyConstraint(
            ["assignee_id", "tenant_id"], ["users.id", "users.tenant_id"],
            name="fk_tasks_assignee_tenant",
        ),
        Index("ix_tasks_tenant_status", "tenant_id", "status"),
    )

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    title: Mapped[str] = mapped_column(String(200))
    tenant_id: Mapped[UUID] = mapped_column(ForeignKey("tenants.id"))
    video_key: Mapped[str] = mapped_column(String(255))
    duration_ms: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="available")
    assignee_id: Mapped[UUID | None] = mapped_column(Uuid)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class Segment(Base):
    __tablename__ = "segments"
    __table_args__ = (
        CheckConstraint("start_ms >= 0 AND end_ms > start_ms", name="valid_interval"),
        Index("ix_segments_task_id", "task_id"),
        ExcludeConstraint(("task_id", "="), (text("int4range(start_ms, end_ms, '[)')"), "&&"),
                          name="ex_segments_no_overlap", using="gist"),
    )

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    task_id: Mapped[UUID] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"))
    start_ms: Mapped[int] = mapped_column(Integer)
    end_ms: Mapped[int] = mapped_column(Integer)
