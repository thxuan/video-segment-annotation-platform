import type { Segment } from "./types";

export function parseSeconds(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) throw new Error("时间请输入非负秒数，最多保留三位小数");
  const ms = Number(match[1]) * 1000 + Number((match[2] ?? "").padEnd(3, "0"));
  if (!Number.isSafeInteger(ms) || ms > 2147483647)
    throw new Error("时间超出支持范围");
  return ms;
}

export function validateSegments(
  segments: Segment[],
  duration: number,
): Segment[] {
  const sorted = [...segments].sort((a, b) => a.start_ms - b.start_ms);
  let end = 0;
  for (const segment of sorted) {
    if (!(
      0 <= segment.start_ms &&
      segment.start_ms < segment.end_ms &&
      segment.end_ms <= duration
    )) {
      throw new Error("每段须满足：0 ≤ 起点 < 终点 ≤ 视频时长");
    }
    if (segment.start_ms < end)
      throw new Error("片段存在重叠，请调整；首尾相接可以保存");
    end = segment.end_ms;
  }
  if (segments.length > 1000) throw new Error("单个任务最多支持 1000 个片段");
  return sorted;
}

// Empty fields are unfinished input, not a format error. They still block saves.
export function inspectSegmentInputs(
  rows: ReadonlyArray<{ start: string; end: string }>,
  duration: number,
): {
  segments: Segment[];
  validation: string;
  visibleError: string;
  rowErrors: string[];
} {
  const complete: (Segment & { index: number })[] = [];
  const rowErrors = rows.map(() => "");
  let incomplete = false;
  rows.forEach((row, index) => {
    const startText = row.start.trim(),
      endText = row.end.trim();
    if (!startText || !endText) incomplete = true;
    try {
      const start = startText ? parseSeconds(startText) : null;
      const end = endText ? parseSeconds(endText) : null;
      if (start !== null && start > duration)
        throw new Error("起点不能超过视频时长");
      if (end !== null && end > duration)
        throw new Error("终点不能超过视频时长");
      if (start !== null && end !== null) {
        const [segment] = validateSegments(
          [{ start_ms: start, end_ms: end }],
          duration,
        );
        complete.push({ ...segment, index });
      }
    } catch (error) {
      rowErrors[index] =
        error instanceof Error ? error.message : "时间格式不正确";
    }
  });
  const sorted = complete.sort((a, b) => a.start_ms - b.start_ms);
  let furthest: (typeof complete)[number] | undefined;
  for (const segment of sorted) {
    if (furthest && segment.start_ms < furthest.end_ms) {
      rowErrors[segment.index] ||=
        `与片段 ${furthest.index + 1} 重叠，请调整；首尾相接可以保存`;
      rowErrors[furthest.index] ||=
        `与片段 ${segment.index + 1} 重叠，请调整；首尾相接可以保存`;
    }
    if (!furthest || segment.end_ms > furthest.end_ms) furthest = segment;
  }
  const visibleError =
    rowErrors.find(Boolean) ||
    (rows.length > 1000 ? "单个任务最多支持 1000 个片段" : "");
  const validation =
    visibleError || (incomplete ? "请填写完整的起点和终点" : "");
  return {
    segments: validation
      ? []
      : sorted.map(({ start_ms, end_ms }) => ({ start_ms, end_ms })),
    validation,
    visibleError,
    rowErrors,
  };
}

export function beijingToday(): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
