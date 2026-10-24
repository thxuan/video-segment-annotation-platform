import type { KeyboardEvent } from "react";
import { durationLabel } from "./api";
import { parseSeconds } from "./annotations";
import { seekIncrement } from "./editor-draft";
import type { EditorRow } from "./editor-draft";

type Props = {
  rows: EditorRow[];
  duration: number;
  current: number;
  selected: string | null;
  disabled: boolean;
  onSeek: (ms: number) => void;
};

export function VideoProgress({
  rows,
  duration,
  current,
  selected,
  disabled,
  onSeek,
}: Props) {
  const percent = (ms: number) =>
    `${Math.max(0, Math.min(100, (ms / duration) * 100))}%`;
  function seekKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.nativeEvent.isComposing
    )
      return;
    onSeek(
      current +
        seekIncrement(duration, event.shiftKey) *
          (event.key === "ArrowLeft" ? -1 : 1),
    );
  }
  return (
    <div className="video-progress" data-shortcut-context="video">
      <div className="video-progress-track" aria-hidden="true">
        <span
          className="video-progress-elapsed"
          style={{ width: percent(current) }}
        />
        {rows.flatMap((row) => {
          try {
            const start = parseSeconds(row.start),
              end = parseSeconds(row.end);
            if (start >= end || end > duration) return [];
            return [
              <span
                key={row.key}
                className={`video-progress-segment ${selected === row.key ? "selected" : ""}`}
                style={{ left: percent(start), width: percent(end - start) }}
              />,
            ];
          } catch {
            return [];
          }
        })}
        <span
          className="video-progress-cursor"
          style={{ left: percent(current) }}
        />
      </div>
      <input
        type="range"
        min={0}
        max={duration}
        step={1}
        value={current}
        aria-label="视频内播放进度"
        aria-valuetext={`${durationLabel(current)} / ${durationLabel(duration)}`}
        disabled={disabled}
        onKeyDown={seekKey}
        onChange={(event) => onSeek(Number(event.target.value))}
      />
    </div>
  );
}
