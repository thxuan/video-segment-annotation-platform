"""Isolated aggregation checks; SQLite adapts only the PostgreSQL business-date expression."""
from datetime import date, datetime
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import Date, create_engine, func, text, type_coerce
from sqlalchemy.orm import Session
from sqlalchemy.sql import visitors
from sqlalchemy.sql.elements import Cast

from app.models import Base, Segment, Task, Tenant, User
from app.stats import personal, personal_report, personal_statement


def test_personal_aggregation_counts_tasks_once_and_excludes_drafts_other_users_and_tenants():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine, tables=[Tenant.__table__, User.__table__, Task.__table__])
    # PostgreSQL exclusion constraints are irrelevant to this read-only aggregation test.
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE segments (id CHAR(32) PRIMARY KEY, task_id CHAR(32), start_ms INTEGER, end_ms INTEGER)"))
    with Session(engine) as db:
        tenant_id, other_tenant, owner_id, other_id = [uuid4() for _ in range(4)]
        owner = SimpleNamespace(id=owner_id, tenant_id=tenant_id)

        def add(status, when, assignee=owner_id, tenant=tenant_id, intervals=((0, 1000),)):
            task = Task(id=uuid4(), title="isolated", video_key="unused", duration_ms=10000,
                        tenant_id=tenant, assignee_id=assignee, status=status, revision=1,
                        created_at=datetime(2025, 1, 1), submitted_at=when)
            db.add(task)
            db.flush()
            db.add_all(Segment(id=uuid4(), task_id=task.id, start_ms=start, end_ms=end) for start, end in intervals)

        add("submitted", datetime(2026, 10, 23, 15, 59, 59), intervals=((0, 1000), (2000, 4000)))
        add("submitted", datetime(2026, 10, 23, 16, 0, 0))
        add("submitted", datetime(2025, 1, 1))
        add("in_progress", None)
        add("submitted", datetime(2026, 10, 23), assignee=other_id)
        add("submitted", datetime(2026, 10, 23), tenant=other_tenant)
        db.commit()

        def sqlite_day(element):
            if isinstance(element, Cast) and getattr(element.clause, "name", None) == "timezone":
                return type_coerce(func.date(Task.submitted_at, "+8 hours"), Date)

        statement = visitors.replacement_traverse(personal_statement(owner), {}, sqlite_day)
        rows = db.execute(statement).mappings().all()
        report = personal_report(rows, date(2026, 10, 24))
        assert report["task_count"] == 3
        assert report["effective_ms"] == 5000
        assert report["today_count"] == 1
        assert report["active_days"] == 3
        assert report["year"] is None
        assert report["years"] == [2025]
        assert report["start_date"] == date(2025, 10, 25)
        assert report["end_date"] == date(2026, 10, 24)
        assert report["items"] == [
            {"date": date(2026, 10, 23), "task_count": 1, "effective_ms": 3000},
            {"date": date(2026, 10, 24), "task_count": 1, "effective_ms": 1000},
        ]
        assert report == personal_report(db.execute(statement).mappings().all(), date(2026, 10, 24))
        historical = personal_report(rows, date(2026, 10, 24), 2025)
        assert historical["items"] == [{"date": date(2025, 1, 1), "task_count": 1, "effective_ms": 1000}]
        for key in ["task_count", "effective_ms", "today_count", "active_days", "years"]:
            assert historical[key] == report[key]
    engine.dispose()


def test_empty_report_returns_real_zeroes_and_a_full_leap_year():
    report = personal_report([], date(2026, 10, 23), 2024)
    assert report["task_count"] == report["today_count"] == report["effective_ms"] == report["active_days"] == 0
    assert (report["end_date"] - report["start_date"]).days == 365
    assert report["as_of"] == date(2026, 10, 23)
    assert report["years"] == []
    assert report["items"] == []


def test_administrator_cannot_use_personal_endpoint():
    with pytest.raises(HTTPException) as exc:
        personal(SimpleNamespace(user=SimpleNamespace(role="admin")), None)
    assert exc.value.status_code == 403


def test_year_selection_includes_empty_gaps_and_does_not_change_lifetime_totals():
    rows = [
        {"date": date(2024, 12, 31), "task_count": 2, "effective_ms": 2000},
        {"date": date(2026, 1, 1), "task_count": 1, "effective_ms": 1000},
    ]
    report = personal_report(rows, date(2026, 10, 23), 2025)
    assert report["years"] == [2025, 2024]
    assert report["items"] == []
    assert report["task_count"] == 3 and report["effective_ms"] == 3000
    assert personal_report(rows, date(2026, 10, 23), 2024)["items"] == [rows[0]]


@pytest.mark.parametrize("year", [0, 2026, 2027])
def test_invalid_or_future_years_are_rejected(year):
    with pytest.raises(HTTPException) as exc:
        personal_report([], date(2026, 10, 23), year)
    assert exc.value.status_code == 422


@pytest.mark.parametrize("today,start", [
    (date(2026, 10, 23), date(2025, 10, 24)),
    (date(2026, 11, 23), date(2025, 11, 24)),
    (date(2027, 1, 1), date(2026, 1, 2)),
])
def test_recent_365_days_rolls_across_month_and_year_boundaries(today, start):
    rows = [{"date": day, "task_count": 1, "effective_ms": 1000}
            for day in [start.replace(year=start.year - 1), start, today]]
    report = personal_report(rows, today)
    assert report["start_date"] == start and report["end_date"] == today
    assert (report["end_date"] - report["start_date"]).days == 364
    assert report["items"] == rows[1:]
    assert report["task_count"] == 3
