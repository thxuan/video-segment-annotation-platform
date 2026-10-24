from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.orm import Session

from app.models import LoginSession, User
from app.security import token_digest

PAYLOAD = {"expected_revision": 0, "segments": [{"start_ms": 1000, "end_ms": 3000}]}


@pytest.mark.parametrize("actor,owner,tenant", [
    ("b1", "a1", "a"), ("a2", "a1", "a"),
])
@pytest.mark.parametrize("method,suffix", [
    ("GET", ""), ("GET", "/video"), ("GET", "/frames"),
    ("POST", "/claim"), ("PUT", "/segments"), ("POST", "/submit"),
])
def test_object_access_is_enforced_on_every_endpoint(world, actor, owner, tenant, method, suffix):
    task = world.task("in_progress", owner, tenant, pairs=[(0, 1000)])
    before = world.snapshot(task)
    client, headers = world.client(actor)
    response = client.request(method, f"/api/tasks/{task}{suffix}", headers=headers,
                              **({"json": PAYLOAD} if suffix in ("/segments", "/submit") else {}))
    # Same-tenant claim reports occupied; reads/writes do not expose another owner's data.
    expected = 409 if actor == "a2" and suffix == "/claim" else 404
    assert response.status_code == expected
    assert world.snapshot(task) == before
    listing = client.get("/api/tasks").json()
    assert str(task) not in {item["id"] for item in listing["items"]}


@pytest.mark.parametrize("method,path", [
    ("GET", "/api/tenants"),
    ("GET", "/api/tasks?tenant_id={tenant}"),
    ("GET", "/api/stats/daily?start_date=2026-10-24&end_date=2026-10-24"),
    ("GET", "/api/stats/tasks?day=2026-10-24&tenant_id={tenant}&user_id={user}"),
    ("POST", "/api/tasks?title=forbidden&tenant_id={tenant}"),
])
def test_annotator_cannot_use_administrator_endpoints(world, method, path):
    client, headers = world.client("a1")
    path = path.format(tenant=world.tenants["a"], user=world.users["a1"])
    assert client.request(method, path, headers=headers, content=b"not-video").status_code == 403


@pytest.mark.parametrize("suffix", ["/claim", "/segments", "/submit"])
def test_administrator_cannot_mutate_annotations(world, suffix):
    task = world.task("in_progress", "a1", pairs=[(0, 1000)])
    before = world.snapshot(task)
    client, headers = world.client("admin")
    method = "PUT" if suffix == "/segments" else "POST"
    assert client.request(method, f"/api/tasks/{task}{suffix}", headers=headers,
                          json=PAYLOAD).status_code == 403
    assert world.snapshot(task) == before


@pytest.mark.parametrize("case", ["missing", "forged", "other-session", "bad-origin"])
@pytest.mark.parametrize("suffix", ["/claim", "/segments", "/submit", "/logout", "/publish"])
def test_write_requests_require_session_csrf_and_allowed_origin(world, case, suffix):
    task = world.task("in_progress", "a1", pairs=[(0, 1000)])
    before = world.snapshot(task)
    client, headers = world.client("admin" if suffix == "/publish" else "a1")
    if case == "missing":
        headers = {}
    elif case == "forged":
        headers = {"X-CSRF-Token": "forged"}
    elif case == "other-session":
        _, headers = world.client("a2")
    else:
        headers["Origin"] = "https://untrusted.example"
    path = ("/api/auth/logout" if suffix == "/logout" else
            f"/api/tasks?title=forbidden&tenant_id={world.tenants['a']}" if suffix == "/publish" else
            f"/api/tasks/{task}{suffix}")
    method = "PUT" if suffix == "/segments" else "POST"
    assert client.request(method, path, headers=headers, json=PAYLOAD).status_code == 403
    assert world.snapshot(task) == before
    assert client.get("/api/auth/me").status_code == 200


@pytest.mark.parametrize("case", ["anonymous", "expired", "inactive", "logged-out"])
def test_invalid_sessions_cannot_read_or_write(world, case):
    task = world.task("in_progress", "a1", pairs=[(0, 1000)])
    before = world.snapshot(task)
    client, headers = world.client(None if case == "anonymous" else "a1")
    if case != "anonymous":
        token = client.cookies.get("annotation_session")
        if case == "logged-out":
            assert client.post("/api/auth/logout", headers=headers).status_code == 204
            # Restore the stolen old cookie: server-side revocation must still reject it.
            client.cookies.set("annotation_session", token, path="/api")
        else:
            with Session(world.engine) as db, db.begin():
                if case == "expired":
                    db.get(LoginSession, token_digest(token)).expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
                else:
                    db.get(User, world.users["a1"]).is_active = False
    for path in ("/api/auth/me", "/api/tasks", f"/api/tasks/{task}",
                 f"/api/tasks/{task}/video", f"/api/tasks/{task}/frames", "/api/stats/me"):
        assert client.get(path).status_code == 401
    for method, suffix in (("POST", "/claim"), ("PUT", "/segments"), ("POST", "/submit")):
        assert client.request(method, f"/api/tasks/{task}{suffix}", headers=headers, json=PAYLOAD).status_code == 401
    assert world.snapshot(task) == before


def test_login_cookie_rotation_password_failure_and_personal_scope(world):
    client, _ = world.client()
    for username in (f"{world.prefix}-a1", "does-not-exist"):
        response = client.post("/api/auth/login", json={"username": username, "password": "wrong"})
        assert response.status_code == 401
        assert response.json() == {"detail": "账号或密码不正确"}
    credentials = {"username": f"{world.prefix}-a1", "password": world.password}
    first = client.post("/api/auth/login", json=credentials)
    cookie = first.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie and "path=/api" in cookie
    old = client.cookies.get("annotation_session")
    assert client.post("/api/auth/login", json=credentials).status_code == 200
    with Session(world.engine) as db:
        assert db.get(LoginSession, token_digest(old)) is None
    world.task("submitted", "a1", pairs=[(0, 1000), (2000, 4000)])
    world.task("submitted", "a2", pairs=[(0, 9000)])
    world.task("submitted", "b1", "b", pairs=[(0, 8000)])
    personal = client.get("/api/stats/me", params={"tenant_id": str(world.tenants["b"]),
                                                 "user_id": str(world.users["b1"])}).json()
    assert (personal["task_count"], personal["effective_ms"], personal["today_count"]) == (1, 3000, 1)
    admin, _ = world.client("admin")
    assert admin.get("/api/stats/me").status_code == 403
