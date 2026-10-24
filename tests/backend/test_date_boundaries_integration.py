"""Opt-in real PostgreSQL/API date checks, using only the dedicated test container."""
from datetime import date, datetime, timedelta, timezone
import os
from pathlib import Path
import secrets
import subprocess
import sys
from uuid import uuid4

import pytest
from dotenv import dotenv_values
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.db import get_db
from app.main import app
from app.models import Segment, Task, Tenant, User
from app.security import hash_password


ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / ".cache" / "date-tests.env"
pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_DATE_DB_TESTS") != "1" and os.environ.get("RUN_AUTOMATION_DB_TESTS") != "1",
    reason="Opt in with RUN_DATE_DB_TESTS=1 after starting compose.date-tests.yaml",
)


@pytest.fixture(scope="module")
def engine():
    automation = os.environ.get("RUN_AUTOMATION_DB_TESTS") == "1"
    if automation:
        from tools.automation_environment import guarded_url, DATABASE
        raw_url = guarded_url()
        expected_database = DATABASE
    else:
        raw_url = dotenv_values(CONFIG).get("APP_DATE_TEST_DATABASE_URL")
        expected_database = "annotation_date_tests"
    if not raw_url:
        pytest.fail("Run tools/prepare_date_tests.py and start compose.date-tests.yaml first")
    url = make_url(raw_url)
    # Refuse arbitrary/acceptance targets even if this ignored file is edited.
    if not automation and (url.query or (url.drivername, url.host, url.port, url.database, url.username) != (
        "postgresql+psycopg", "127.0.0.1", 55434,
        "annotation_date_tests", "annotation_date_tests",
    )):
        pytest.fail("Refusing database outside the dedicated date-test container")
    migration_env = os.environ.copy()
    migration_env["APP_DATABASE_URL"] = raw_url
    migrated = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=ROOT / "src" / "backend", env=migration_env,
        capture_output=True, text=True, timeout=60,
    )
    if migrated.returncode:
        # Do not echo a connection URL/password from a driver traceback.
        pytest.fail("Isolated database migration failed; verify test container health")
    instance = create_engine(url, hide_parameters=True, connect_args={"connect_timeout": 5})
    with instance.connect() as connection:
        assert connection.scalar(text("select current_database()")) == expected_database
        from alembic.config import Config
        from alembic.script import ScriptDirectory
        config = Config(str(ROOT / "src/backend/alembic.ini"))
        config.set_main_option("script_location", str(ROOT / "src/backend/migrations"))
        assert connection.scalar(text("select version_num from alembic_version")) == ScriptDirectory.from_config(config).get_current_head()
    yield instance
    instance.dispose()


@pytest.fixture
def sandbox(engine):
    connection = engine.connect()
    transaction = connection.begin()
    password = secrets.token_urlsafe(24)
    tenant_a, tenant_b = uuid4(), uuid4()
    admin_id, user_a, user_b = uuid4(), uuid4(), uuid4()
    password_hash = hash_password(password)

    def session():
        return Session(bind=connection, join_transaction_mode="create_savepoint")

    with session() as db:
        db.add_all([Tenant(id=tenant_a, name="日期测试 A"), Tenant(id=tenant_b, name="日期测试 B")])
        db.flush()
        db.add_all([
            User(id=admin_id, username="date_admin", display_name="日期管理员",
                 role="admin", password_hash=password_hash),
            User(id=user_a, username="date_a1", display_name="日期标注员 A",
                 role="annotator", tenant_id=tenant_a, password_hash=password_hash),
            User(id=user_b, username="date_b1", display_name="日期标注员 B",
                 role="annotator", tenant_id=tenant_b, password_hash=password_hash),
        ])
        db.commit()

    def isolated_db():
        with session() as db:
            yield db

    previous = dict(app.dependency_overrides)
    app.dependency_overrides[get_db] = isolated_db
    client = TestClient(app)
    result = client.post("/api/auth/login", json={"username": "date_admin", "password": password})
    assert result.status_code == 200

    def add_task(title, submitted, milliseconds, *, tenant=tenant_a, user=user_a,
                 created="2026-10-01T00:00:00Z", segments=None):
        task_id = uuid4()
        pairs = segments if segments is not None else [(0, milliseconds)]
        with session() as db:
            db.add(Task(
                id=task_id, title=title, tenant_id=tenant, assignee_id=user,
                video_key="date-test-no-video.mp4", duration_ms=120000,
                status="submitted" if submitted else "in_progress", revision=1,
                created_at=datetime.fromisoformat(created),
                submitted_at=datetime.fromisoformat(submitted) if submitted else None,
            ))
            db.flush()
            db.add_all([Segment(task_id=task_id, start_ms=start, end_ms=end) for start, end in pairs])
            db.commit()
        return task_id

    def daily(start, end=None, tenant=tenant_a):
        params = {"start_date": start, "end_date": end or start}
        if tenant is not None:
            params["tenant_id"] = str(tenant)
        response = client.get("/api/stats/daily", params=params)
        assert response.status_code == 200, response.text
        return response.json()

    def details(day, *, tenant=tenant_a, user=user_a):
        response = client.get("/api/stats/tasks", params={
            "day": day, "tenant_id": str(tenant), "user_id": str(user),
        })
        assert response.status_code == 200, response.text
        return response.json()

    try:
        yield {
            "client": client, "connection": connection, "password": password,
            "tenant_a": tenant_a, "tenant_b": tenant_b,
            "user_a": user_a, "user_b": user_b,
            "add": add_task, "daily": daily, "details": details,
        }
    finally:
        client.close()
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)
        transaction.rollback()
        connection.close()


