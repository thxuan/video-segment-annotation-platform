export function activityLevel(count: number) {
  return count <= 0 ? 0 : count <= 2 ? 1 : count <= 5 ? 2 : count <= 9 ? 3 : 4;
}

// UTC arithmetic represents calendar dates; it never depends on the browser timezone.
export function activityCalendar(start: string, end: string) {
  const first = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`).getTime();
  const mondayOffset = (first.getUTCDay() + 6) % 7;
  const origin = first.getTime() - mondayOffset * 86_400_000;
  const length = Math.ceil(((last - origin) / 86_400_000 + 1) / 7) * 7;
  return Array.from({ length }, (_, index) => {
    const date = new Date(origin + index * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return { date, inRange: date >= start && date <= end };
  });
}

export function contributionTime(ms: number) {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export interface ContributionMetric {
  value: string;
  unit: string;
  full: string;
}

const groupedNumber = new Intl.NumberFormat("zh-CN");
const decimalNumber = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 1,
  useGrouping: false,
});
const compactOptions: Intl.NumberFormatOptions & { roundingMode: "trunc" } = {
  notation: "compact",
  maximumFractionDigits: 1,
  roundingMode: "trunc",
  useGrouping: false,
};
const compactNumber = new Intl.NumberFormat("zh-CN", compactOptions);

function compactParts(value: number | bigint, unit: string) {
  const parts = compactNumber.formatToParts(value);
  return {
    value: parts
      .filter((part) => part.type !== "compact" && part.type !== "literal")
      .map((part) => part.value)
      .join(""),
    unit: `${parts.find((part) => part.type === "compact")?.value ?? ""}${unit}`,
  };
}

export function contributionCount(
  count: number,
  unit = "项",
): ContributionMetric {
  const full = `${groupedNumber.format(count)} ${unit}`;
  return count < 10_000
    ? { value: groupedNumber.format(count), unit, full }
    : { ...compactParts(count, unit), full };
}

export function contributionDuration(ms: number): ContributionMetric {
  // Truncate in integer milliseconds first; no floating-point rounding at thresholds.
  const milliseconds = BigInt(ms);
  const hours = milliseconds / 3_600_000n;
  const minutes = (milliseconds / 60_000n) % 60n;
  const seconds = (milliseconds / 1000n) % 60n;
  const remainder = String(milliseconds % 1000n).padStart(3, "0");
  const full = `${groupedNumber.format(hours)} 小时 ${minutes} 分 ${seconds}.${remainder} 秒`;
  if (hours < 100n) return { value: contributionTime(ms), unit: "", full };
  if (hours < 10_000n) {
    const tenths = milliseconds / 360_000n;
    return {
      value: decimalNumber.format(Number(tenths) / 10),
      unit: "小时",
      full,
    };
  }
  return { ...compactParts(hours, "小时"), full };
}

export const celebrationKey = (userId: string) =>
  `annotation-celebration-v1:${userId}`;
