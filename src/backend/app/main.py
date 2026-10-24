from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select, text
from sqlalchemy.exc import OperationalError, ProgrammingError

from app.auth import router as auth_router
from app.config import get_settings
from app.db import get_engine
from app.models import Segment, Task, Tenant
from app.tasks import router as tasks_router
from app.workflow import router as workflow_router
from app.stats import router as stats_router

app = FastAPI(title="视频片段标注平台 API", version="0.1.0")


@app.middleware("http")
async def browser_boundary(request: Request, call_next):
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        origin = request.headers.get("origin")
        if origin and origin not in get_settings().allowed_origins:
            return JSONResponse({"detail": "不允许的请求来源"}, status_code=403)
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.exception_handler(OperationalError)
def database_unavailable(request: Request, exc: OperationalError):
    return JSONResponse({"detail": "数据库暂不可用，请稍后重试"}, status_code=503)


@app.get("/api/health", tags=["health"])
def health():
    return {"status": "ok"}


@app.get("/api/ready", tags=["health"])
def ready():
    try:
        with get_engine().connect() as connection:
            connection.execute(text("SELECT 1"))
            connection.execute(select(Tenant.id).limit(1))
            connection.execute(select(Task.revision).limit(1))
            connection.execute(select(Segment.id).limit(1))
    except (OperationalError, ProgrammingError):
        return JSONResponse({"status": "not_ready"}, status_code=503)
    return {"status": "ready"}


app.include_router(auth_router, prefix="/api")
app.include_router(tasks_router, prefix="/api")
app.include_router(workflow_router, prefix="/api")
app.include_router(stats_router, prefix="/api")
