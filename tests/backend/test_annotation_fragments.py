"""Pure annotation rules; real PostgreSQL races are covered in tests/integration."""
from datetime import date, datetime, timezone

import pytest
from pydantic import ValidationError

from app.rules import BEIJING, canonical_segments, utc_day_bounds
from app.schemas import AnnotationInput, SegmentInput


def segment(start, end):
    return SegmentInput(start_ms=start, end_ms=end)


def test_sorts_intervals_and_accepts_adjacency_at_video_end():
    assert canonical_segments([segment(1000, 2000), segment(0, 1000)], 2000) == [(0, 1000), (1000, 2000)]


@pytest.mark.parametrize("pairs", [
    [(0, 1000), (999, 2000)], [(0, 2000), (500, 1000)],
    [(0, 1000), (0, 1000)], [(0, 2001)], [(1000, 1000)], [(1000, 500)],
])
def test_rejects_overlap_and_invalid_bounds(pairs):
    with pytest.raises(ValueError):
        canonical_segments([segment(*pair) for pair in pairs], 2000)


def test_empty_draft_allowed_but_submission_rejected():
    assert canonical_segments([], 2000) == []
    with pytest.raises(ValueError):
        canonical_segments([], 2000, submit=True)


@pytest.mark.parametrize("value", [-1, 0.5, True, "1000", 2147483648])
def test_api_rejects_non_integer_or_out_of_range_milliseconds(value):
    with pytest.raises(ValidationError):
        segment(value, 2000)


def test_revision_and_unknown_fields_are_checked():
    with pytest.raises(ValidationError):
        AnnotationInput(expected_revision=-1, segments=[])
    with pytest.raises(ValidationError):
        AnnotationInput(expected_revision=0, segments=[], tenant_id="untrusted")


def test_beijing_day_is_left_closed_and_right_open_in_utc():
    start, end = utc_day_bounds(date(2026, 10, 22), date(2026, 10, 22))
    assert start == datetime(2026, 10, 21, 16, tzinfo=timezone.utc)
    assert end == datetime(2026, 10, 22, 16, tzinfo=timezone.utc)
    before = datetime(2026, 10, 22, 15, 59, 59, 999000, tzinfo=timezone.utc)
    assert start <= before < end
    assert before.astimezone(BEIJING).date() == date(2026, 10, 22)
    assert end.astimezone(BEIJING).date() == date(2026, 10, 23)


@pytest.mark.parametrize("start,end", [(date(2026, 2, 2), date(2026, 2, 1)), (date(2025, 1, 1), date(2026, 1, 2)), (date(9999, 1, 1), date(9999, 1, 1))])
def test_rejects_invalid_report_ranges(start, end):
    with pytest.raises(ValueError):
        utc_day_bounds(start, end)
