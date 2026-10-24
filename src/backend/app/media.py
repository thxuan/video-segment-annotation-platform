import json
import subprocess
from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_FLOOR
from functools import lru_cache
from pathlib import Path


def resolve_video_path(directory: Path, video_key: str) -> Path:
    root = directory.resolve()
    path = (root / video_key).resolve()
    if path == root or not path.is_relative_to(root):
        raise ValueError("Video path must stay inside the video directory")
    return path


def probe_duration_ms(path: Path, ffprobe_binary: str) -> int:
    result = subprocess.run(
        [ffprobe_binary, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
        capture_output=True, text=True, check=True, timeout=30,
    )
    metadata = json.loads(result.stdout)
    streams = [stream for stream in metadata.get("streams", []) if stream.get("codec_type") == "video"]
    if not streams or streams[0].get("codec_name") not in {"h264", "vp8", "vp9", "av1"}:
        raise ValueError("演示视频需要浏览器支持的视频编码")
    try:
        duration = Decimal(metadata["format"]["duration"])
        if not duration.is_finite() or duration <= 0:
            raise ValueError("视频时长无效")
        duration_ms = int((duration * 1000).to_integral_value(rounding=ROUND_FLOOR))
    except (KeyError, InvalidOperation) as exc:
        raise ValueError("无法读取视频时长") from exc
    if not 0 < duration_ms <= 2_147_483_647:
        raise ValueError("视频时长超出支持范围")
    return duration_ms


def probe_frame_times_ms(path: Path, ffprobe_binary: str, duration_ms: int) -> list[int]:
    stat = path.stat()
    return list(_frame_times(str(path), stat.st_size, stat.st_mtime_ns, ffprobe_binary, duration_ms))


@lru_cache(maxsize=4)
def _frame_times(path: str, size: int, modified: int, binary: str, duration_ms: int) -> tuple[int, ...]:
    # Decode presentation timestamps rather than estimating VFR frames from average FPS.
    result = subprocess.run(
        [binary, "-v", "error", "-select_streams", "v:0", "-show_entries",
         "frame=best_effort_timestamp_time:format=start_time", "-of", "json", path],
        capture_output=True, text=True, check=True, timeout=60,
    )
    metadata = json.loads(result.stdout)
    frames = metadata.get("frames", [])
    if not frames or len(frames) > 1_000_000:
        raise ValueError("视频帧索引为空或超出支持范围")
    try:
        origin = Decimal(metadata.get("format", {}).get("start_time", "0"))
        times = [Decimal(frame["best_effort_timestamp_time"]) - origin for frame in frames]
        if not origin.is_finite() or any(not time.is_finite() for time in times):
            raise ValueError("视频帧时间无效")
        # The annotation API uses integer ms. Ceiling seeks inside the intended frame,
        # whereas rounding down could still display the preceding frame.
        values = sorted({int((time * 1000).to_integral_value(rounding=ROUND_CEILING))
                         for time in times if 0 <= time * 1000 < duration_ms})
        values = [value for value in values if value < duration_ms]
    except (KeyError, InvalidOperation, TypeError) as exc:
        raise ValueError("无法读取视频帧时间") from exc
    if not values:
        raise ValueError("视频帧索引不可用")
    return tuple(values)