@pytest.mark.parametrize("day,before,start,last,end", [
    ("2026-10-23", "2026-10-22T15:59:59.999999Z", "2026-10-22T16:00:00Z",
     "2026-10-23T15:59:59.999999Z", "2026-10-23T16:00:00Z"),
    ("2026-11-01", "2026-10-31T15:59:59.999999Z", "2026-10-31T16:00:00Z",
     "2026-11-01T15:59:59.999999Z", "2026-11-01T16:00:00Z"),
    ("2027-01-01", "2026-12-31T15:59:59.999999Z", "2026-12-31T16:00:00Z",
     "2027-01-01T15:59:59.999999Z", "2027-01-01T16:00:00Z"),
    ("2028-02-29", "2028-02-28T15:59:59.999999Z", "2028-02-28T16:00:00Z",
     "2028-02-29T15:59:59.999999Z", "2028-02-29T16:00:00Z"),
    ("2028-03-01", "2028-02-29T15:59:59.999999Z", "2028-02-29T16:00:00Z",
     "2028-03-01T15:59:59.999999Z", "2028-03-01T16:00:00Z"),
])
def test_midnight_month_year_and_leap_day(sandbox, day, before, start, last, end):
    s = sandbox
    s["add"]("前一天最后一微秒", before, 1000)
    first_id = s["add"]("当天零点", start, 2000)
    last_id = s["add"]("当天最后一微秒", last, 3000)
    s["add"]("次日零点", end, 4000)
    report = s["daily"](day)
    assert (report["effective_ms"], report["task_count"]) == (5000, 2)
    assert report["timezone"] == "Asia/Shanghai"
    assert {row["date"] for row in report["items"]} == {day}
    detail = s["details"](day)
    assert detail["total"] == 2
    assert {row["id"] for row in detail["items"]} == {str(first_id), str(last_id)}
    selected = date.fromisoformat(day)
    assert s["daily"]((selected - timedelta(days=1)).isoformat())["effective_ms"] == 1000
    assert s["daily"]((selected + timedelta(days=1)).isoformat())["effective_ms"] == 4000


def test_date_range_includes_both_days_and_excludes_next_midnight(sandbox):
    s = sandbox
    s["add"]("22日两段", "2026-10-22T15:59:59.999Z", 10000,
             segments=[(0, 4000), (5000, 11000)])
    s["add"]("23日零点", "2026-10-22T16:00:00Z", 20000)
    s["add"]("24日零点", "2026-10-23T16:00:00Z", 40000)
    report = s["daily"]("2026-10-22", "2026-10-23")
    assert (report["effective_ms"], report["task_count"]) == (30000, 2)
    assert {(r["date"], r["effective_ms"], r["task_count"]) for r in report["items"]} == {
        ("2026-10-22", 10000, 1), ("2026-10-23", 20000, 1),
    }
    assert sum(r["effective_ms"] for r in report["items"]) == report["effective_ms"]


