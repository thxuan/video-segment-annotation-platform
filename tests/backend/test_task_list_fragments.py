"""Exercise task-list ordering and pagination with an isolated in-memory SQLite DB."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base, Task, Tenant, User
from app.tasks import tasks


@pytest.fixture
def task_list():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine, tables=[Tenant.__table__, User.__table__, Task.__table__])
    with Session(engine) as db:
        tenant = Tenant(id=uuid4(), name="local fragment tenant")
        owner = User(id=uuid4(), tenant_id=tenant.id, username="owner", display_name="owner",
                     role="annotator", password_hash="unused")
        db.add_all([tenant, owner])
        db.flush()
        origin = datetime(2026, 10, 23, tzinfo=timezone.utc)

        def add_task(number, status, age, tenant_id=tenant.id, assignee_id=owner.id):
            task = Task(id=UUID(int=number), title=f"local task {number}", tenant_id=tenant_id,
                        video_key="unused.mp4", duration_ms=1000, status=status,
                        assignee_id=None if status == "available" else assignee_id,
                        created_at=origin + timedelta(seconds=age),
                        submitted_at=origin if status == "submitted" else None, revision=0)
            db.add(task)
            return task

        for number, status, age in [(1, "submitted", 6), (2, "available", 4),
                                     (3, "in_progress", 5), (4, "available", 4),
                                     (5, "in_progress", 3), (6, "submitted", 2)]:
            add_task(number, status, age)
        db.commit()
        yield db, owner, add_task
    engine.dispose()


@pytest.mark.parametrize("role", ["admin", "annotator"])
def test_status_order_precedes_pagination_with_stable_time_and_id_ties(task_list, role):
    db, owner, _ = task_list
    user = owner if role == "annotator" else SimpleNamespace(role="admin")
    pages = [tasks(SimpleNamespace(user=user), db, page=page, page_size=2) for page in (1, 2, 3)]
    assert all(page.total == 6 and page.page_size == 2 for page in pages)
    assert [page.page for page in pages] == [1, 2, 3]
    assert [item.id.int for page in pages for item in page.items] == [2, 4, 3, 5, 1, 6]
    assert [[item.status for item in page.items] for page in pages] == [
        ["available", "available"], ["in_progress", "in_progress"], ["submitted", "submitted"]]


@pytest.mark.parametrize("status,expected", [
    ("available", [2, 4]), ("in_progress", [3, 5]), ("submitted", [1, 6])])
def test_status_filter_keeps_newest_first_with_stable_pagination(task_list, status, expected):
    db, owner, _ = task_list
    pages = [tasks(SimpleNamespace(user=owner), db, status=status, page=page, page_size=1)
             for page in (1, 2)]
    assert [item.id.int for page in pages for item in page.items] == expected
    assert all(page.total == 2 for page in pages)


def test_ordering_keeps_tenant_and_assignee_visibility(task_list):
    db, owner, add_task = task_list
    other_tenant = Tenant(id=uuid4(), name="other local tenant")
    other_user = User(id=uuid4(), tenant_id=owner.tenant_id, username="other", display_name="other",
                      role="annotator", password_hash="unused")
    db.add_all([other_tenant, other_user])
    db.flush()
    add_task(7, "available", 100, tenant_id=other_tenant.id)
    add_task(8, "in_progress", 100, assignee_id=other_user.id)
    db.commit()
    result = tasks(SimpleNamespace(user=owner), db, page=1, page_size=100)
    assert result.total == 6
    assert [item.id.int for item in result.items] == [2, 4, 3, 5, 1, 6]
