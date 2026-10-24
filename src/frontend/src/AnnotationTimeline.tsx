import { useState } from "react";
import type { KeyboardEvent } from "react";
import { durationLabel } from "./api";
import { parseSeconds } from "./annotations";
import { moveBoundary, stepFrame } from "./editor-draft";
import type { EditorRow } from "./editor-draft";
import { Button } from "./components/ui/button";
import { Focus, Scan } from "lucide-react";

const rulerLabel = (ms: number, precise: boolean) => {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}${precise ? `.${String(ms % 1000).padStart(3, "0")}` : ""}`;
};

type Props = {
  rows: EditorRow[];
  duration: number;
  current: number;
  markIn: number | null;
  pendingLabel: string;
  pendingIssue: string;
  conflictKeys: string[];
  selected: string | null;
  editable: boolean;
  disabled: boolean;
  frames: number[];
  frameLoading: boolean;
  frameError: string;
  onRetryFrames: () => void;
  onSeek: (ms: number) => void;
  onSelect: (key: string) => void;
  onChange: (key: string, start: string, end: string) => void;
  onGesture: (active: boolean) => void;
};

export function AnnotationTimeline(props: Props) {
  const { rows, duration, current, markIn, selected, editable, disabled } =
    props;
  const [view, setView] = useState<{
    key: string;
    start: number;
    end: number;
  } | null>(null);
  // A new selection must remain visible even if another clip was zoomed in.
  const focusedView = markIn === null && view?.key === selected;
  const viewStart = focusedView ? view.start : 0;
  const viewEnd = focusedView ? view.end : duration;
  const span = viewEnd - viewStart;
  const pendingStart = markIn === null ? null : Math.min(markIn, current);
  const pendingEnd = markIn === null ? null : Math.max(markIn, current);
  const intervals = rows.flatMap((row, index) => {
    try {
      const start = parseSeconds(row.start),
        end = parseSeconds(row.end);
      return start < end && end <= duration ? [{ row, index, start, end }] : [];
    } catch {
      return [];
    }
  });
  const active = intervals.find((item) => item.row.key === selected);
  function changeBoundary(field: "start_ms" | "end_ms", value: number) {
    if (!active || disabled) return;
    const next = moveBoundary(
      { start_ms: active.start, end_ms: active.end },
      field,
      value,
      duration,
    );
    props.onChange(
      active.row.key,
      String(next.start_ms / 1000),
      String(next.end_ms / 1000),
    );
  }
  function rangeKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
    move: (value: number) => void,
    min = Number(event.currentTarget.min),
    max = Number(event.currentTarget.max),
    allowEnd = false,
  ) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.nativeEvent.isComposing ||
      !props.frames.length
    )
      return;
    const slider = event.currentTarget;
    const frames = allowEnd ? [...props.frames, duration] : props.frames;
    move(
      stepFrame(
        frames,
        Number(slider.value),
        event.key === "ArrowLeft" ? -1 : 1,
        event.shiftKey ? 5 : 1,
        min,
        max,
      ),
    );
  }
  return (
    <section
      className="annotation-timeline"
      aria-label="片段时间轴"
      data-shortcut-context="timeline"
      tabIndex={0}
      onPointerDown={(event) => {
        if (
          event.target instanceof HTMLElement &&
          !event.target.closest("input, button, select")
        )
          event.currentTarget.focus({ preventScroll: true });
      }}
    >
      <div className="section-heading">
        <h2>片段时间轴</h2>
        <div className="timeline-view-actions">
          <Button size="sm" variant="ghost" onClick={() => setView(null)}>
            <Scan size={15} />
            显示全片
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!active || markIn !== null}
            onClick={() => {
              if (!active) return;
              const padding = Math.max(1000, active.end - active.start);
              setView({
                key: active.row.key,
                start: Math.max(0, active.start - padding),
                end: Math.min(duration, active.end + padding),
              });
            }}
          >
            <Focus size={15} />
            聚焦所选片段
          </Button>
        </div>
      </div>
      <label className="sr-only" htmlFor="video-playhead">
        拖动播放位置，点击色块选择片段
      </label>
      <p
        className={
          props.frameLoading || props.frameError ? "field-help" : "sr-only"
        }
        role="status"
      >
        {props.frameLoading
          ? "正在读取视频帧，完成后可用方向键逐帧定位…"
          : props.frameError
            ? props.frameError
            : "时间轴：← / → 移动 1 帧，Shift + ← / → 移动 5 帧"}
        {props.frameError && (
          <Button variant="ghost" size="sm" onClick={props.onRetryFrames}>
            重试读取视频帧
          </Button>
        )}
      </p>
      <div className="timeline-lanes">
        <div className="timeline-lane-title" aria-hidden="true">
          片段
        </div>
        <div className="timeline-content">
          <div className="timeline-ruler">
            <div className="timeline-ticks mono" aria-hidden="true">
              {Array.from({ length: 7 }, (_, index) => (
                <span key={index} style={{ left: `${(index / 6) * 100}%` }}>
                  {rulerLabel(
                    Math.round(viewStart + (span * index) / 6),
                    span < 6000,
                  )}
                </span>
              ))}
            </div>
            <input
              id="video-playhead"
              className="playhead-range"
              type="range"
              min={viewStart}
              max={viewEnd}
              step={1}
              value={Math.max(viewStart, Math.min(viewEnd, current))}
              aria-label="视频播放位置"
              aria-valuetext={durationLabel(current)}
              onKeyDown={(event) => rangeKeyDown(event, props.onSeek)}
              onChange={(event) => props.onSeek(Number(event.target.value))}
            />
          </div>
          <div className="timeline-track">
            {intervals
              .filter(({ start, end }) => start < viewEnd && end > viewStart)
              .map(({ row, index, start, end }) => (
                <button
                  key={row.key}
                  type="button"
                  className={`timeline-segment ${selected === row.key ? "selected" : ""} ${props.conflictKeys.includes(row.key) ? "selection-conflict" : ""}`}
                  style={{
                    left: `${((Math.max(start, viewStart) - viewStart) / span) * 100}%`,
                    width: `${((Math.min(end, viewEnd) - Math.max(start, viewStart)) / span) * 100}%`,
                  }}
                  aria-label={`选择片段 ${index + 1}，${durationLabel(start)} 至 ${durationLabel(end)}`}
                  aria-pressed={selected === row.key}
                  title={`片段 ${index + 1} · ${durationLabel(start)} → ${durationLabel(end)}`}
                  onClick={() => {
                    props.onSelect(row.key);
                    props.onSeek(start);
                  }}
                >
                  {String(index + 1).padStart(2, "0")}
                </button>
              ))}
            {editable &&
              markIn !== null &&
              pendingStart !== null &&
              pendingEnd !== null && (
                <>
                  <div
                    className={`timeline-pending-selection ${current < markIn || props.pendingIssue ? "reversed" : ""}`}
                    role="img"
                    aria-label="待完成选段"
                    data-start-ms={markIn}
                    data-end-ms={current}
                    title={`待完成选段：${durationLabel(markIn)} → ${durationLabel(current)}，按 O 确认`}
                    style={{
                      left: `${((pendingStart - viewStart) / span) * 100}%`,
                      width: `${((pendingEnd - pendingStart) / span) * 100}%`,
                    }}
                  />
                  <span
                    className="timeline-pending-start"
                    aria-hidden="true"
                    style={{ left: `${((markIn - viewStart) / span) * 100}%` }}
                  />
                </>
              )}
            {editable &&
              markIn !== null &&
              props.conflictKeys.length > 0 &&
              intervals
                .filter((item) => props.conflictKeys.includes(item.row.key))
                .map(({ row, start, end }) => (
                  <span
                    key={`conflict:${row.key}`}
                    className="timeline-overlap"
                    aria-hidden="true"
                    style={{
                      left: `${((Math.max(start, markIn) - viewStart) / span) * 100}%`,
                      width: `${((Math.min(end, current) - Math.max(start, markIn)) / span) * 100}%`,
                    }}
                  />
                ))}
            {current >= viewStart && current <= viewEnd && (
              <span
                className="timeline-cursor"
                style={{ left: `${((current - viewStart) / span) * 100}%` }}
              />
            )}
            {editable &&
              active &&
              (["start_ms", "end_ms"] as const).map((field) => (
                <input
                  key={field}
                  className="timeline-handle"
                  type="range"
                  min={viewStart}
                  max={viewEnd}
                  step={1}
                  disabled={disabled}
                  value={field === "start_ms" ? active.start : active.end}
                  aria-label={`时间轴片段 ${active.index + 1} ${field === "start_ms" ? "起点" : "终点"}`}
                  aria-valuetext={durationLabel(
                    field === "start_ms" ? active.start : active.end,
                  )}
                  onPointerDown={() => props.onGesture(true)}
                  onPointerUp={() => props.onGesture(false)}
                  onPointerCancel={() => props.onGesture(false)}
                  onLostPointerCapture={() => props.onGesture(false)}
                  onKeyDown={(event) =>
                    rangeKeyDown(
                      event,
                      (value) => changeBoundary(field, value),
                      field === "end_ms"
                        ? Math.max(viewStart, active.start + 1)
                        : viewStart,
                      field === "start_ms"
                        ? Math.min(viewEnd, active.end - 1)
                        : viewEnd,
                      field === "end_ms",
                    )
                  }
                  onChange={(event) =>
                    changeBoundary(field, Number(event.target.value))
                  }
                />
              ))}
          </div>
        </div>
      </div>
      {editable && markIn !== null && (
        <p
          className={`field-help ${current < markIn || props.pendingIssue ? "validation-text" : ""}`}
          role="status"
          aria-label="选段状态"
        >
          {props.pendingLabel}：
          <span className="mono">
            {durationLabel(markIn)} → {durationLabel(current)}
          </span>
          {props.pendingIssue
            ? ` · ${props.pendingIssue}`
            : current < markIn
              ? " · 当前位置早于起点，请移到起点之后"
              : " · 按 O 确认，Esc 取消；原片段保持不变"}
        </p>
      )}

      {editable && active && (
        <div className="timeline-boundaries">
          <strong>片段 {String(active.index + 1).padStart(2, "0")}</strong>
          {(["start_ms", "end_ms"] as const).map((field) => (
            <label key={field}>
              {field === "start_ms" ? "起点" : "终点"}
              <input
                key={`${active.row.key}:${field}:${field === "start_ms" ? active.start : active.end}`}
                type="number"
                min={0}
                max={duration / 1000}
                step="0.001"
                disabled={disabled}
                aria-label={`所选片段${field === "start_ms" ? "起点" : "终点"}秒数`}
                defaultValue={(
                  (field === "start_ms" ? active.start : active.end) / 1000
                ).toFixed(3)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    event.currentTarget.value = (
                      (field === "start_ms" ? active.start : active.end) / 1000
                    ).toFixed(3);
                    event.currentTarget.blur();
                  }
                }}
                onBlur={(event) => {
                  try {
                    const value = parseSeconds(event.currentTarget.value);
                    const next = moveBoundary(
                      { start_ms: active.start, end_ms: active.end },
                      field,
                      value,
                      duration,
                    );
                    event.currentTarget.value = (
                      (field === "start_ms" ? next.start_ms : next.end_ms) /
                      1000
                    ).toFixed(3);
                    changeBoundary(field, value);
                  } catch {
                    event.currentTarget.value = (
                      (field === "start_ms" ? active.start : active.end) / 1000
                    ).toFixed(3);
                  }
                }}
              />
              <span>秒</span>
            </label>
          ))}
          <div className="timeline-key-hints" aria-hidden="true">
            <kbd>Space</kbd> 播放/暂停 <kbd>I</kbd> 起点 <kbd>O</kbd> 终点{" "}
            <kbd>← →</kbd> 逐帧
          </div>
        </div>
      )}
    </section>
  );
}
