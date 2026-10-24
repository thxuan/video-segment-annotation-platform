import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Plus,
  Save,
  Send,
  Trash2,
  MapPin,
  Undo2,
  Redo2,
  Play,
  Pause,
  RotateCcw,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Keyboard,
  Flag,
  X,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { api, ApiError, dateLabel, durationLabel, errorText } from "./api";
import {
  inspectSegmentInputs,
  parseSeconds,
  validateSegments,
} from "./annotations";
import { Button } from "./components/ui/button";
import type { Session, TaskDetailData } from "./types";
import { AnnotationTimeline } from "./AnnotationTimeline";
import { VideoProgress } from "./VideoProgress";
import { ShortcutHelp } from "./ShortcutHelp";
import { ThemeToggle } from "./ThemeToggle";
import { SubmissionCelebration } from "./SubmissionCelebration";
import {
  applyMarkedRange,
  selectionConflicts,
  targetAt,
} from "./editor-selection";
import {
  draftPrefix,
  findDraft,
  isTypingTarget,
  rowContent,
  videoMilliseconds,
  seekIncrement,
  shortcutContext,
  stepFrame,
} from "./editor-draft";
import type { EditorRow, LocalDraft } from "./editor-draft";
import { autoSaveKey, readAutoSave } from "./workspace-memory";

type Props = {
  id: string;
  session: Session;
  onBack: () => void;
  backLabel?: string;
  onExpired: () => void;
  onActivity: (dirty: boolean, busy: boolean) => void;
};
type Row = EditorRow;
const labels = {
  available: "待领取",
  in_progress: "标注中",
  submitted: "已提交",
};
const rowsFor = (task: TaskDetailData): Row[] =>
  task.segments.map((s) => ({
    key: crypto.randomUUID(),
    start: String(s.start_ms / 1000),
    end: String(s.end_ms / 1000),
  }));
const content = rowContent;

export function TaskWorkspace(props: Props) {
  const query = useQuery({
    queryKey: ["task-detail", props.session.user.id, props.id],
    queryFn: () => api<TaskDetailData>(`/tasks/${props.id}`),
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401)
      props.onExpired();
  }, [query.error, props.onExpired]);
  return (
    <section className="task-workspace">
      {(query.isPending || query.isError) && (
        <Button variant="ghost" className="back-button" onClick={props.onBack}>
          <ArrowLeft size={16} />
          {props.backLabel ?? "返回任务列表"}
        </Button>
      )}
      {query.isPending ? (
        <div className="state-panel">正在读取任务…</div>
      ) : query.isError ? (
        <div className="state-panel" role="alert">
          {errorText(query.error)}
          <Button onClick={() => void query.refetch()}>重试</Button>
        </div>
      ) : (
        <Editor {...props} initial={query.data} />
      )}
    </section>
  );
}

