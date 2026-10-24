"""Create ignored local configuration and download the challenge's small demo MP4."""
import hashlib
import json
import secrets
import shutil
import struct
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VIDEO_URL = "https://huggingface.co/datasets/lerobot/pusht/resolve/main/videos/observation.image/chunk-000/file-000.mp4"


def validate_mp4(path: Path) -> None:
    """Reject truncated top-level MP4 boxes before accepting a download."""
    length = path.stat().st_size
    seen = set()
    with path.open("rb") as source:
        while source.tell() < length:
            start = source.tell()
            header = source.read(8)
            if len(header) != 8:
                raise ValueError("MP4 文件尾部不完整")
            size, kind = struct.unpack(">I4s", header)
            header_size = 8
            if size == 1:
                extended = source.read(8)
                if len(extended) != 8:
                    raise ValueError("MP4 扩展长度不完整")
                size = struct.unpack(">Q", extended)[0]
                header_size = 16
            elif size == 0:
                size = length - start
            if size < header_size or start + size > length:
                raise ValueError("MP4 数据块不完整，下载文件可能被截断")
            seen.add(kind)
            source.seek(start + size)
    if not {b"ftyp", b"moov", b"mdat"}.issubset(seen):
        raise ValueError("演示 MP4 缺少必要的数据块")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    env_path = ROOT / ".env"
    if not env_path.exists():
        database_password = secrets.token_urlsafe(24)
        demo_password = secrets.token_urlsafe(18)
        content = (ROOT / ".env.example").read_text(encoding="utf-8")
        content = content.replace("replace-with-a-local-password", database_password)
        content = content.replace("replace-with-a-demo-password", demo_password)
        with env_path.open("x", encoding="utf-8", newline="\n") as output:
            output.write(content)
        print("已生成本地 .env；随机密码保存在该文件中，不打印到日志。")
    else:
        print("保留已有 .env，未修改配置或密码。")
    directory = ROOT / "storage" / "videos"
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / "pusht-demo.mp4"
    if destination.is_file():
        validate_mp4(destination)
        print("保留已有演示视频；导入时会由服务端 ffprobe 校验。")
        return
    temporary = destination.with_suffix(".mp4.part")
    request = urllib.request.Request(VIDEO_URL, headers={"User-Agent": "video-segment-annotation-platform/0.1"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as output:
            expected_length = response.headers.get("Content-Length")
            shutil.copyfileobj(response, output)
        if expected_length is not None and temporary.stat().st_size != int(expected_length):
            raise ValueError("视频下载长度与 Content-Length 不符，请重试")
        if temporary.stat().st_size < 1024:
            raise ValueError("下载文件过小，不能作为演示视频")
        validate_mp4(temporary)
        with temporary.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        temporary.replace(destination)
        (directory / "pusht-demo.source.json").write_text(json.dumps({
            "source_url": VIDEO_URL, "sha256": digest,
            "downloaded_at": datetime.now(timezone.utc).isoformat(),
            "bytes": destination.stat().st_size,
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    print(f"演示视频已下载：{destination.stat().st_size:,} bytes；未加入版本控制。")


if __name__ == "__main__":
    main()
