import assert from "node:assert/strict";
import { test } from "node:test";
import {
  draftPrefix,
  findDraft,
  moveBoundary,
  parseDraft,
  videoMilliseconds,
  seekIncrement,
  stepFrame,
} from "../../src/frontend/src/editor-draft.ts";
import { validateSegments } from "../../src/frontend/src/annotations.ts";
import {
  applyMarkedRange,
  targetAt,
  selectionConflicts,
} from "../../src/frontend/src/editor-selection.ts";

const selectionRows = [
  { key: "a", start: "10", end: "20" },
  { key: "b", start: "30", end: "40" },
  { key: "c", start: "50", end: "60" },
];
test("mark target uses half-open intervals and ignores stale row selection", () => {
  assert.equal(targetAt(selectionRows, 10000, 100000), "a");
  assert.equal(targetAt(selectionRows, 19999, 100000), "a");
  assert.equal(targetAt(selectionRows, 20000, 100000), null);
  const touching = [selectionRows[0], { key: "b", start: "20", end: "40" }];
  assert.equal(targetAt(touching, 20000, 100000), "b");
  assert.equal(
    targetAt([{ key: "bad", start: "", end: "20" }], 10000, 100000),
    null,
  );
});
test("remark atomically replaces target, preserves neighbours and accepts touching boundaries", () => {
  const before = structuredClone(selectionRows);
  const changed = applyMarkedRange(
    selectionRows,
    "a",
    12000,
    30000,
    100000,
    "new",
  );
  assert.equal(changed.key, "a");
  assert.equal(changed.rows.length, 3);
  assert.deepEqual(changed.rows[0], { key: "a", start: "12", end: "30" });
  assert.strictEqual(changed.rows[1], selectionRows[1]);
  assert.deepEqual(selectionRows, before);
  assert.deepEqual(
    applyMarkedRange(selectionRows, "a", 8000, 18000, 100000, "new").rows[0],
    { key: "a", start: "8", end: "18" },
  );
  assert.equal(
    applyMarkedRange(selectionRows, null, 20000, 30000, 100000, "new").rows
      .length,
    4,
  );
});
test("remark rejects crossing multiple clips, reversed/zero/out-of-range and missing target without mutation", () => {
  const before = structuredClone(selectionRows);
  assert.deepEqual(
    selectionConflicts(selectionRows, "a", 12000, 55000, 100000).map(
      (row) => row.key,
    ),
    ["b", "c"],
  );
  assert.throws(
    () => applyMarkedRange(selectionRows, "a", 12000, 55000, 100000, "new"),
    /02、03/,
  );
  for (const [start, end] of [
    [12000, 12000],
    [12000, 11000],
    [-1, 12000],
    [12000, 100001],
  ])
    assert.throws(() =>
      applyMarkedRange(selectionRows, "a", start, end, 100000, "new"),
    );
  assert.throws(
    () => applyMarkedRange(selectionRows, "missing", 1000, 2000, 100000, "new"),
    /不存在/,
  );
  assert.deepEqual(selectionRows, before);
});
test("remark is allowed at the segment limit while a new clip is rejected", () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    key: String(i),
    start: String(i * 2),
    end: String(i * 2 + 1),
  }));
  assert.equal(
    applyMarkedRange(rows, "0", 100, 500, 3000000, "new").rows.length,
    1000,
  );
  assert.throws(
    () => applyMarkedRange(rows, null, 2500000, 2501000, 3000000, "new"),
    /1000/,
  );
});

const backup = (overrides = {}) => ({
  version: 1,
  userId: "a1",
  taskId: "task-a",
  revision: 7,
  savedAt: "2026-10-23T01:00:00Z",
  rows: [{ key: "first", start: "10.", end: "" }],
  markIn: 1000,
  pendingSubmit: false,
  ...overrides,
});
const parse = (value) => parseDraft(JSON.stringify(value), "a1", "task-a");

test("video and page share percentage steps and Shift multiplier", () => {
  assert.equal(seekIncrement(2565000, false), 2565);
  assert.equal(seekIncrement(2565000, true), 25650);
  assert.equal(seekIncrement(1, true), 1);
});

