FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY requirements.lock .
# The package cache stays in BuildKit, outside the runtime image, across retries.
RUN --mount=type=cache,id=annotation-api-pip,target=/root/.cache/pip,sharing=locked \
    python -m pip install --progress-bar off --retries 3 --timeout 30 -r requirements.lock \
    && python -m pip check
COPY app ./app
COPY alembic.ini .
COPY migrations ./migrations
RUN useradd --create-home --uid 10001 annotation
USER annotation
EXPOSE 8000
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
