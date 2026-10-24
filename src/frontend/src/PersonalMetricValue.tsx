import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ContributionMetric } from "./personal-statistics";

export function PersonalMetricValue({
  label,
  metric,
  open,
  onOpen,
  onClose,
}: {
  label: string;
  metric: ContributionMetric;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const id = useId();
  const hideTimer = useRef<number | null>(null);
  function cancelHide() {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  }
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useEffect(() => cancelHide, [open]);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !tooltip.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const bounds = tooltip.current.getBoundingClientRect();
    setPosition({
      left: Math.max(
        12,
        Math.min(
          innerWidth - bounds.width - 12,
          anchor.left + anchor.width / 2 - bounds.width / 2,
        ),
      ),
      top:
        anchor.top - bounds.height - 10 >= 12
          ? anchor.top - bounds.height - 10
          : anchor.bottom + 10,
    });
  }, [open, metric.full]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        onClose();
    };
    const scrolled = (event: Event) => {
      if (
        !(event.target instanceof Node) ||
        !tooltip.current?.contains(event.target)
      )
        onClose();
    };
    document.addEventListener("keydown", dismiss);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", onClose);
    };
  }, [open, onClose]);
  return (
    <div
      ref={root}
      className="personal-metric-value-shell"
      onPointerEnter={(event) => {
        cancelHide();
        if (event.pointerType === "mouse") onOpen();
      }}
      onPointerLeave={() => {
        if (!root.current?.contains(document.activeElement)) {
          cancelHide();
          hideTimer.current = window.setTimeout(onClose, 160);
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onClose();
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="personal-metric-value"
        aria-label={`${label}，完整数值：${metric.full}`}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onFocus={onOpen}
        onClick={onOpen}
      >
        <strong>
          {metric.value}
          {metric.unit && <small>{metric.unit}</small>}
        </strong>
      </button>
      {open && (
        <span
          id={id}
          ref={tooltip}
          role="tooltip"
          className="personal-metric-tooltip"
          style={position}
        >
          {metric.full}
        </span>
      )}
    </div>
  );
}
