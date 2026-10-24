from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import time

import pytest
from sqlalchemy import event, select, text
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from app.models import Segment, Task


def payload(end=2000, revision=0):
    return {"expected_revision": revision, "segments": [{"start_ms": 0, "end_ms": end}]}


def race(world, task, requests):
    """Hold the row until BOTH independent HTTP transactions are visibly waiting on it."""
    with world.engine.connect() as holder:
        transaction = holder.begin()
        pid = holder.scalar(text("select pg_backend_pid()"))
        holder.execute(select(Task).where(Task.id == task).with_for_update())
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(request) for request in requests]
            try:
                deadline = time.monotonic() + 5
                while True:
                    with world.engine.connect() as observer:
                        waiting = observer.scalar(text(
                            "select count(*) from pg_stat_activity "
                            "where datname=current_database() and :pid=ANY(pg_blocking_pids(pid))"
                        ), {"pid": pid})
                    # PostgreSQL may queue the second writer behind the first waiter;
                    # count all lock waits on this dedicated database as well.
                    with world.engine.connect() as observer:
                        queued = observer.scalar(text(
                            "select count(*) from pg_stat_activity where datname=current_database() "
                            "and wait_event_type='Lock' and query like '%FOR UPDATE%'"
                        ))
                    if waiting >= 1 and queued >= 2:
                        break
                    assert not any(f.done() for f in futures), "Request finished before row-lock competition"
                    assert time.monotonic() < deadline, "Did not observe two independent blocked writers"
                    time.sleep(0.025)
            finally:
                transaction.rollback()
            return [f.result(timeout=12) for f in futures]


def test_two_claimants_have_exactly_one_winner(world):
    task = world.task()
    actors = [world.client(name) for name in ("a1", "a2")]
    responses = race(world, task, [lambda c=c, h=h: c.post(f"/api/tasks/{task}/claim", headers=h)
                                   for c, h in actors])
    assert sorted(r.status_code for r in responses) == [200, 409]
    winner = responses.index(next(r for r in responses if r.status_code == 200))
    state = world.snapshot(task)
    assert state[:3] == ("in_progress", world.users[("a1", "a2")[winner]], 1)
    assert state[3:] == (None, [])


def test_two_saves_at_same_revision_cannot_overwrite_each_other(world):
    task = world.task("in_progress", "a1", pairs=[(0, 1000)])
    actors = [world.client("a1"), world.client("a1")]
    responses = race(world, task, [lambda c=c, h=h, end=end: c.put(
        f"/api/tasks/{task}/segments", headers=h, json=payload(end))
        for (c, h), end in zip(actors, (2000, 3000))])
    assert sorted(r.status_code for r in responses) == [200, 409]
    winner = next(r.json() for r in responses if r.status_code == 200)
    assert world.snapshot(task)[2] == 1
    assert world.snapshot(task)[4] == [(0, winner["segments"][0]["end_ms"])]


def test_save_submit_race_and_late_save_preserve_committed_submission(world):
    task = world.task("in_progress", "a1", pairs=[(0, 1000)])
    save_client, save_headers = world.client("a1")
    submit_client, submit_headers = world.client("a1")
    saved, submitted = race(world, task, [
        lambda: save_client.put(f"/api/tasks/{task}/segments", headers=save_headers, json=payload(2000)),
        lambda: submit_client.post(f"/api/tasks/{task}/submit", headers=submit_headers, json=payload(3000)),
    ])
    assert sorted([saved.status_code, submitted.status_code]) == [200, 409]
    if submitted.status_code == 409:
        submitted = submit_client.post(f"/api/tasks/{task}/submit", headers=submit_headers, json=payload(3000, 1))
        assert submitted.status_code == 200
    final = world.snapshot(task)
    assert final[0] == "submitted" and final[4] == [(0, 3000)]
    assert save_client.put(f"/api/tasks/{task}/segments", headers=save_headers, json=payload(2000)).status_code == 409
    assert world.snapshot(task) == final


def test_concurrent_identical_submissions_are_idempotent_and_count_once(world):
    task = world.task("in_progress", "a1")
    actors = [world.client("a1"), world.client("a1")]
    responses = race(world, task, [lambda c=c, h=h: c.post(
        f"/api/tasks/{task}/submit", headers=h, json=payload()) for c, h in actors])
    assert [r.status_code for r in responses] == [200, 200]
    assert responses[0].json() == responses[1].json()
    final = world.snapshot(task)
    assert final[2] == 1
    client, headers = actors[0]
    assert client.post(f"/api/tasks/{task}/submit", headers=headers, json=payload(3000)).status_code == 409
    assert world.snapshot(task) == final
    admin, _ = world.client("admin")
    from app.rules import BEIJING
    day = datetime.now(BEIJING).date().isoformat()
    stats = admin.get("/api/stats/daily", params={"start_date": day, "end_date": day,
                                                  "tenant_id": str(world.tenants["a"])}).json()
    assert (stats["task_count"], stats["effective_ms"]) == (1, 2000)


