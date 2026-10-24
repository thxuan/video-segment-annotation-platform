import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil, Upload, X } from "lucide-react";
import { api, ApiError, errorText } from "./api";
import { Button } from "./components/ui/button";
import type { Session, Tenant } from "./types";

type Props = {
  session: Session;
  onBack: () => void;
  onPublished: (id: string) => void;
  onExpired: () => void;
  onActivity: (dirty: boolean, busy: boolean) => void;
};
type UploadFilter = "all" | "pending" | "failed" | "succeeded" | "uncertain";
const filters: { value: UploadFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "pending", label: "待发布" },
  { value: "failed", label: "失败" },
  { value: "succeeded", label: "已发布" },
  { value: "uncertain", label: "待核对" },
];

type UploadStatus =
  "queued" | "uploading" | "succeeded" | "failed" | "uncertain";
type UploadItem = {
  id: string;
  file: File;
  title: string;
  status: UploadStatus;
  progress: number;
  message: string;
  taskId?: string;
};
type UploadResult = {
  status: "succeeded" | "failed" | "uncertain";
  message: string;
  taskId?: string;
  stop?: boolean;
  expired?: boolean;
};
const statusLabels: Record<UploadStatus, string> = {
  queued: "待发布",
  uploading: "正在上传",
  succeeded: "已发布",
  failed: "发布失败",
  uncertain: "结果待核对",
};

