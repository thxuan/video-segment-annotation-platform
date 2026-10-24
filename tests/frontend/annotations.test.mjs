import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inspectSegmentInputs,
  parseSeconds,
  validateSegments,
} from "../../src/frontend/src/annotations.ts";

test("decimal seconds convert to exact integer milliseconds", () => {
  assert.equal(parseSeconds("10.250"), 10250);
  assert.equal(parseSeconds("0.001"), 1);
  assert.equal(parseSeconds("1.1"), 1100);
});
test("invalid and overprecise values are rejected", () => {
  for (const input of ["", "-1", "1.0001", "NaN", "1e3", "Infinity"]) {
    assert.throws(() => parseSeconds(input));
  }
});
test("adjacent intervals are accepted and sorted without mutating input", () => {
  const input = [
    { start_ms: 1000, end_ms: 2000 },
    { start_ms: 0, end_ms: 1000 },
  ];
  assert.deepEqual(validateSegments(input, 2000), [...input].reverse());
  assert.equal(input[0].start_ms, 1000);
});
test("overlap, zero-length and out-of-bounds intervals are rejected", () => {
  for (const input of [
    [
      { start_ms: 0, end_ms: 1001 },
      { start_ms: 1000, end_ms: 2000 },
    ],
    [{ start_ms: 1000, end_ms: 1000 }],
    [{ start_ms: 0, end_ms: 2001 }],
  ]) {
    assert.throws(() => validateSegments(input, 2000));
  }
});

test("blank and partially filled rows block saving without a format error", () => {
  for (const row of [
    { start: "", end: "" },
    { start: "1", end: "" },
    { start: " ", end: "2" },
  ]) {
    const result = inspectSegmentInputs([row], 3000);
    assert.equal(result.visibleError, "");
    assert.notEqual(result.validation, "");
    assert.deepEqual(result.segments, []);
  }
});

test("empty rows do not hide actual invalid text or overlapping complete rows", () => {
  const blank = { start: "", end: "" };
  assert.match(
    inspectSegmentInputs([blank, { start: "-1", end: "" }], 3000).visibleError,
    /非负秒数/,
  );
  assert.match(
    inspectSegmentInputs(
      [blank, { start: "0", end: "2" }, { start: "1", end: "3" }],
      3000,
    ).visibleError,
    /重叠/,
  );
  const valid = inspectSegmentInputs(
    [
      { start: "0", end: "1" },
      { start: "1", end: "2" },
    ],
    3000,
  );
  assert.equal(valid.validation, "");
  assert.equal(valid.visibleError, "");
  assert.equal(valid.segments.length, 2);
});

test("row errors retain displayed row numbers and identify all nested overlaps alongside invalid and blank input", () => {
  const result = inspectSegmentInputs(
    [
      { start: "8", end: "9" },
      { start: "0", end: "10" },
      { start: "1", end: "2" },
      { start: "-1", end: "" },
      { start: "", end: "" },
    ],
    10000,
  );
  assert.match(result.rowErrors[0], /与片段 2 重叠/);
  assert.match(result.rowErrors[1], /与片段 3 重叠/);
  assert.match(result.rowErrors[2], /与片段 2 重叠/);
  assert.match(result.rowErrors[3], /非负秒数/);
  assert.equal(result.rowErrors[4], "");
  assert.deepEqual(result.segments, []);
});

test("completed invalid intervals and entered endpoints beyond duration are reported on their own rows", () => {
  for (const row of [
    { start: "2", end: "1" },
    { start: "2", end: "2" },
    { start: "0", end: "4" },
    { start: "4", end: "" },
    { start: "", end: "4" },
    { start: "0.0001", end: "" },
  ]) {
    const result = inspectSegmentInputs([{ start: "", end: "" }, row], 3000);
    assert.equal(result.rowErrors[0], "");
    assert.notEqual(result.rowErrors[1], "");
    assert.notEqual(result.validation, "");
  }
});