function Editor({
  initial,
  session,
  onExpired,
  onActivity,
  onBack,
  backLabel = "返回任务列表",
}: Props & { initial: TaskDetailData }) {
  const client = useQueryClient();
  const [task, setTask] = useState(initial);
  const [rows, setRows] = useState(() => rowsFor(initial));
  const [baseline, setBaseline] = useState(() => content(rowsFor(initial)));
  const [baseRevision, setBaseRevision] = useState(initial.revision);
  const [busy, setBusy] = useState(false);
  const [celebration, setCelebration] = useState<TaskDetailData | null>(null);
  const [message, setFeedback] = useState({ text: "", id: 0, warning: false });
  function setMessage(text: string, warning = false) {
    setFeedback((previous) => ({ text, id: previous.id + 1, warning }));
  }
  useEffect(() => {
    if (!message.text) return;
    const timer = window.setTimeout(() => {
      setFeedback((current) =>
        current.id === message.id ? { ...current, text: "" } : current,
      );
    }, 3250);
    return () => window.clearTimeout(timer);
  }, [message.id, message.text]);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [shortcutArea, setShortcutArea] = useState<"video" | "timeline">(
    "video",
  );
  const [fullscreen, setFullscreen] = useState(false);
  const [mediaReady, setMediaReady] = useState(false);
  const [markIn, setMarkIn] = useState<number | null>(null);
  const [markTarget, setMarkTarget] = useState<string | null>(null);
  const [markAttempted, setMarkAttempted] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [autoSave, setAutoSave] = useState(() => {
    try {
      return readAutoSave(localStorage, session.user.id);
    } catch {
      return true;
    }
  });
  const [savePaused, setSavePaused] = useState(false);
  const [pendingSubmit, setPendingSubmit] = useState(false);
  const [gesture, setGesture] = useState(false);
  const [historySize, setHistorySize] = useState({ undo: 0, redo: 0 });
  const [storageError, setStorageError] = useState("");
  const [backedUpSignature, setBackedUpSignature] = useState<string | null>(
    null,
  );
  const video = useRef<HTMLVideoElement>(null);
  const fullscreenRoot = useRef<HTMLDivElement>(null);
  const segmentList = useRef<HTMLDivElement>(null);
  const focusNewSegment = useRef<string | null>(null);
  const requestBusy = useRef(false);
  const undo = useRef<Row[][]>([]);
  const redo = useRef<Row[][]>([]);
  const lastEdit = useRef({ group: "", at: 0 });
  const previewEnd = useRef<number | null>(null);
  const owner = useRef(crypto.randomUUID());
  const backupKey = `${draftPrefix(session.user.id, initial.id)}${owner.current}`;
  const canEdit =
    session.user.role === "annotator" &&
    task.status === "in_progress" &&
    task.assignee_id === session.user.id;
  const dirty = canEdit && content(rows) !== baseline;
  const [recovery, setRecovery] = useState(() => {
    if (!canEdit) return null;
    try {
      const found = findDraft(localStorage, session.user.id, initial.id);
      return found &&
        (content(found.draft.rows) !== baseline ||
          found.draft.markIn !== null ||
          found.draft.pendingSubmit)
        ? found
        : null;
    } catch {
      return null;
    }
  });
  const hasPending = dirty || markIn !== null || !!recovery || pendingSubmit;
  const backupSignature = JSON.stringify({
    content: content(rows),
    markIn,
    markTarget,
    pendingSubmit,
    baseRevision,
  });
  const hasCurrentBackup =
    backedUpSignature === backupSignature && !storageError;
  const canChange = canEdit && !busy && !recovery && !pendingSubmit;
  const frameQuery = useQuery({
    queryKey: ["task-frames", session.user.id, task.id],
    queryFn: () =>
      api<{ frame_times_ms: number[] }>(`/tasks/${task.id}/frames`),
    staleTime: Infinity,
    retry: false,
  });
  useEffect(() => {
    if (frameQuery.error instanceof ApiError && frameQuery.error.status === 401)
      onExpired();
  }, [frameQuery.error, onExpired]);
  const frames = frameQuery.data?.frame_times_ms ?? [];
  useLayoutEffect(() => {
    const key = focusNewSegment.current;
    if (!key || !segmentList.current) return;
    focusNewSegment.current = null;
    const input = segmentList.current.querySelector<HTMLInputElement>(
      `[data-segment-key="${key}"] input`,
    );
    input?.focus({ preventScroll: true });
    segmentList.current.scrollTop = segmentList.current.scrollHeight;
  }, [rows]);
  useEffect(() => {
    onActivity(hasPending, busy);
    return () => onActivity(false, false);
  }, [hasPending, busy, onActivity]);
  useEffect(() => {
    if (!hasPending && !busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasPending, busy]);
  useEffect(() => {
    if (!canEdit || recovery) return;
    try {
      if (hasPending) {
        const draft: LocalDraft = {
          version: 1,
          userId: session.user.id,
          taskId: task.id,
          revision: baseRevision,
          savedAt: new Date().toISOString(),
          rows,
          markIn,
          markTarget,
          pendingSubmit,
        };
        localStorage.setItem(backupKey, JSON.stringify(draft));
        setBackedUpSignature(backupSignature);
      } else {
        // Each editor owns a separate key, so another tab's backup is never erased.
        localStorage.removeItem(backupKey);
        setBackedUpSignature(null);
      }
      setStorageError("");
    } catch {
      setBackedUpSignature(null);
      setStorageError(
        "浏览器无法保存本机备份；请手动保存或导出草稿，刷新后可能无法恢复。",
      );
    }
  }, [
    rows,
    markIn,
    markTarget,
    pendingSubmit,
    baseRevision,
    task.id,
    canEdit,
    hasPending,
    recovery,
    backupKey,
    session.user.id,
    backupSignature,
  ]);
  function changeAutoSave(enabled: boolean) {
    setAutoSave(enabled);
    try {
      localStorage.setItem(autoSaveKey(session.user.id), String(enabled));
    } catch {
      setMessage("浏览器无法记住自动保存设置，刷新后可能恢复默认值。", true);
    }
  }
  const { segments, validation, visibleError, rowErrors } =
    inspectSegmentInputs(rows, task.duration_ms);
  const saveProgress = busy
    ? "正在处理，请稍候…"
    : recovery
      ? "等待选择本机草稿"
      : pendingSubmit
        ? "等待确认提交结果"
        : conflict
          ? "版本冲突，自动保存已暂停"
          : savePaused
            ? "自动保存已暂停，请核对后立即保存"
            : dirty && autoSave && !validation
              ? "等待自动保存…"
              : "";
  const total = segments.reduce((sum, s) => sum + s.end_ms - s.start_ms, 0);
  const markTargetIndex = rows.findIndex((row) => row.key === markTarget);
  const markLabel =
    markTarget === null
      ? "新建片段"
      : `重新标记片段 ${String(markTargetIndex + 1).padStart(2, "0")}`;
  const markConflicts =
    markIn === null
      ? []
      : selectionConflicts(
          rows,
          markTarget,
          markIn,
          currentTime,
          task.duration_ms,
        );
  let markIssue = "";
  if (markIn !== null && (markAttempted || markConflicts.length)) {
    try {
      applyMarkedRange(
        rows,
        markTarget,
        markIn,
        currentTime,
        task.duration_ms,
        "preview-only",
      );
    } catch (e) {
      markIssue = errorText(e);
    }
  }
  function adopt(value: TaskDetailData) {
    const next = rowsFor(value);
    setTask(value);
    setRows(next);
    setBaseline(content(next));
    setBaseRevision(value.revision);
    setConflict(false);
    setSavePaused(false);
    setPendingSubmit(false);
    setMarkIn(null);
    setMarkTarget(null);
    setMarkAttempted(false);
    setSelected(null);
    undo.current = [];
    redo.current = [];
    setHistorySize({ undo: 0, redo: 0 });
    try {
      localStorage.removeItem(backupKey);
    } catch {
      /* status shown by backup effect */
    }
    client.setQueryData(["task-detail", session.user.id, task.id], value);
    void client.invalidateQueries({ queryKey: ["tasks"] });
    void client.invalidateQueries({ queryKey: ["stats"] });
    if (value.status === "submitted")
      void client.invalidateQueries({
        queryKey: ["personal-stats", session.user.id],
      });
  }
  async function act(
    action: "claim" | "save" | "submit" | "reload",
    automatic = false,
  ) {
    if (requestBusy.current || recovery) return;
    if ((action === "save" || action === "submit") && (!canEdit || conflict))
      return;
    if (action === "save" && pendingSubmit) return;
    if ((action === "save" || action === "submit") && validation) {
      setMessage(validation, true);
      return;
    }
    if (action === "submit" && !segments.length) {
      setMessage("至少添加一个有效片段后才能提交", true);
      return;
    }
    if (action === "submit" && markIn !== null) {
      setMessage("还有未完成的选段，请先标记终点或取消选段", true);
      return;
    }
    if (
      action === "submit" &&
      !window.confirm(
        `提交 ${segments.length} 个片段，有效时长 ${durationLabel(total)}？提交后不可修改。`,
      )
    )
      return;
    if (
      action === "reload" &&
      hasPending &&
      !window.confirm("重新载入将放弃本页未保存的修改，是否继续？")
    )
      return;
    requestBusy.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const path = `/tasks/${task.id}`;
      const value =
        action === "reload"
          ? await api<TaskDetailData>(path)
          : await api<TaskDetailData>(
              `${path}/${action === "save" ? "segments" : action}`,
              {
                method: action === "save" ? "PUT" : "POST",
                headers: {
                  "X-CSRF-Token": session.csrf_token,
                  "Content-Type": "application/json",
                },
                body:
                  action === "claim"
                    ? undefined
                    : JSON.stringify({
                        expected_revision: baseRevision,
                        segments,
                      }),
              },
            );
      if (action === "save") {
        // Preserve row keys, input formatting and undo history across an autosave.
        setTask(value);
        setBaseline(content(rows));
        setBaseRevision(value.revision);
        setSavePaused(false);
        client.setQueryData(["task-detail", session.user.id, task.id], value);
        void client.invalidateQueries({ queryKey: ["tasks"] });
      } else adopt(value);
      if (action === "submit" && value.status === "submitted") {
        video.current?.pause();
        setCelebration(value);
      }
      setMessage(
        {
          claim: "领取成功，可以开始标注",
          save: `${automatic ? "已自动保存到服务器" : "已保存到服务器"} · ${new Date().toLocaleTimeString()}`,
          submit: "",
          reload: "已载入最新保存内容",
        }[action],
      );
    } catch (e) {
      setError(errorText(e));
      setSavePaused(true);
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      if (
        action === "submit" &&
        (!(e instanceof ApiError) || e.status === 0 || e.status >= 500)
      ) {
        setPendingSubmit(true);
        setError(
          "提交结果暂未确认，当前内容已保留。请重试相同提交或载入服务端状态，避免再次编辑。",
        );
      }
      if (e instanceof ApiError && e.status === 401) onExpired();
    } finally {
      requestBusy.current = false;
      setBusy(false);
    }
  }
  const actionRef = useRef(act);
  useEffect(() => {
    actionRef.current = act;
  });
  useEffect(() => {
    if (
      !canEdit ||
      !autoSave ||
      !dirty ||
      busy ||
      validation ||
      conflict ||
      savePaused ||
      recovery ||
      pendingSubmit ||
      gesture
    )
      return;
    const timer = window.setTimeout(
      () => void actionRef.current("save", true),
      1500,
    );
    return () => window.clearTimeout(timer);
  }, [
    canEdit,
    autoSave,
    dirty,
    busy,
    validation,
    conflict,
    savePaused,
    recovery,
    pendingSubmit,
    gesture,
    rows,
  ]);
  useEffect(() => {
    if (!gesture) return;
    const end = () => setGesture(false);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [gesture]);
  useEffect(() => {
    if (!playing) return;
    let frame: number;
    const check = () => {
      const player = video.current;
      if (
        player &&
        previewEnd.current !== null &&
        player.currentTime * 1000 >= previewEnd.current
      ) {
        player.pause();
        player.currentTime = previewEnd.current / 1000;
        setCurrentTime(previewEnd.current);
        previewEnd.current = null;
      } else frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  function changeRows(next: Row[], group = "") {
    if (!canChange || requestBusy.current || content(next) === content(rows))
      return;
    const now = Date.now();
    if (
      !group ||
      group !== lastEdit.current.group ||
      now - lastEdit.current.at > 750
    ) {
      undo.current = [...undo.current, rows].slice(-100);
    }
    lastEdit.current = { group, at: now };
    redo.current = [];
    setHistorySize({ undo: undo.current.length, redo: 0 });
    if (markTarget !== null && !next.some((row) => row.key === markTarget)) {
      setMarkIn(null);
      setMarkTarget(null);
      setMarkAttempted(false);
    }
    setRows(next);
    setMessage("");
    if (!conflict) setError("");
  }
  function travel(direction: "undo" | "redo") {
    if (!canChange || requestBusy.current) return;
    const from = direction === "undo" ? undo : redo;
    const to = direction === "undo" ? redo : undo;
    const next = from.current.pop();
    if (!next) return;
    setMarkIn(null);
    setMarkTarget(null);
    setMarkAttempted(false);
    to.current.push(rows);
    lastEdit.current = { group: "", at: 0 };
    setRows(next);
    setHistorySize({ undo: undo.current.length, redo: redo.current.length });
    setMessage(
      direction === "undo" ? "已撤销，可恢复撤销" : "已恢复撤销的编辑",
    );
  }
  function restartAnnotation() {
    if (!canChange || requestBusy.current || (!rows.length && markIn === null))
      return;
    if (
      !window.confirm(
        `确定清空当前 ${rows.length} 个片段并重新标注？清空片段后可以撤销。`,
      )
    )
      return;
    changeRows([]);
    setMarkIn(null);
    setMarkTarget(null);
    setMarkAttempted(false);
    setSelected(null);
    previewEnd.current = null;
    setMessage(
      rows.length
        ? "已清空全部片段，可以重新标注；可撤销本次清空。"
        : "已取消选段，可以重新标注。",
    );
  }
  function update(key: string, field: "start" | "end", value: string) {
    changeRows(
      rows.map((r) => (r.key === key ? { ...r, [field]: value } : r)),
      `${key}:${field}`,
    );
    setSelected(key);
  }
  function seek(ms: number) {
    previewEnd.current = null;
    if (!mediaReady || !video.current) return;
    const at = Math.max(0, Math.min(task.duration_ms, ms));
    video.current.currentTime = at / 1000;
    setCurrentTime(at);
  }
  function seekTimeline(ms: number) {
    video.current?.pause();
    seek(ms);
  }
  function goToBoundary(field: "in" | "out") {
    if (field === "in" && markIn !== null) {
      seekTimeline(markIn);
      return;
    }
    const row = rows.find((item) => item.key === selected);
    if (!row) return;
    try {
      seekTimeline(parseSeconds(field === "in" ? row.start : row.end));
    } catch {
      /* An unfinished field cannot be used as a navigation target. */
    }
  }
  function togglePlay() {
    if (!mediaReady || !video.current) return;
    previewEnd.current = null;
    if (video.current.paused)
      void video.current.play().catch((e) => setMessage(errorText(e), true));
    else video.current.pause();
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === fullscreenRoot.current)
        await document.exitFullscreen();
      else await fullscreenRoot.current?.requestFullscreen();
    } catch {
      setMessage("暂时无法切换全屏，请重试", true);
    }
  }
  useEffect(() => {
    const changed = () =>
      setFullscreen(document.fullscreenElement === fullscreenRoot.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  function mark(field: "in" | "out") {
    if (!canChange || !mediaReady || requestBusy.current || !video.current)
      return;
    const at = videoMilliseconds(video.current.currentTime, task.duration_ms);
    if (field === "in") {
      const target =
        markIn === null ? targetAt(rows, at, task.duration_ms) : markTarget;
      if (target === null && rows.length >= 1000) {
        setMessage(
          "单个任务最多支持 1000 个片段；仍可在已有片段内重新标记",
          true,
        );
        return;
      }
      setMarkIn(at);
      setMarkTarget(target);
      setMarkAttempted(false);
      setSelected(target);
      setCurrentTime(at);
      if (!conflict) setError("");
      setMessage(
        target === null
          ? "新片段起点已标记，按 O 完成选段"
          : `正在重新标记片段 ${String(rows.findIndex((row) => row.key === target) + 1).padStart(2, "0")}，按 O 替换，Alt / Option + X 取消`,
      );
      return;
    }
    if (markIn === null) {
      setMessage("请先按 I 或点击标记起点", true);
      return;
    }
    setMarkAttempted(true);
    try {
      const result = applyMarkedRange(
        rows,
        markTarget,
        markIn,
        at,
        task.duration_ms,
        crypto.randomUUID(),
      );
      changeRows(result.rows);
      setSelected(result.key);
      setMarkIn(null);
      setMarkTarget(null);
      setMarkAttempted(false);
      setMessage(
        markTarget === null
          ? "已添加片段，可撤销"
          : "已替换原片段起终点，可撤销",
      );
    } catch (e) {
      setMessage(errorText(e), true);
    }
  }
  function cancelSelection() {
    if (!canChange || requestBusy.current) return;
    setMarkIn(null);
    setMarkTarget(null);
    setMarkAttempted(false);
    if (!conflict) setError("");
    setMessage("已取消选段");
  }
  function preview(row: Row) {
    if (!mediaReady || !video.current) return;
    try {
      const [segment] = validateSegments(
        [{ start_ms: parseSeconds(row.start), end_ms: parseSeconds(row.end) }],
        task.duration_ms,
      );
      seek(segment.start_ms);
      previewEnd.current = segment.end_ms;
      setSelected(row.key);
      void video.current.play().catch((e) => setMessage(errorText(e), true));
    } catch (e) {
      setMessage(errorText(e), true);
    }
  }
  function exportDraft() {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            task_id: task.id,
            expected_revision: baseRevision,
            rows,
            markIn,
            markTarget,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `annotation-draft-${task.id}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function resolveRecovery(restore: boolean) {
    if (!recovery) return;
    try {
      if (restore) {
        localStorage.setItem(
          backupKey,
          JSON.stringify({
            ...recovery.draft,
            savedAt: new Date().toISOString(),
          }),
        );
        setRows(recovery.draft.rows);
        setBaseRevision(recovery.draft.revision);
        setMarkIn(recovery.draft.markIn);
        setMarkTarget(recovery.draft.markTarget ?? null);
        setMarkAttempted(false);
        setPendingSubmit(recovery.draft.pendingSubmit);
        setSavePaused(true);
        if (recovery.draft.revision !== task.revision) {
          setConflict(true);
          setError(
            "本机草稿与服务端版本不同，自动保存已暂停。请导出本机草稿后载入服务端内容，再核对修改。",
          );
        } else
          setMessage(
            "已恢复本机草稿。核对后点击立即保存或提交；自动保存暂时暂停。",
          );
      }
      localStorage.removeItem(recovery.key);
      setRecovery(null);
    } catch {
      setStorageError("无法操作本机备份，请检查浏览器存储设置；原备份保留。");
    }
  }
  useEffect(() => {
    const selectionControls =
      ".segment-row, .timeline-segment, .timeline-handle, .timeline-boundaries, button, input, select, textarea, a, summary, [role='dialog'], [data-theme-control]";
    let startedOnControl = false;
    const rememberPointer = (event: PointerEvent) => {
      startedOnControl =
        event.target instanceof Element &&
        !!event.target.closest(selectionControls);
    };
    const dismissSelection = (event: MouseEvent) => {
      const preserveGesture = event.detail !== 0 && startedOnControl;
      startedOnControl = false;
      // On narrow screens, focusing a row can expand the editor above it and
      // move the row before pointer-up. Preserve the original control gesture.
      if (preserveGesture) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Keep selection while editing a row, dragging a handle or using tools.
      // Use click (after blur) so pending seconds input commits before closing.
      if (target.closest(selectionControls)) return;
      if (!target.closest("[data-shortcut-context]")) {
        if (document.activeElement instanceof HTMLElement)
          document.activeElement.blur();
        setShortcutArea("video");
      }
      setSelected(null);
    };
    window.addEventListener("pointerdown", rememberPointer, true);
    window.addEventListener("click", dismissSelection);
    return () => {
      window.removeEventListener("pointerdown", rememberPointer, true);
      window.removeEventListener("click", dismissSelection);
    };
  }, []);
  useEffect(() => {
    const updateContext = (event: FocusEvent) => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        target.closest(
          "#workspace-shortcuts, [aria-controls='workspace-shortcuts'], [data-theme-control]",
        )
      )
        return;
      setShortcutArea(
        shortcutContext(target) === "timeline" ? "timeline" : "video",
      );
    };
    window.addEventListener("focusin", updateContext);
    return () => window.removeEventListener("focusin", updateContext);
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (celebration) return;
      if (
        event.target instanceof Element &&
        event.target.closest("[data-theme-control]")
      )
        return;
      // Space is reserved for video playback across the entire workspace.
      // Capture it before typing/control defaults, and suppress held repeats.
      if ((event.code === "Space" || event.key === " ") && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        if (
          !event.repeat &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !event.shiftKey
        )
          togglePlay();
        return;
      }
      // Saving/recovery locks edits through canChange, not playback navigation.
      if (
        event.defaultPrevented ||
        (event.repeat &&
          event.key !== "ArrowLeft" &&
          event.key !== "ArrowRight") ||
        event.isComposing
      )
        return;
      const key = event.key.toLowerCase();
      const modifier = event.ctrlKey || event.metaKey;
      const handled = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (
        event.altKey &&
        !modifier &&
        !event.shiftKey &&
        (event.code === "KeyX" || key === "x")
      ) {
        if (!isTypingTarget(event.target)) {
          handled();
          if (markIn !== null) cancelSelection();
        }
        return;
      }
      if (event.altKey || (event.ctrlKey && event.metaKey)) return;
      if (modifier && !event.shiftKey && key === "s" && canChange) {
        handled();
        void act("save");
        return;
      }
      if (isTypingTarget(event.target)) return;
      if (modifier) {
        if (key === "z" && canChange) {
          handled();
          travel(event.shiftKey ? "redo" : "undo");
        }
        if (key === "y" && !event.shiftKey && canChange) {
          handled();
          travel("redo");
        }
        return;
      }
      const target = event.target;
      const context = shortcutContext(target);
      // Volume keeps native arrows; the video overview handles its own seek keys.
      if (
        target instanceof HTMLInputElement &&
        target.closest(".volume-tools, .video-progress") &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      )
        return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        // Timeline sliders handle their own values through React callbacks.
        if (
          target instanceof HTMLInputElement &&
          target.type === "range" &&
          context === "timeline"
        )
          return;
        handled();
        if (context === "timeline") {
          if (!frames.length) return;
          seekTimeline(
            stepFrame(
              frames,
              (video.current?.currentTime ?? 0) * 1000,
              event.key === "ArrowLeft" ? -1 : 1,
              event.shiftKey ? 5 : 1,
            ),
          );
          return;
        }
        const delta =
          seekIncrement(task.duration_ms, event.shiftKey) *
          (event.key === "ArrowLeft" ? -1 : 1);
        seek((video.current?.currentTime ?? 0) * 1000 + delta);
      }
      if ((key === "i" || key === "o") && event.shiftKey) {
        handled();
        goToBoundary(key === "i" ? "in" : "out");
        return;
      }
      if ((key === "i" || key === "o") && !event.shiftKey && canChange) {
        handled();
        mark(key === "i" ? "in" : "out");
      }
      if (key === "escape" && !event.shiftKey) {
        if (document.fullscreenElement === fullscreenRoot.current) {
          handled();
          void document
            .exitFullscreen()
            .catch(() =>
              setMessage("暂时无法退出全屏，请使用退出按钮重试", true),
            );
        }
      }
    };
    const keyup = (event: KeyboardEvent) => {
      if (celebration) return;
      if (
        event.target instanceof Element &&
        event.target.closest("[data-theme-control]")
      )
        return;
      if ((event.code === "Space" || event.key === " ") && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keyup", keyup, true);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup, true);
    };
  });
  return (
    <>
      <header className="editor-header">
        <div className="editor-title">
          <Button variant="ghost" className="editor-back" onClick={onBack}>
            <ArrowLeft size={17} />
            <span>{backLabel}</span>
          </Button>
          <div className="editor-title-text">
            <h1>{task.title}</h1>
            <p>
              {task.tenant_name} ·{" "}
              <span className="mono">{durationLabel(task.duration_ms)}</span>
            </p>
          </div>
          <span className={`status-badge ${task.status}`}>
            {labels[task.status]}
          </span>
        </div>
        {canEdit && (
          <div className="editor-toolbar">
            <div className="editor-history">
              <Button
                size="sm"
                variant="ghost"
                disabled={!canChange || !historySize.undo}
                onClick={() => travel("undo")}
              >
                <Undo2 size={15} />
                撤销
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!canChange || !historySize.redo}
                onClick={() => travel("redo")}
              >
                <Redo2 size={15} />
                恢复撤销
              </Button>
            </div>
            <div className="editor-save-actions">
              <Button
                variant="outline"
                disabled={
                  busy ||
                  !!validation ||
                  conflict ||
                  !!recovery ||
                  pendingSubmit
                }
                onClick={() => void act("save")}
              >
                <Save size={16} />
                {savePaused && error && !conflict ? "重试保存" : "立即保存"}
              </Button>
              <Button
                disabled={
                  busy ||
                  !!validation ||
                  !rows.length ||
                  conflict ||
                  !!recovery ||
                  markIn !== null
                }
                onClick={() => void act("submit")}
              >
                <Send size={16} />
                {pendingSubmit ? "重试相同提交" : "提交任务"}
              </Button>
            </div>
          </div>
        )}
      </header>
      {error && (
        <div className="notice notice-error" role="alert">
          {error}
          {conflict && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void act("reload")}
            >
              重新载入
            </Button>
          )}
        </div>
      )}
      {storageError && (
        <div className="notice notice-error" role="alert">
          {storageError}
        </div>
      )}
      {recovery && (
        <div className="notice recovery-notice" role="alert">
          <div>
            <strong>发现本机未同步草稿</strong>
            <p>
              备份时间：{dateLabel(recovery.draft.savedAt)}
              。请先选择恢复，或放弃这份备份并使用服务端内容。
            </p>
          </div>
          <Button size="sm" onClick={() => resolveRecovery(true)}>
            恢复本机草稿
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => resolveRecovery(false)}
          >
            使用服务端内容
          </Button>
        </div>
      )}
      {pendingSubmit && (
        <div className="notice notice-error" role="alert">
          提交结果尚未确认，编辑和自动保存已暂停；可点击“重试相同提交”，或载入服务端状态。
        </div>
      )}
      <div className="annotation-grid">
        <div>
          <div className="player-workspace" ref={fullscreenRoot}>
            {celebration && (
              <SubmissionCelebration
                task={celebration}
                session={session}
                onClose={() => setCelebration(null)}
                onBack={onBack}
              />
            )}
            <section
              className="video-panel"
              data-shortcut-context="video"
              onPointerDown={(event) => {
                if (
                  event.target instanceof Element &&
                  !event.target.closest(
                    "button, input, select, summary, details",
                  )
                )
                  video.current?.focus({ preventScroll: true });
              }}
            >
              <video
                ref={video}
                tabIndex={0}
                aria-label="任务视频播放器"
                onVolumeChange={() => {
                  if (video.current) {
                    setVolume(video.current.volume);
                    setMuted(video.current.muted);
                  }
                }}
                preload="metadata"
                playsInline
                src={`/api/tasks/${task.id}/video`}
                onError={() => {
                  setVideoError(true);
                  setMediaReady(false);
                }}
                onLoadedMetadata={() => {
                  setVideoError(false);
                  setMediaReady(true);
                }}
                onTimeUpdate={() =>
                  setCurrentTime(
                    videoMilliseconds(
                      video.current?.currentTime ?? 0,
                      task.duration_ms,
                    ),
                  )
                }
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => {
                  setPlaying(false);
                  previewEnd.current = null;
                }}
                onSeeking={() => {
                  if (
                    previewEnd.current !== null &&
                    (video.current?.currentTime ?? 0) * 1000 >=
                      previewEnd.current
                  )
                    previewEnd.current = null;
                }}
              />
              {videoError && (
                <div className="notice notice-error" role="alert">
                  视频加载失败
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => video.current?.load()}
                  >
                    重试
                  </Button>
                </div>
              )}

              <VideoProgress
                rows={rows}
                duration={task.duration_ms}
                current={currentTime}
                selected={selected}
                disabled={!mediaReady}
                onSeek={seekTimeline}
              />
              <div className="playback-tools">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!mediaReady}
                  onClick={togglePlay}
                  className="play-toggle"
                  aria-label={playing ? "暂停" : "播放"}
                >
                  {playing ? <Pause size={15} /> : <Play size={15} />}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!mediaReady}
                  onClick={() => seek(currentTime - 1000)}
                  aria-label="后退 1 秒"
                >
                  -1s
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!mediaReady}
                  onClick={() => seek(currentTime + 1000)}
                  aria-label="前进 1 秒"
                >
                  +1s
                </Button>
                <span className="playback-time mono">
                  {durationLabel(currentTime)}{" "}
                  <span className="muted">
                    / {durationLabel(task.duration_ms)}
                  </span>
                </span>
                <label className="playback-rate">
                  <span className="sr-only">播放速度</span>
                  <select
                    aria-label="播放速度"
                    defaultValue="1"
                    onChange={(event) => {
                      if (video.current)
                        video.current.playbackRate = Number(event.target.value);
                    }}
                  >
                    {[0.25, 0.5, 1, 1.5, 2].map((rate) => (
                      <option key={rate} value={rate}>
                        {rate}×
                      </option>
                    ))}
                  </select>
                </label>
                <div className="volume-tools">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={muted ? "取消静音" : "静音"}
                    disabled={!mediaReady}
                    onClick={() => {
                      if (video.current)
                        video.current.muted = !video.current.muted;
                    }}
                  >
                    {muted || volume === 0 ? (
                      <VolumeX size={17} />
                    ) : (
                      <Volume2 size={17} />
                    )}
                  </Button>
                  <input
                    type="range"
                    aria-label="音量"
                    min="0"
                    max="1"
                    step="0.05"
                    value={muted ? 0 : volume}
                    disabled={!mediaReady}
                    onChange={(event) => {
                      if (video.current) {
                        video.current.volume = Number(event.target.value);
                        video.current.muted = false;
                      }
                    }}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={fullscreen ? "退出全屏" : "全屏播放"}
                  title={fullscreen ? "退出全屏" : "全屏播放"}
                  disabled={!mediaReady}
                  onClick={() => void toggleFullscreen()}
                >
                  {fullscreen ? <Minimize size={17} /> : <Maximize size={17} />}
                </Button>
                {fullscreen && <ThemeToggle compact />}
              </div>
              {canEdit && (
                <div className="quick-selection">
                  <div className="annotation-actions">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canChange || !mediaReady}
                      onClick={() => mark("in")}
                    >
                      <Flag size={17} />
                      标记起点 <kbd>I</kbd>
                    </Button>
                    <Button
                      variant="outline"
                      className="mark-out"
                      size="sm"
                      disabled={!canChange || !mediaReady || markIn === null}
                      onClick={() => mark("out")}
                    >
                      <Flag size={17} />
                      {markTarget === null
                        ? "标记终点并添加"
                        : "标记终点并替换"}{" "}
                      <kbd>O</kbd>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-controls="workspace-shortcuts"
                      aria-expanded={shortcutsOpen}
                      onClick={() => setShortcutsOpen((open) => !open)}
                    >
                      <Keyboard size={17} />
                      快捷键
                    </Button>
                    {markIn !== null && (
                      <Button
                        variant="outline"
                        className="cancel-selection"
                        aria-label="取消选段"
                        aria-keyshortcuts="Alt+X"
                        size="sm"
                        disabled={!canChange}
                        onClick={cancelSelection}
                      >
                        <X size={17} />
                        取消选段 <kbd>Alt / ⌥ + X</kbd>
                      </Button>
                    )}
                  </div>
                  <p
                    className={markIn === null ? "sr-only" : "field-help"}
                    role="status"
                  >
                    {markIn === null
                      ? "播放到有用动作开始处标记起点，再标记终点生成片段。"
                      : `${markLabel} · 起点 ${durationLabel(markIn)}；按 O ${markTarget === null ? "添加" : "替换"}，Alt / Option + X 取消，原片段在确认前保持不变。`}
                  </p>
                </div>
              )}
              <details
                id="workspace-shortcuts"
                className={`shortcut-help ${canEdit ? "player-shortcut-help" : ""}`}
                open={shortcutsOpen}
                onToggle={(event) => setShortcutsOpen(event.currentTarget.open)}
              >
                <summary>快捷键与操作说明</summary>
                <ShortcutHelp editable={canEdit} context={shortcutArea} />
              </details>
            </section>
            <AnnotationTimeline
              rows={rows}
              duration={task.duration_ms}
              current={currentTime}
              markIn={markIn}
              pendingLabel={markLabel}
              pendingIssue={markIssue}
              conflictKeys={markConflicts.map((row) => row.key)}
              selected={selected}
              editable={canEdit}
              disabled={!canChange}
              frames={frames}
              frameLoading={frameQuery.isPending}
              frameError={
                frameQuery.isError
                  ? "暂时无法读取视频帧，仍可拖动或输入秒数定位。"
                  : ""
              }
              onRetryFrames={() => void frameQuery.refetch()}
              onSeek={seekTimeline}
              onSelect={setSelected}
              onGesture={setGesture}
              onChange={(key, start, end) =>
                changeRows(
                  rows.map((row) =>
                    row.key === key ? { ...row, start, end } : row,
                  ),
                  `timeline:${key}`,
                )
              }
            />
            {message.text && (
              <div
                key={message.id}
                className={`action-toast${message.warning ? " action-toast-warning" : ""}`}
                role={message.warning ? "alert" : "status"}
                aria-atomic="true"
              >
                {message.warning ? (
                  <AlertCircle size={18} aria-hidden="true" />
                ) : (
                  <CheckCircle2 size={18} aria-hidden="true" />
                )}
                <span>{message.text}</span>
              </div>
            )}
          </div>

          <div className="task-metadata">
            <span>领取人：{task.assignee_name ?? "尚未领取"}</span>
            <span>创建：{dateLabel(task.created_at)}</span>
            {task.submitted_at && (
              <span>提交：{dateLabel(task.submitted_at)}（北京时间）</span>
            )}
            <span className="task-id">任务编号：{task.id}</span>
          </div>
        </div>
        <section className="annotation-panel">
          <div className="section-heading">
            <h2>{canEdit ? "片段标注" : "片段记录"}</h2>
            <span>{rows.length} 段</span>
          </div>
          {session.user.role === "annotator" && task.status === "available" && (
            <div className="empty-annotation">
              <p>领取任务后，可以添加有用的时间片段。</p>
              <Button disabled={busy} onClick={() => void act("claim")}>
                {busy ? "正在领取…" : "领取并开始标注"}
              </Button>
            </div>
          )}
          {canEdit && (
            <>
              <p className="field-help">
                填写起止秒数，最多三位小数；也可以用左侧 I / O 快捷选段。
              </p>
              <div className="editor-utilities">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canChange || (!rows.length && markIn === null)}
                  onClick={restartAnnotation}
                >
                  <RotateCcw size={15} />
                  重新标注
                </Button>
                <Button size="sm" variant="ghost" onClick={exportDraft}>
                  导出草稿
                </Button>
              </div>
            </>
          )}
          {!rows.length && task.status !== "available" && (
            <p className="empty-annotation">
              {canEdit
                ? "还没有片段，点击下方按钮开始添加。"
                : "尚未保存片段。"}
            </p>
          )}
          <div className="segment-list" ref={segmentList}>
            {rows.map((row, index) => (
              <div
                className={`segment-row ${selected === row.key ? "selected" : ""} ${markConflicts.some((item) => item.key === row.key) ? "selection-conflict" : ""}`}
                key={row.key}
                data-segment-key={row.key}
                onFocusCapture={() => setSelected(row.key)}
                onClickCapture={() => setSelected(row.key)}
              >
                <div className="segment-row-heading">
                  <button
                    type="button"
                    className="segment-select"
                    aria-pressed={selected === row.key}
                    onClick={() => setSelected(row.key)}
                  >
                    片段 {index + 1}
                  </button>
                  <div>
                    <Button
                      size="icon"
                      variant="ghost"
                      title="定位到片段起点"
                      aria-label={`定位片段 ${index + 1}`}
                      onClick={() => {
                        try {
                          const at = parseSeconds(row.start);
                          if (at > task.duration_ms)
                            throw new Error("起点超过视频时长");
                          seek(at);
                          setSelected(row.key);
                        } catch (e) {
                          setMessage(errorText(e), true);
                        }
                      }}
                    >
                      <MapPin size={15} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      title="预览片段，到终点自动暂停"
                      aria-label={`预览片段 ${index + 1}`}
                      disabled={!mediaReady}
                      onClick={() => preview(row)}
                    >
                      <Play size={15} />
                    </Button>
                    {canEdit && (
                      <Button
                        size="icon"
                        variant="ghost"
                        disabled={!canChange}
                        aria-label={`删除片段 ${index + 1}`}
                        onClick={() => {
                          const remaining = rows.filter(
                            (r) => r.key !== row.key,
                          );
                          changeRows(remaining);
                          setSelected(
                            remaining[Math.min(index, remaining.length - 1)]
                              ?.key ?? null,
                          );
                        }}
                      >
                        <Trash2 size={15} />
                      </Button>
                    )}
                  </div>
                </div>
                {canEdit ? (
                  <div className="segment-inputs">
                    <label>
                      起点（秒）
                      <input
                        inputMode="decimal"
                        aria-label={`片段 ${index + 1} 起点`}
                        aria-invalid={!!rowErrors[index]}
                        aria-describedby={
                          rowErrors[index]
                            ? `segment-error-${row.key}`
                            : undefined
                        }
                        value={row.start}
                        disabled={!canChange}
                        placeholder="0.000"
                        onChange={(e) =>
                          update(row.key, "start", e.target.value)
                        }
                      />
                    </label>
                    <span>→</span>
                    <label>
                      终点（秒）
                      <input
                        inputMode="decimal"
                        aria-label={`片段 ${index + 1} 终点`}
                        aria-invalid={!!rowErrors[index]}
                        aria-describedby={
                          rowErrors[index]
                            ? `segment-error-${row.key}`
                            : undefined
                        }
                        value={row.end}
                        disabled={!canChange}
                        placeholder="10.000"
                        onChange={(e) => update(row.key, "end", e.target.value)}
                      />
                    </label>
                  </div>
                ) : (
                  <div className="mono">
                    {durationLabel(parseSeconds(row.start))} →{" "}
                    {durationLabel(parseSeconds(row.end))}
                  </div>
                )}
                {canEdit && rowErrors[index] && (
                  <p className="segment-error" id={`segment-error-${row.key}`}>
                    {rowErrors[index]}
                  </p>
                )}
              </div>
            ))}
            {canEdit && (
              <Button
                className="add-segment"
                variant="outline"
                disabled={!canChange || rows.length >= 1000}
                onClick={() => {
                  const row = { key: crypto.randomUUID(), start: "", end: "" };
                  focusNewSegment.current = row.key;
                  changeRows([...rows, row]);
                  setSelected(row.key);
                }}
              >
                <Plus size={16} />
                添加片段
              </Button>
            )}
          </div>
          {canEdit && visibleError && (
            <p className="validation-text" role="alert">
              {visibleError}
            </p>
          )}
          <div className="annotation-total">
            <span>
              {task.status === "submitted" ? "有效时长" : "当前片段合计"}
            </span>
            <strong className="mono">
              {validation ? "—" : durationLabel(total)}
            </strong>
          </div>
          {canEdit ? (
            <>
              <label className="autosave-toggle">
                <input
                  type="checkbox"
                  aria-label="自动保存（停止编辑 1.5 秒后）"
                  checked={autoSave}
                  disabled={busy || !!recovery || pendingSubmit}
                  onChange={(event) => changeAutoSave(event.target.checked)}
                />
                <span>
                  自动保存<small>停止编辑 1.5 秒后同步</small>
                </span>
              </label>
              <p
                className="save-location"
                role="status"
                aria-label="草稿保存位置"
              >
                <strong>
                  {pendingSubmit
                    ? "服务器状态待确认"
                    : recovery
                      ? "仅有本机备份（待恢复的改动）"
                      : dirty
                        ? hasCurrentBackup
                          ? "仅有本机备份"
                          : "尚未保存到服务器"
                        : "已保存到服务器"}
                </strong>
                {markIn !== null && !dirty && !recovery && !pendingSubmit && (
                  <span>
                    {" "}
                    · 待完成选段
                    {hasCurrentBackup ? "仅有本机备份" : "尚未备份到本机"}
                  </span>
                )}
              </p>
              {saveProgress && (
                <p className="save-state" role="status">
                  {saveProgress}
                </p>
              )}

              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !!recovery}
                onClick={() => void act("reload")}
              >
                载入已保存内容
              </Button>
            </>
          ) : (
            task.status === "submitted" && (
              <p className="field-help">
                已提交，片段只读。有效时长归属提交当天（北京时间）。
              </p>
            )
          )}
        </section>
      </div>
    </>
  );
}