export function PublishTask({
  session,
  onBack,
  onPublished,
  onExpired,
  onActivity,
}: Props) {
  const client = useQueryClient();
  const [tenant, setTenant] = useState("");
  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<UploadFilter>("all");
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(
    null,
  );
  const queue = useRef<HTMLDivElement>(null);
  const request = useRef<XMLHttpRequest | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  const tenants = useQuery({
    queryKey: ["tenants", session.user.id],
    queryFn: () => api<Tenant[]>("/tenants"),
  });
  const dirty = items.length
    ? items.some((item) => item.status !== "succeeded")
    : !!tenant;
  const retryable = items.filter((item) =>
    ["queued", "failed"].includes(item.status),
  );
  const succeeded = items.filter((item) => item.status === "succeeded").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const uncertain = items.filter((item) => item.status === "uncertain").length;
  const counts: Record<UploadFilter, number> = {
    all: items.length,
    pending: items.filter(
      (item) => item.status === "queued" || item.status === "uploading",
    ).length,
    failed,
    succeeded,
    uncertain,
  };
  const visibleItems = items
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item }) =>
        filter === "all" ||
        (filter === "pending"
          ? item.status === "queued" || item.status === "uploading"
          : item.status === filter),
    );
  const uploading = items.find((item) => item.status === "uploading");

  useLayoutEffect(() => {
    const list = queue.current;
    const form = list?.closest("form");
    const actions = form?.querySelector<HTMLElement>(".publish-action-bar");
    if (!list || !form || !actions) return;
    let frame = 0;
    const updateHeight = () => {
      const viewport = window.visualViewport;
      const bottom = viewport
        ? viewport.offsetTop + viewport.height
        : window.innerHeight;
      const available = Math.max(
        96,
        Math.floor(
          bottom - list.getBoundingClientRect().top - actions.offsetHeight - 16,
        ),
      );
      const value = `${available}px`;
      if (list.style.getPropertyValue("--publish-list-space") !== value)
        list.style.setProperty("--publish-list-space", value);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateHeight);
    };
    updateHeight();
    const observer = new ResizeObserver(schedule);
    observer.observe(form);
    observer.observe(actions);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { passive: true });
    window.visualViewport?.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, []);

  useEffect(() => {
    if (tenants.error instanceof ApiError && tenants.error.status === 401)
      onExpired();
  }, [tenants.error, onExpired]);
  useEffect(() => {
    onActivity(dirty, busy);
    return () => onActivity(false, false);
  }, [dirty, busy, onActivity]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);

  function update(id: string, patch: Partial<UploadItem>) {
    if (mounted.current)
      setItems((current) =>
        current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      );
  }

  function upload(item: UploadItem): Promise<UploadResult> {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      request.current = xhr;
      const finish = (result: UploadResult) => {
        if (request.current === xhr) request.current = null;
        resolve(result);
      };
      const uncertainResult: UploadResult = {
        status: "uncertain",
        stop: true,
        message:
          "未能确认发布结果。请先在另一标签页的任务列表核对，再决定是否重试，避免重复发布。",
      };
      xhr.open(
        "POST",
        `/api/tasks?${new URLSearchParams({
          title: item.title.trim(),
          tenant_id: tenant,
        })}`,
      );
      xhr.setRequestHeader("X-CSRF-Token", session.csrf_token);
      xhr.setRequestHeader("Content-Type", "video/mp4");
      xhr.timeout = 10 * 60 * 1000;
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable)
          update(item.id, {
            progress: Math.round((event.loaded / event.total) * 100),
          });
      };
      xhr.onerror = xhr.ontimeout = xhr.onabort = () => finish(uncertainResult);
      xhr.onload = () => {
        let data: { id?: unknown; detail?: unknown } | null = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* Check status below. */
        }
        if (xhr.status === 201) {
          finish(
            typeof data?.id === "string"
              ? { status: "succeeded", taskId: data.id, message: "任务已创建" }
              : uncertainResult,
          );
        } else if (xhr.status >= 500 || xhr.status === 0) {
          finish(uncertainResult);
        } else {
          finish({
            status: "failed",
            message:
              typeof data?.detail === "string"
                ? data.detail
                : "发布失败，请检查视频与标题后重试。",
            stop: xhr.status === 401 || xhr.status === 403,
            expired: xhr.status === 401,
          });
        }
      };
      xhr.send(item.file);
    });
  }

  async function publish(candidates = retryable) {
    if (running.current) return;
    if (!tenant || !candidates.length) {
      setError("请选择租户和待发布的视频。");
      return;
    }
    const invalidTitle = candidates.find(
      (item) => !item.title.trim() || item.title.trim().length > 200,
    );
    if (invalidTitle) {
      setFilter("all");
      setEditing({ id: invalidTitle.id, title: invalidTitle.title });
      setError("每个视频都需要 1–200 个字符的任务标题。");
      return;
    }
    setEditing(null);
    running.current = true;
    setBusy(true);
    setStarted(true);
    setError("");
    try {
      for (const item of candidates) {
        if (!mounted.current) break;
        if (
          !item.file.name.toLowerCase().endsWith(".mp4") ||
          !item.file.size ||
          item.file.size > 512 * 1024 * 1024
        ) {
          update(item.id, {
            status: "failed",
            message: "请选择非空且不超过 512 MB 的 MP4 视频。",
          });
          continue;
        }
        update(item.id, { status: "uploading", progress: 0, message: "" });
        let result: UploadResult;
        try {
          result = await upload(item);
        } catch {
          result = {
            status: "uncertain",
            stop: true,
            message: "上传中断，请先核对任务列表再重试。",
          };
        }
        if (!mounted.current) break;
        update(item.id, {
          status: result.status,
          message: result.message,
          taskId: result.taskId,
          progress: result.status === "succeeded" ? 100 : 0,
        });
        if (result.status === "succeeded" || result.status === "uncertain")
          void client.invalidateQueries({ queryKey: ["tasks"] });
        if (result.stop) {
          setError(
            result.status === "uncertain"
              ? "本批次已暂停。请先核对结果待确认的视频，其余待发布项可稍后继续。"
              : result.expired
                ? "登录已过期，发布已停止。"
                : "请求校验失败，发布已停止，请确认当前登录状态。",
          );
          if (result.expired) onExpired();
          break;
        }
      }
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function clear() {
    if (
      dirty &&
      !window.confirm("清空列表后需要重新选择未发布的视频，确定继续吗？")
    )
      return;
    setItems([]);
    setFilter("all");
    setEditing(null);
    setStarted(false);
    setError("");
    if (input.current) input.current.value = "";
  }
  function remove(id: string) {
    if (editing?.id === id) setEditing(null);
    setItems((current) => current.filter((item) => item.id !== id));
    if (items.length === 1) {
      setStarted(false);
      if (input.current) input.current.value = "";
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void publish();
  }
  function openTask(id: string) {
    if (
      dirty &&
      !window.confirm(
        "还有未发布或待核对的视频，离开后需要重新选择，确定查看任务吗？",
      )
    )
      return;
    onActivity(false, false);
    onPublished(id);
  }

  return (
    <>
      <Button
        variant="ghost"
        className="back-button"
        disabled={busy}
        onClick={onBack}
      >
        <ArrowLeft size={16} />
        返回任务列表
      </Button>
      <div className="page-heading">
        <div>
          <h1>发布任务</h1>
          <p>选择一个或多个 MP4 视频，每个视频创建一个独立任务。</p>
        </div>
      </div>
      <form className="publish-form publish-queue" onSubmit={submit}>
        <div className="publish-setup">
          <label>
            所属租户
            <select
              required
              value={tenant}
              disabled={busy || started || !tenants.data}
              onChange={(event) => setTenant(event.target.value)}
            >
              <option value="">请选择租户</option>
              {tenants.data?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            {started && <small>本批次租户已固定，新建一批可更换。</small>}
          </label>
          <label className="upload-field publish-upload-field">
            <span>
              <Upload size={18} />
              选择视频
            </span>
            <input
              ref={input}
              type="file"
              accept="video/mp4,.mp4"
              multiple
              disabled={busy || started}
              onChange={(event) => {
                setError("");
                setFilter("all");
                setEditing(null);
                queue.current?.scrollTo({ top: 0 });
                setItems(
                  Array.from(event.target.files ?? [], (file) => ({
                    id: crypto.randomUUID(),
                    file,
                    title:
                      file.name.replace(/\.mp4$/i, "").slice(0, 200) ||
                      "视频任务",
                    status: "queued",
                    progress: 0,
                    message: "",
                  })),
                );
              }}
            />
            <small>可多选；每个视频最多 512 MB，按顺序上传。</small>
          </label>
        </div>
        {tenants.isError && (
          <div className="notice notice-error" role="alert">
            {errorText(tenants.error)}
            <Button
              type="button"
              variant="outline"
              onClick={() => void tenants.refetch()}
            >
              重试租户列表
            </Button>
          </div>
        )}
        <div className="publish-queue-toolbar">
          <div className="publish-queue-summary" role="status">
            <strong>
              共 {items.length} 个视频 · 已发布 {succeeded} 个
            </strong>
            <span>
              {uploading
                ? `正在发布：${uploading.title}`
                : items.length && succeeded === items.length
                  ? "全部发布完成"
                  : "标题默认取文件名，点击标题可修改。"}
            </span>
          </div>
          <div
            className="publish-filters"
            role="group"
            aria-label="按发布状态筛选"
          >
            {filters.map((option) => (
              <Button
                key={option.value}
                type="button"
                size="sm"
                variant={filter === option.value ? "default" : "ghost"}
                aria-pressed={filter === option.value}
                onClick={() => {
                  setFilter(option.value);
                  setEditing(null);
                  queue.current?.scrollTo({ top: 0 });
                }}
              >
                {option.label}
                <span>{counts[option.value]}</span>
              </Button>
            ))}
          </div>
        </div>
        <div
          ref={queue}
          className="publish-list-scroll"
          role="region"
          aria-label="视频发布列表"
          tabIndex={0}
        >
          {!visibleItems.length ? (
            <div className="publish-list-empty">
              {items.length
                ? "当前筛选下没有视频。"
                : "选择视频后将在这里显示，可逐项编辑标题并查看发布进度。"}
            </div>
          ) : (
            <ol className="publish-file-list">
              {visibleItems.map(({ item, index }) => (
                <li
                  key={item.id}
                  className={`publish-item publish-item-${item.status}`}
                >
                  <span className="publish-item-index">{index + 1}</span>
                  <div className="publish-item-main">
                    {editing?.id === item.id && !busy ? (
                      <input
                        autoFocus
                        required
                        maxLength={200}
                        value={item.title}
                        aria-label={`任务 ${index + 1} 标题`}
                        onChange={(event) =>
                          update(item.id, { title: event.target.value })
                        }
                        onBlur={() => setEditing(null)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            event.currentTarget.blur();
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            update(item.id, { title: editing.title });
                            setEditing(null);
                          }
                        }}
                      />
                    ) : item.status === "queued" || item.status === "failed" ? (
                      <button
                        type="button"
                        className="publish-title-button"
                        disabled={busy}
                        aria-label={`编辑任务 ${index + 1} 标题`}
                        title={item.title}
                        onClick={() =>
                          setEditing({ id: item.id, title: item.title })
                        }
                      >
                        <strong>{item.title || "点击设置标题"}</strong>
                        <Pencil size={13} />
                      </button>
                    ) : (
                      <strong className="publish-item-title" title={item.title}>
                        {item.title}
                      </strong>
                    )}
                    <span className="publish-item-file" title={item.file.name}>
                      <span>{item.file.name}</span>
                      <span>
                        {(item.file.size / 1024 / 1024).toFixed(2)} MB
                      </span>
                    </span>
                    {item.status === "uploading" && (
                      <progress
                        max={100}
                        value={item.progress}
                        aria-label={`${item.file.name} 上传进度`}
                      />
                    )}
                  </div>
                  <span className="publish-item-status">
                    {item.status === "uploading"
                      ? item.progress < 100
                        ? `上传 ${item.progress}%`
                        : "校验中…"
                      : statusLabels[item.status]}
                  </span>
                  <div className="publish-item-actions">
                    {item.status === "failed" && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void publish([item])}
                      >
                        重试
                      </Button>
                    )}
                    {item.status === "uncertain" && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              "请先在另一标签页核对任务列表。确定该视频尚未发布？如果已存在，再次上传会创建重复任务。",
                            )
                          )
                            void publish([item]);
                        }}
                      >
                        核对后重试
                      </Button>
                    )}
                    {item.taskId && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => openTask(item.taskId!)}
                      >
                        查看任务
                      </Button>
                    )}
                    {(item.status === "queued" || item.status === "failed") && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={busy}
                        aria-label={`移除 ${item.file.name}`}
                        onClick={() => remove(item.id)}
                      >
                        <X size={16} />
                      </Button>
                    )}
                  </div>
                  {(item.status === "failed" || item.status === "uncertain") &&
                    item.message && (
                      <details className="publish-item-details">
                        <summary>
                          {item.status === "uncertain"
                            ? "核对说明"
                            : "错误详情"}
                        </summary>
                        <p>{item.message}</p>
                      </details>
                    )}
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="publish-action-bar">
          {error && (
            <div className="notice notice-error" role="alert">
              {error}
            </div>
          )}
          <div className="publish-action-content">
            <span role="status">
              {busy ? "正在发布…" : `已发布 ${succeeded} / ${items.length}`}
            </span>
            <div className="publish-action-buttons">
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={onBack}
              >
                返回任务列表
              </Button>
              {!!items.length && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={clear}
                >
                  新建一批
                </Button>
              )}
              {!!failed && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void publish(
                      items.filter((item) => item.status === "failed"),
                    )
                  }
                >
                  重试失败项（{failed}）
                </Button>
              )}
              <Button
                type="submit"
                disabled={busy || !tenants.data || !retryable.length}
              >
                {busy ? "正在发布…" : "发布任务"}
              </Button>
            </div>
          </div>
        </div>
      </form>
    </>
  );
}
