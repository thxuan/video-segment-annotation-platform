"""Targeted regression checks for accepting incomplete demo downloads."""
import importlib.util
import struct
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "prepare_demo", Path(__file__).resolve().parents[2] / "tools" / "prepare_demo.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def box(kind, payload=b""):
    return struct.pack(">I4s", 8 + len(payload), kind) + payload


def test_accepts_complete_top_level_boxes(tmp_path):
    path = tmp_path / "complete.mp4"
    path.write_bytes(box(b"ftyp") + box(b"mdat", b"video") + box(b"moov", b"metadata"))
    module.validate_mp4(path)


def test_rejects_truncated_tail_despite_valid_ftyp(tmp_path):
    path = tmp_path / "truncated.mp4"
    data = box(b"ftyp") + box(b"mdat", b"video") + box(b"moov", b"metadata")
    path.write_bytes(data[:-3])
    with pytest.raises(ValueError, match="不完整"):
        module.validate_mp4(path)
