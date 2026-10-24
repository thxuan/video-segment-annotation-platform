import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityCalendar,
  activityLevel,
  contributionTime,
  contributionCount,
  contributionDuration,
} from "../../src/frontend/src/personal-statistics.ts";
import {
  readWorkspacePage,
  workspacePageKey,
} from "../../src/frontend/src/workspace-memory.ts";

test("calendar preserves leap day, pads Monday-based weeks and leaves future dates outside range", () => {
  const cells = activityCalendar("2024-02-28", "2024-03-02");
  assert.equal(cells.length, 7);
  assert.equal(cells[0].date, "2024-02-26");
  assert.deepEqual(
    cells.filter((c) => c.inRange).map((c) => c.date),
    ["2024-02-28", "2024-02-29", "2024-03-01", "2024-03-02"],
  );
  assert.equal(cells.at(-1).inRange, false);
});

test("a 365-day activity window has exactly 365 valid days over year boundaries", () => {
  const cells = activityCalendar("2025-10-25", "2026-10-24");
  assert.equal(cells.length % 7, 0);
  assert.equal(cells.filter((c) => c.inRange).length, 365);
  assert.equal(new Date(`${cells[0].date}T00:00:00Z`).getUTCDay(), 1);
});

test("a selected calendar year covers January through December, including leap day", () => {
  for (const [year, days] of [
    [2024, 366],
    [2025, 365],
  ]) {
    const cells = activityCalendar(`${year}-01-01`, `${year}-12-31`);
    const dates = cells.filter((cell) => cell.inRange).map((cell) => cell.date);
    assert.equal(dates.length, days);
    assert.equal(dates[0], `${year}-01-01`);
    assert.equal(dates.at(-1), `${year}-12-31`);
    assert.deepEqual(
      dates
        .filter((date) => date.endsWith("-01"))
        .map((date) => Number(date.slice(5, 7))),
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
  }
});

test("activity colors have fixed count boundaries and cumulative time never wraps at 24 hours", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 5, 6, 9, 10, 50].map(activityLevel),
    [0, 1, 1, 2, 2, 3, 3, 4, 4],
  );
  assert.equal(contributionTime(100 * 3600000 + 12345), "100:00:12");
});

test("personal page restores only for an annotator and cannot restore a task inside it", () => {
  const storage = {
    getItem: (key) =>
      key === workspacePageKey("a1")
        ? JSON.stringify({ view: "personal", selectedId: "stale-task" })
        : null,
  };
  assert.deepEqual(readWorkspacePage(storage, "a1", false), {
    view: "personal",
    selectedId: null,
  });
  assert.deepEqual(readWorkspacePage(storage, "a1", true), {
    view: "tasks",
    selectedId: null,
  });
});

test("task counts change units exactly at ten thousand and one hundred million without rounding up", () => {
  for (const [count, value, unit] of [
    [0, "0", "项"],
    [9999, "9,999", "项"],
    [10000, "1", "万项"],
    [12999, "1.2", "万项"],
    [99999999, "9999.9", "万项"],
    [100000000, "1", "亿项"],
    [129999999, "1.2", "亿项"],
    [Number.MAX_SAFE_INTEGER, "9007.1", "万亿项"],
  ]) {
    const formatted = contributionCount(count);
    assert.equal(formatted.value, value);
    assert.equal(formatted.unit, unit);
    assert.equal(formatted.full, `${count.toLocaleString("zh-CN")} 项`);
  }
  assert.equal(contributionCount(12999, "天").unit, "万天");
});

test("duration thresholds use integer milliseconds and discard only display precision", () => {
  for (const [ms, value, unit] of [
    [0, "00:00:00", ""],
    [999, "00:00:00", ""],
    [359999999, "99:59:59", ""],
    [360000000, "100", "小时"],
    [360359999, "100", "小时"],
    [360360000, "100.1", "小时"],
    [450359999, "125", "小时"],
    [451818255, "125.5", "小时"],
    [35999999999, "9999.9", "小时"],
    [36000000000, "1", "万小时"],
    [43199999999, "1.1", "万小时"],
    [43200000000, "1.2", "万小时"],
    [Number.MAX_SAFE_INTEGER, "25", "亿小时"],
  ]) {
    const formatted = contributionDuration(ms);
    assert.equal(formatted.value, value, `value at ${ms}ms`);
    assert.equal(formatted.unit, unit, `unit at ${ms}ms`);
  }
  assert.equal(
    contributionDuration(451818255).full,
    "125 小时 30 分 18.255 秒",
  );
  assert.equal(contributionDuration(999).full, "0 小时 0 分 0.999 秒");
});
