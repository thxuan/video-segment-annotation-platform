import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, X } from "lucide-react";
import { api, durationLabel } from "./api";
import { useQuery } from "@tanstack/react-query";
import { Button } from "./components/ui/button";
import { celebrationKey } from "./personal-statistics";
import type { PersonalReport, Session, TaskDetailData } from "./types";

export function SubmissionCelebration({
  task,
  session,
  onClose,
  onBack,
}: {
  task: TaskDetailData;
  session: Session;
  onClose: () => void;
  onBack: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [animated, setAnimated] = useState(() => {
    try {
      return localStorage.getItem(celebrationKey(session.user.id)) !== "false";
    } catch {
      return true;
    }
  });
  const [preferenceError, setPreferenceError] = useState(false);
  const query = useQuery({
    queryKey: ["personal-stats", session.user.id],
    queryFn: ({ signal }) => api<PersonalReport>("/stats/me", { signal }),
    staleTime: 0,
    retry: false,
  });
  const count =
    !query.isFetching && !query.isError ? query.data?.task_count : undefined;
  const milestone = count !== undefined && [1, 10, 50, 100].includes(count);
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    element
      ?.querySelector<HTMLButtonElement>("[data-celebration-done]")
      ?.focus();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`submission-dialog ${animated ? "celebration-animated" : ""}`}
      aria-labelledby="submission-title"
      aria-describedby="submission-description"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <button
        type="button"
        className="celebration-close"
        aria-label="关闭成功提示"
        onClick={onClose}
      >
        <X size={19} />
      </button>
      <div className="celebration-art" aria-hidden="true">
        <div className="celebration-halo" />
        <div className="celebration-check">
          <Check size={34} strokeWidth={2.4} />
        </div>
        {Array.from({ length: 16 }, (_, index) => (
          <i
            key={index}
            className={`celebration-confetti confetti-${index % 3}`}
            style={
              {
                "--angle": `${index * 22.5}deg`,
                "--distance": `${62 + (index % 4) * 12}px`,
                "--turn": `${index * 47}deg`,
                "--delay": `${(index % 4) * 35}ms`,
              } as CSSProperties
            }
          />
        ))}
      </div>
      <h2 id="submission-title">
        {milestone
          ? count === 1
            ? "第一份标注，完成了！"
            : `已完成第 ${count} 项标注`
          : "又完成一份标注，辛苦了"}
      </h2>
      <p id="submission-description" className="celebration-description">
        {milestone
          ? "谢谢你一次次认真地看见细节。"
          : "你认真留下的每个片段，都有价值。"}
      </p>
      <div className="celebration-results">
        <div>
          <strong>
            {task.segments.length}
            <small> 个</small>
          </strong>
          <span>本次标注片段</span>
        </div>
        <div>
          <strong>{durationLabel(task.effective_ms)}</strong>
          <span>有效时长</span>
        </div>
      </div>
      {count !== undefined && (
        <p className="celebration-total">
          累计完成 <strong>{count.toLocaleString()}</strong> 项
        </p>
      )}
      <p className="celebration-locked">提交已完成，片段已锁定</p>
      <div className="celebration-actions">
        <Button variant="outline" onClick={onBack}>
          返回任务列表
        </Button>
        <Button data-celebration-done onClick={onClose}>
          完成
        </Button>
      </div>
      <label className="celebration-preference">
        <input
          type="checkbox"
          checked={animated}
          onChange={(event) => {
            const enabled = event.target.checked;
            setAnimated(enabled);
            try {
              localStorage.setItem(
                celebrationKey(session.user.id),
                String(enabled),
              );
              setPreferenceError(false);
            } catch {
              setPreferenceError(true);
            }
          }}
        />
        播放庆祝动效
      </label>
      {preferenceError && (
        <p className="field-help" role="status">
          本次设置已生效，浏览器暂时无法记住该选择。
        </p>
      )}
    </dialog>
  );
}
