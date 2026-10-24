import {
  inspectSegmentInputs,
  parseSeconds,
  validateSegments,
} from "./annotations.ts";
import type { EditorRow } from "./editor-draft";

function selectionIntervals(rows: EditorRow[], duration: number) {
  return rows.flatMap((row, index) => {
    try {
      const start = parseSeconds(row.start),
        end = parseSeconds(row.end);
      validateSegments([{ start_ms: start, end_ms: end }], duration);
      return [{ key: row.key, index, start, end }];
    } catch {
      return [];
    }
  });
}

export function targetAt(rows: EditorRow[], at: number, duration: number) {
  return (
    selectionIntervals(rows, duration).find(
      ({ start, end }) => start <= at && at < end,
    )?.key ?? null
  );
}

export function selectionConflicts(
  rows: EditorRow[],
  target: string | null,
  start: number,
  end: number,
  duration: number,
) {
  if (start >= end) return [];
  return selectionIntervals(rows, duration).filter(
    (row) => row.key !== target && start < row.end && end > row.start,
  );
}

// Build and validate the whole result before the caller commits one history step.
export function applyMarkedRange(
  rows: EditorRow[],
  target: string | null,
  start: number,
  end: number,
  duration: number,
  newKey: string,
) {
  validateSegments([{ start_ms: start, end_ms: end }], duration);
  if (target !== null && !rows.some((row) => row.key === target))
    throw new Error("原片段已不存在，请取消后重新标记");
  const conflicts = selectionConflicts(rows, target, start, end, duration);
  if (conflicts.length)
    throw new Error(
      `与片段 ${conflicts.map((row) => String(row.index + 1).padStart(2, "0")).join("、")} 重叠；原片段保持不变，请调整终点或取消修改`,
    );
  const key = target ?? newKey;
  const replacement = {
    key,
    start: String(start / 1000),
    end: String(end / 1000),
  };
  const next =
    target === null
      ? [...rows, replacement]
      : rows.map((row) => (row.key === target ? replacement : row));
  const { validation } = inspectSegmentInputs(next, duration);
  if (validation) throw new Error(validation);
  return { rows: next, key };
}