test("frame stepping follows variable timestamps, off-frame input and bounded edits without drift", () => {
  const frames = [0, 34, 67, 101, 135, 201, 235, 269];
  assert.equal(stepFrame(frames, 34, 1), 67);
  assert.equal(stepFrame(frames, 34, -1), 0);
  assert.equal(stepFrame(frames, 34, 1, 5), 235);
  assert.equal(stepFrame(frames, 235, -1, 5), 34);
  assert.equal(stepFrame(frames, 50, -1), 34);
  assert.equal(stepFrame(frames, 50, 1), 67);
  assert.equal(stepFrame(frames, 34.5, -1), 34);
  assert.equal(stepFrame(frames, 0, -1), 0);
  assert.equal(stepFrame(frames, 269, 1, 5), 269);
  assert.equal(stepFrame(frames, 101, 1, 5, 34, 200), 135);
  assert.equal(stepFrame(frames, 101, -1, 5, 34, 200), 34);
  assert.equal(stepFrame(frames, 50, 1, 1, 40, 60), 50);
  assert.equal(stepFrame([], 50, 1), 50);
});

test("playback conversion rounds to milliseconds and clamps both video boundaries", () => {
  assert.equal(videoMilliseconds(1.2346, 2000), 1235);
  assert.equal(videoMilliseconds(-1, 2000), 0);
  assert.equal(videoMilliseconds(2.1, 2000), 2000);
  assert.throws(() => videoMilliseconds(NaN, 2000));
});

test("dragging cannot invert a selected interval or move it beyond the video", () => {
  const segment = { start_ms: 1000, end_ms: 2000 };
  assert.deepEqual(moveBoundary(segment, "start_ms", 2500, 3000), {
    start_ms: 1999,
    end_ms: 2000,
  });
  assert.deepEqual(moveBoundary(segment, "end_ms", -100, 3000), {
    start_ms: 1000,
    end_ms: 1001,
  });
  assert.equal(moveBoundary(segment, "start_ms", -1, 3000).start_ms, 0);
  assert.equal(moveBoundary(segment, "end_ms", 9000, 3000).end_ms, 3000);
  assert.deepEqual(segment, { start_ms: 1000, end_ms: 2000 });
});

test("dragging into a neighbour remains subject to overlap validation", () => {
  const changed = moveBoundary(
    { start_ms: 0, end_ms: 1000 },
    "end_ms",
    2001,
    3000,
  );
  assert.throws(() =>
    validateSegments([changed, { start_ms: 2000, end_ms: 3000 }], 3000),
  );
});

test("unfinished text and original server revision survive local recovery", () => {
  const value = backup({ pendingSubmit: true });
  assert.deepEqual(parse(value), value);
  assert.equal(parse(value).revision, 7);
  assert.equal(parse(value).rows[0].start, "10.");
});
test("pending remark target survives recovery; legacy pending selections stay new", () => {
  const value = backup({ markIn: 12000, markTarget: "first" });
  assert.equal(parse(value).markTarget, "first");
  assert.equal(parse(backup()).markTarget, undefined);
  assert.equal(parse(backup({ markTarget: "missing" })), null);
  assert.equal(parse(backup({ markIn: null, markTarget: "first" })), null);
});

test("backups from another account or task are never restored", () => {
  assert.equal(parse(backup({ userId: "b1" })), null);
  assert.equal(parse(backup({ taskId: "task-b" })), null);
});

test("corrupt, oversized and incompatible backups are ignored", () => {
  assert.equal(parseDraft("{broken", "a1", "task-a"), null);
  for (const overrides of [
    { version: 2 },
    { revision: -1 },
    { revision: "7" },
    { savedAt: "invalid" },
    { rows: Array(1001).fill({ key: "x", start: "0", end: "1" }) },
    { rows: [{ key: "x", start: 10, end: "20" }] },
    {
      rows: [
        { key: "x", start: "0", end: "1" },
        { key: "x", start: "2", end: "3" },
      ],
    },
    { markIn: -1 },
    { pendingSubmit: "false" },
  ])
    assert.equal(parse(backup(overrides)), null);
});

test("recovery chooses the newest valid backup and keeps independent tab copies", () => {
  const prefix = draftPrefix("a1", "task-a");
  const values = new Map([
    [`${prefix}tab-1`, JSON.stringify(backup())],
    [
      `${prefix}tab-2`,
      JSON.stringify(backup({ revision: 4, savedAt: "2026-10-23T02:00:00Z" })),
    ],
    [`${prefix}broken`, "oops"],
    [
      `${draftPrefix("b1", "task-a")}tab-3`,
      JSON.stringify(backup({ userId: "b1", savedAt: "2026-10-23T03:00:00Z" })),
    ],
  ]);
  const storage = {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
  };
  const found = findDraft(storage, "a1", "task-a");
  assert.equal(found.key, `${prefix}tab-2`);
  assert.equal(found.draft.revision, 4);
  assert.equal(values.size, 4);
  assert.equal(findDraft(storage, "a1", "different-task"), null);
});
