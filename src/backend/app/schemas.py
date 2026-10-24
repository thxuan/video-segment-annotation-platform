from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictInt

TaskStatus = Literal["available", "in_progress", "submitted"]
AnnotatedMs = Annotated[StrictInt, Field(ge=0, le=2_147_483_647)]


class LoginInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class UserRead(BaseModel):
    id: UUID
    username: str
    display_name: str
    role: Literal["admin", "annotator"]
    tenant_id: UUID | None
    tenant_name: str | None


class SessionRead(BaseModel):
    user: UserRead
    csrf_token: str


class TaskRead(BaseModel):
    id: UUID
    title: str
    tenant_id: UUID
    tenant_name: str
    duration_ms: int
    status: TaskStatus
    assignee_id: UUID | None
    assignee_name: str | None
    created_at: datetime
    submitted_at: datetime | None
    revision: int


class SegmentInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start_ms: AnnotatedMs
    end_ms: AnnotatedMs


class AnnotationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: StrictInt = Field(ge=0)
    segments: list[SegmentInput] = Field(max_length=1000)


class TaskDetail(TaskRead):
    segments: list[SegmentInput]
    effective_ms: int


class TaskPage(BaseModel):
    items: list[TaskRead]
    total: int
    page: int
    page_size: int


class TenantRead(BaseModel):
    id: UUID
    name: str
