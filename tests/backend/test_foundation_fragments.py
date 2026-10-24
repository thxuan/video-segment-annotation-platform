"""Authentication/media helpers; real HTTP coverage lives in tests/integration."""
import json
import subprocess
from pathlib import Path

import pytest

from app.media import probe_duration_ms, resolve_video_path
from app.security import hash_password, new_token, token_digest, verify_password


def test_password_hashes_are_salted_and_reject_wrong_password():
    first = hash_password("local-test-password")
    second = hash_password("local-test-password")
    assert first != second
    assert verify_password("local-test-password", first)
    assert not verify_password("wrong-password", first)
    assert not verify_password("local-test-password", "not-a-valid-hash")


def test_session_tokens_are_unique_and_only_digest_is_stored():
    first, second = new_token(), new_token()
    assert first != second
    assert token_digest(first) != token_digest(second)
    assert len(token_digest(first)) == 64
    assert first not in token_digest(first)


@pytest.mark.parametrize("key", ["../outside.mp4", "../../outside.mp4", "."])
def test_video_path_cannot_escape_storage(tmp_path: Path, key: str):
    with pytest.raises(ValueError):
        resolve_video_path(tmp_path, key)


def test_absolute_video_path_outside_storage_is_rejected(tmp_path: Path):
    with pytest.raises(ValueError):
        resolve_video_path(tmp_path / "videos", str(tmp_path / "outside.mp4"))
    assert resolve_video_path(tmp_path, "demo.mp4") == tmp_path / "demo.mp4"


def test_probe_uses_server_duration_without_rounding_past_video_end(monkeypatch):
    payload = {"format": {"duration": "1.2349"}, "streams": [{"codec_type": "video", "codec_name": "h264"}]}
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: subprocess.CompletedProcess([], 0, json.dumps(payload)))
    assert probe_duration_ms(Path("demo.mp4"), "ffprobe") == 1234


@pytest.mark.parametrize("duration", ["NaN", "Infinity", "0", "-1"])
def test_probe_rejects_invalid_duration(monkeypatch, duration: str):
    payload = {"format": {"duration": duration}, "streams": [{"codec_type": "video", "codec_name": "h264"}]}
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: subprocess.CompletedProcess([], 0, json.dumps(payload)))
    with pytest.raises(ValueError):
        probe_duration_ms(Path("demo.mp4"), "ffprobe")
