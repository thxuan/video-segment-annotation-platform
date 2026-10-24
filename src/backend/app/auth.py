import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models import LoginSession, Tenant, User
from app.schemas import LoginInput, SessionRead, UserRead
from app.security import dummy_password_hash, hash_password, new_token, password_hasher, token_digest, verify_password

COOKIE_NAME = "annotation_session"
Db = Annotated[Session, Depends(get_db)]
router = APIRouter(prefix="/auth", tags=["auth"])


@dataclass
class AuthContext:
    user: User
    session: LoginSession


def require_session(request: Request, db: Db) -> AuthContext:
    token = request.cookies.get(COOKIE_NAME, "")
    if not token or len(token) > 128:
        raise HTTPException(401, "请先登录")
    session = db.get(LoginSession, token_digest(token))
    if session is None or session.expires_at <= datetime.now(timezone.utc):
        raise HTTPException(401, "登录已过期，请重新登录")
    user = db.get(User, session.user_id)
    if user is None or not user.is_active:
        raise HTTPException(401, "账号不可用，请重新登录")
    return AuthContext(user=user, session=session)


CurrentSession = Annotated[AuthContext, Depends(require_session)]


def require_admin(auth: CurrentSession) -> User:
    if auth.user.role != "admin":
        raise HTTPException(403, "需要管理员权限")
    return auth.user


def require_csrf(request: Request, auth: CurrentSession) -> AuthContext:
    supplied = request.headers.get("x-csrf-token", "")
    if not secrets.compare_digest(supplied.encode("utf-8"), auth.session.csrf_token.encode("utf-8")):
        raise HTTPException(403, "请求校验失败，请刷新后重试")
    return auth


def session_read(auth: AuthContext, db: Session) -> SessionRead:
    user = auth.user
    tenant = db.get(Tenant, user.tenant_id) if user.tenant_id else None
    return SessionRead(
        user=UserRead(
            id=user.id, username=user.username, display_name=user.display_name,
            role=user.role, tenant_id=user.tenant_id,
            tenant_name=tenant.name if tenant else None,
        ),
        csrf_token=auth.session.csrf_token,
    )


@router.post("/login", response_model=SessionRead)
def login(body: LoginInput, response: Response, db: Db, request: Request):
    user = db.scalar(select(User).where(User.username == body.username.strip().casefold()))
    stored_hash = user.password_hash if user else dummy_password_hash()
    valid = verify_password(body.password, stored_hash)
    if not valid or user is None or not user.is_active:
        raise HTTPException(401, "账号或密码不正确")
    if password_hasher.check_needs_rehash(user.password_hash):
        user.password_hash = hash_password(body.password)
    now = datetime.now(timezone.utc)
    db.execute(delete(LoginSession).where(LoginSession.expires_at <= now))
    old_token = request.cookies.get(COOKIE_NAME, "")
    if old_token and len(old_token) <= 128:
        db.execute(delete(LoginSession).where(LoginSession.token_hash == token_digest(old_token)))
    token = new_token()
    settings = get_settings()
    session = LoginSession(
        token_hash=token_digest(token), user_id=user.id,
        csrf_token=new_token(), expires_at=now + timedelta(hours=settings.session_hours),
    )
    db.add(session)
    db.commit()
    response.set_cookie(
        COOKIE_NAME, token, httponly=True, secure=settings.cookie_secure,
        samesite="lax", max_age=settings.session_hours * 3600, path="/api",
    )
    return session_read(AuthContext(user, session), db)


@router.get("/me", response_model=SessionRead)
def me(auth: CurrentSession, db: Db):
    return session_read(auth, db)


@router.post("/logout", status_code=204)
def logout(auth: Annotated[AuthContext, Depends(require_csrf)], db: Db):
    db.delete(auth.session)
    db.commit()
    response = Response(status_code=204)
    response.delete_cookie(COOKIE_NAME, path="/api", secure=get_settings().cookie_secure, httponly=True, samesite="lax")
    return response
