import type { Segment } from "./types";

export type EditorRow = { key: string; start: string; end: string };
export type LocalDraft = {
  version: 1;
  userId: string;
  taskId: string;
  revision: number;
  savedAt: string;
  rows: EditorRow[];
  markIn: number | null;
  markTarget?: string | null;
  pendingSubmit: boolean;
};

export function rowContent(rows: EditorRow[]): string {
  return JSON.stringify(rows.map(({ start, end }) => ({ start, end })));
}

export function videoMilliseconds(seconds: number, duration: number): number {
  if (!Number.isFinite(seconds)) throw new Error("请等待视频加载完成");
  return Math.min(duration, Math.max(0, Math.round(seconds * 1000)));
}

export function seekIncrement(
  duration: number,
  shift: boolean,
): number {
  return Math.max(1, Math.round(duration * (shift ? 0.01 : 0.001)));
}

export function stepFrame(
  frames: readonly number[],
  current: number,
  direction: -1 | 1,
  count = 1,
  min = 0,
  max = Infinity,
): number {
  if (!frames.length) return current;
  // Binary search supports VFR and off-frame positions without accumulated FPS drift.
  const upper = (value: number) => {
    let lo = 0,
      hi = frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (frames[mid] <= value + 0.001) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const lower = (value: number) => {
    let lo = 0,
      hi = frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (frames[mid] < value - 0.001) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const first = lower(min);
  const last = upper(max) - 1;
  if (first > last) return current;
  const next =
    direction > 0 ? upper(current) + count - 1 : lower(current) - count;
  return frames[Math.max(first, Math.min(last, next))];
}

export function shortcutContext(
  target: EventTarget | null,
): "video" | "timeline" | "page" {
  if (!(target instanceof HTMLElement)) return "page";
  const region = target.closest("[data-shortcut-context]");
  const context = region?.getAttribute("data-shortcut-context");
  if (context === "timeline" || context === "video") return context;
  if (target.closest("video")) return "video";
  return "page";
}

export function moveBoundary(
  segment: Segment,
  field: "start_ms" | "end_ms",
  value: number,
  duration: number,
): Segment {
  const next = Math.min(duration, Math.max(0, Math.round(value)));
  return field === "start_ms"
    ? { ...segment, start_ms: Math.min(next, segment.end_ms - 1) }
    : { ...segment, end_ms: Math.max(next, segment.start_ms + 1) };
}

export function draftPrefix(userId: string, taskId: string): string {
  return `annotation-draft-v1:${userId}:${taskId}:`;
}

// Local storage can be stale or manually edited. Never restore identities from its payload.
export function parseDraft(
  raw: string,
  userId: string,
  taskId: string,
): LocalDraft | null {
  try {
    const value = JSON.parse(raw) as LocalDraft;
    if (
      value.version !== 1 ||
      value.userId !== userId ||
      value.taskId !== taskId ||
      !Number.isInteger(value.revision) ||
      value.revision < 0 ||
      typeof value.savedAt !== "string" ||
      !Number.isFinite(Date.parse(value.savedAt)) ||
      !Array.isArray(value.rows) ||
      value.rows.length > 1000 ||
      !value.rows.every(
        (row) =>
          row &&
          typeof row.key === "string" &&
          typeof row.start === "string" &&
          row.start.length <= 64 &&
          typeof row.end === "string" &&
          row.end.length <= 64,
      ) ||
      new Set(value.rows.map((row) => row.key)).size !== value.rows.length ||
      !(
        value.markIn === null ||
        (Number.isInteger(value.markIn) && value.markIn >= 0)
      ) ||
      typeof value.pendingSubmit !== "boolean" ||
      !(
        value.markTarget === undefined ||
        value.markTarget === null ||
        (typeof value.markTarget === "string" &&
          value.markIn !== null &&
          value.rows.some((row) => row.key === value.markTarget))
      )
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function findDraft(
  storage: Storage,
  userId: string,
  taskId: string,
): { key: string; draft: LocalDraft } | null {
  let latest: { key: string; draft: LocalDraft } | null = null;
  const prefix = draftPrefix(userId, taskId);
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const draft = parseDraft(storage.getItem(key) ?? "", userId, taskId);
    if (
      draft &&
      (!latest || Date.parse(draft.savedAt) > Date.parse(latest.draft.savedAt))
    ) {
      latest = { key, draft };
    }
  }
  return latest;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    !!target.closest(
      'input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), textarea, select, [contenteditable]:not([contenteditable="false"])',
    )
  );
}