def test_database_failure_after_delete_rolls_back_previous_draft(world):
    task = world.task("in_progress", "a1", pairs=[(0, 1000)])
    before = world.snapshot(task)
    client, headers = world.client("a1")

    def fail_insert(conn, cursor, statement, parameters, context, executemany):
        if statement.startswith("INSERT INTO segments"):
            raise OperationalError("injected segment write failure", {}, Exception("injected"))

    event.listen(world.engine, "before_cursor_execute", fail_insert)
    try:
        response = client.put(f"/api/tasks/{task}/segments", headers=headers, json=payload())
        assert response.status_code == 503
    finally:
        event.remove(world.engine, "before_cursor_execute", fail_insert)
    assert world.snapshot(task) == before
    assert client.put(f"/api/tasks/{task}/segments", headers=headers, json=payload()).status_code == 200


@pytest.mark.parametrize("body", [
    {"expected_revision": 0, "segments": [{"start_ms": 0, "end_ms": 2000}, {"start_ms": 1000, "end_ms": 3000}]},
    {"expected_revision": 0, "segments": [{"start_ms": 0, "end_ms": 120001}]},
    {"expected_revision": 0, "segments": [{"start_ms": 2, "end_ms": 2}]},
    {"expected_revision": 0, "segments": [{"start_ms": 0.5, "end_ms": 2000}]},
    {"expected_revision": 0, "segments": [{"start_ms": i * 2, "end_ms": i * 2 + 1} for i in range(1001)]},
])
@pytest.mark.parametrize("submit", [False, True])
def test_invalid_annotation_requests_do_not_destroy_previous_draft(world, body, submit):
    task = world.task("in_progress", "a1", pairs=[(0, 1000)])
    before = world.snapshot(task)
    client, headers = world.client("a1")
    response = client.request("POST" if submit else "PUT", f"/api/tasks/{task}/{'submit' if submit else 'segments'}",
                              headers=headers, json=body)
    assert response.status_code == 422
    assert world.snapshot(task) == before


def test_empty_draft_is_allowed_but_empty_submission_preserves_draft(world):
    task = world.task("in_progress", "a1", pairs=[(0, 1000)])
    client, headers = world.client("a1")
    empty = {"expected_revision": 0, "segments": []}
    assert client.put(f"/api/tasks/{task}/segments", headers=headers, json=empty).status_code == 200
    before = world.snapshot(task)
    empty["expected_revision"] = 1
    assert client.post(f"/api/tasks/{task}/submit", headers=headers, json=empty).status_code == 422
    assert world.snapshot(task) == before


@pytest.mark.parametrize("invalid", ["overlap", "negative", "zero", "foreign-assignee", "state"])
def test_database_constraints_protect_data_even_without_api_validation(world, invalid):
    task = world.task("in_progress", "a1", pairs=[(0, 1000)])
    before = world.snapshot(task)
    with Session(world.engine) as db:
        with pytest.raises(IntegrityError) as rejected:
            if invalid in ("overlap", "negative", "zero"):
                start, end = {"overlap": (999, 2000), "negative": (-2, -1), "zero": (2000, 2000)}[invalid]
                db.add(Segment(task_id=task, start_ms=start, end_ms=end))
            elif invalid == "foreign-assignee":
                db.get(Task, task).assignee_id = world.users["b1"]
            else:
                db.get(Task, task).status = "submitted"
            db.commit()
        expected_constraint = {
            "overlap": "ex_segments_no_overlap",
            "negative": "ck_segments_valid_interval",
            "zero": "ck_segments_valid_interval",
            "foreign-assignee": "fk_tasks_assignee_tenant",
            "state": "ck_tasks_state_consistency",
        }[invalid]
        assert rejected.value.orig.diag.constraint_name == expected_constraint
        db.rollback()
    assert world.snapshot(task) == before
    with Session(world.engine) as db, db.begin():
        db.add(Segment(task_id=task, start_ms=1000, end_ms=2000))
    assert world.snapshot(task)[4] == [(0, 1000), (1000, 2000)]