def test_drafts_creation_date_tenant_filter_and_empty_day(sandbox):
    s = sandbox
    submitted = s["add"]("早创建晚提交", "2026-10-22T16:00:00Z", 65000)
    s["add"]("不计入的草稿", None, 80000)
    s["add"]("租户B", "2026-10-22T16:00:00Z", 7000,
             tenant=s["tenant_b"], user=s["user_b"])
    a = s["daily"]("2026-10-23")
    b = s["daily"]("2026-10-23", tenant=s["tenant_b"])
    all_tenants = s["daily"]("2026-10-23", tenant=None)
    assert (a["effective_ms"], a["task_count"]) == (65000, 1)
    assert (b["effective_ms"], b["task_count"]) == (7000, 1)
    assert (all_tenants["effective_ms"], all_tenants["task_count"]) == (72000, 2)
    assert {r["id"] for r in s["details"]("2026-10-23")["items"]} == {str(submitted)}
    # Creation on Oct 1 must not put the submitted task into Oct 1 statistics.
    empty = s["daily"]("2026-10-01")
    assert (empty["effective_ms"], empty["task_count"], empty["items"]) == (0, 0, [])
    assert s["details"]("2026-10-01")["total"] == 0


@pytest.mark.parametrize("db_timezone", ["UTC", "America/Los_Angeles", "Asia/Tokyo"])
def test_database_timezone_does_not_change_business_day(sandbox, db_timezone):
    s = sandbox
    # Parameterized set_config avoids interpolating SQL identifiers/values.
    s["connection"].execute(
        text("select set_config('TimeZone', :zone, true)"), {"zone": db_timezone},
    )
    s["add"]("UTC仍是22日但北京时间23日", "2026-10-22T16:00:00Z", 20000)
    assert s["daily"]("2026-10-22")["task_count"] == 0
    report = s["daily"]("2026-10-23")
    assert (report["effective_ms"], report["task_count"]) == (20000, 1)
    assert report["items"][0]["date"] == "2026-10-23"


def test_draft_saved_before_midnight_submitted_after_midnight(sandbox, monkeypatch):
    from app import workflow

    s = sandbox
    task_id = s["add"]("跨日草稿", None, 1000)
    admin = s["client"]
    with TestClient(app) as annotator:
        login = annotator.post("/api/auth/login", json={
            "username": "date_a1", "password": s["password"],
        })
        assert login.status_code == 200
        headers = {"X-CSRF-Token": login.json()["csrf_token"]}

        class ControlledClock:
            instant = datetime.fromisoformat("2026-10-22T15:59:59.999Z")

            @classmethod
            def now(cls, tz=None):
                return cls.instant.astimezone(tz or timezone.utc)

        # Only this in-process workflow sees a controlled clock; OS/auth clocks stay real.
        monkeypatch.setattr(workflow, "datetime", ControlledClock)
        payload = {"expected_revision": 1, "segments": [{"start_ms": 10000, "end_ms": 30000}]}
        saved = annotator.put(f"/api/tasks/{task_id}/segments", json=payload, headers=headers)
        assert saved.status_code == 200, saved.text
        assert saved.json()["submitted_at"] is None
        assert s["daily"]("2026-10-22")["task_count"] == 0
        assert s["daily"]("2026-10-23")["task_count"] == 0

        ControlledClock.instant = datetime.fromisoformat("2026-10-22T16:00:00Z")
        payload["expected_revision"] = saved.json()["revision"]
        submitted = annotator.post(f"/api/tasks/{task_id}/submit", json=payload, headers=headers)
        assert submitted.status_code == 200, submitted.text
        first = submitted.json()
        assert datetime.fromisoformat(first["submitted_at"]) == ControlledClock.instant
        assert s["daily"]("2026-10-22")["task_count"] == 0
        assert (s["daily"]("2026-10-23")["effective_ms"],
                s["daily"]("2026-10-23")["task_count"]) == (20000, 1)

        # A retry on the following business day must keep the original attribution.
        ControlledClock.instant = datetime.fromisoformat("2026-10-23T16:00:00Z")
        retried = annotator.post(f"/api/tasks/{task_id}/submit", json=payload, headers=headers)
        assert retried.status_code == 200
        assert retried.json()["submitted_at"] == first["submitted_at"]
        assert retried.json()["revision"] == first["revision"]
        assert s["daily"]("2026-10-23")["task_count"] == 1
        assert s["daily"]("2026-10-24")["task_count"] == 0
    assert admin.get("/api/auth/me").json()["user"]["username"] == "date_admin"


@pytest.mark.parametrize("start,end", [
    ("2026-10-23", "2026-10-22"),
    ("2025-01-01", "2026-01-02"),
    ("9999-01-01", "9999-01-01"),
])
def test_invalid_statistics_ranges_rejected_by_api(sandbox, start, end):
    response = sandbox["client"].get("/api/stats/daily", params={
        "start_date": start, "end_date": end,
    })
    assert response.status_code == 422
