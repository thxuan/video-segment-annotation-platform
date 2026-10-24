"""Pure interval and business-day rules, shared by write endpoints and reports."""
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

BEIJING = ZoneInfo("Asia/Shanghai")


def canonical_segments(segments, duration_ms: int, *, submit: bool = False) -> list[tuple[int, int]]:
    intervals = sorted((s.start_ms, s.end_ms) for s in segments)
    if submit and not intervals:
        raise ValueError("至少添加一个有效片段后才能提交")
    previous_end = 0
    for start, end in intervals:
        if not 0 <= start < end <= duration_ms:
            raise ValueError("片段须满足：0 ≤ 起点 < 终点 ≤ 视频时长")
        if start < previous_end:
            raise ValueError("片段不能重叠；允许前后片段首尾相接")
        previous_end = end
    return intervals


def utc_day_bounds(start_date: date, end_date: date) -> tuple[datetime, datetime]:
    if start_date > end_date or (end_date - start_date).days > 365 or end_date.year == 9999:
        raise ValueError("请选择顺序正确且不超过 366 天的日期范围")
    start = datetime.combine(start_date, time.min, BEIJING)
    end = datetime.combine(end_date + timedelta(days=1), time.min, BEIJING)
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)
