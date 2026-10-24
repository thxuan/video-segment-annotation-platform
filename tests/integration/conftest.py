"""Real committed fixtures: each HTTP request gets its own PostgreSQL connection."""
from datetime import datetime, timezone
import os
from types import SimpleNamespace
from uuid import uuid4

import pytest

ENABLED = os.environ.get("RUN_AUTOMATION_DB_TESTS") == "1"
if ENABLED:
    from tools.automation_environment import configure
    configure()  # Guard target before app settings/engine can be initialized.

from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select, text
from sqlalchemy.orm import Session
from app.main import app
from app.models import LoginSession, Segment, Task, Tenant, User
from app.security import hash_password


@pytest.fixture(scope="session")
def integration_engine():
    if not ENABLED:
        pytest.skip("Run tools/run_automation.py to enable the isolated PostgreSQL suite")
    from tools.automation_environment import DATABASE, migrate
    from app.config import get_settings
    from app.db import get_engine
    # Other collected tests may have cached settings; always rebind to guarded env.
    get_settings.cache_clear()
    get_engine.cache_clear()
    migrate()
    engine = get_engine()

    @event.listens_for(engine, "connect")
    def bound_database_waits(connection, record):
        with connection.cursor() as cursor:
            cursor.execute("SET statement_timeout='12000ms'")
            cursor.execute("SET lock_timeout='10000ms'")
        connection.commit()

    with engine.connect() as db:
        assert db.scalar(text("select current_database()")) == DATABASE
    yield engine
    engine.dispose()


@pytest.fixture
def world(integration_engine):
    engine = integration_engine
    prefix = uuid4().hex[:12]
    tenants = {key: uuid4() for key in ("a", "b")}
    users = {key: uuid4() for key in ("admin", "a1", "a2", "b1")}
    password = "isolated-" + uuid4().hex
    shared_hash = hash_password(password)
    clients = []
    with Session(engine) as db, db.begin():
        db.add_all(Tenant(id=id, name=f"{prefix}-{key}") for key, id in tenants.items())
        db.flush()
        db.add_all(User(id=id, username=f"{prefix}-{key}", display_name=key,
                       role="admin" if key == "admin" else "annotator",
                       tenant_id=None if key == "admin" else tenants[key[0]],
                       password_hash=shared_hash) for key, id in users.items())

    def task(status="available", owner=None, tenant="a", pairs=()):
        id = uuid4()
        with Session(engine) as db, db.begin():
            db.add(Task(id=id, title=f"{prefix}-task", tenant_id=tenants[tenant],
                        assignee_id=users[owner] if owner else None,
                        video_key="pusht-demo.mp4", duration_ms=120000, status=status, revision=0,
                        submitted_at=datetime.now(timezone.utc) if status == "submitted" else None))
            db.flush()
            db.add_all(Segment(task_id=id, start_ms=s, end_ms=e) for s, e in pairs)
        return id

    def client(user=None):
        instance = TestClient(app, raise_server_exceptions=False)
        clients.append(instance)
        headers = {}
        if user:
            login = instance.post("/api/auth/login", json={"username": f"{prefix}-{user}", "password": password})
            assert login.status_code == 200
            headers["X-CSRF-Token"] = login.json()["csrf_token"]
        return instance, headers

    def snapshot(id):
        with Session(engine) as db:
            row = db.get(Task, id)
            return (row.status, row.assignee_id, row.revision, row.submitted_at,
                    db.execute(select(Segment.start_ms, Segment.end_ms)
                               .where(Segment.task_id == id).order_by(Segment.start_ms)).all())

    try:
        yield SimpleNamespace(engine=engine, task=task, client=client, snapshot=snapshot,
                              tenants=tenants, users=users, prefix=prefix, password=password)
    finally:
        for instance in clients:
            instance.close()
        with Session(engine) as db, db.begin():
            # Includes tasks created by the real upload endpoint in this fixture's tenants.
            ids = select(Task.id).where(Task.tenant_id.in_(tenants.values()))
            db.execute(delete(Segment).where(Segment.task_id.in_(ids)))
            db.execute(delete(Task).where(Task.tenant_id.in_(tenants.values())))
            db.execute(delete(LoginSession).where(LoginSession.user_id.in_(users.values())))
            db.execute(delete(User).where(User.id.in_(users.values())))
            db.execute(delete(Tenant).where(Tenant.id.in_(tenants.values())))
