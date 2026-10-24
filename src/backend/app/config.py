from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parents[1]
# The checkout uses src/backend; the container keeps the backend in /app.
PROJECT_ROOT = BACKEND_ROOT.parents[1] if BACKEND_ROOT.name == "backend" and BACKEND_ROOT.parent.name == "src" else BACKEND_ROOT


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="APP_", env_file=PROJECT_ROOT / ".env", extra="ignore"
    )

    database_url: SecretStr
    video_dir: Path = PROJECT_ROOT / "storage" / "videos"
    cookie_secure: bool = False
    session_hours: int = Field(default=12, ge=1, le=168)
    allowed_origins: list[str] = [
        "http://localhost:5173", "http://127.0.0.1:5173",
        "http://localhost:8080", "http://127.0.0.1:8080",
        "http://localhost:8000", "http://127.0.0.1:8000",
    ]
    allow_demo_seed: bool = False
    demo_password: SecretStr = SecretStr("")
    ffprobe_binary: str = "ffprobe"
    max_upload_mb: int = Field(default=512, ge=1, le=2048)

    @property
    def resolved_video_dir(self) -> Path:
        path = self.video_dir
        return (path if path.is_absolute() else PROJECT_ROOT / path).resolve()


@lru_cache
def get_settings() -> Settings:
    return Settings()
