import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  BarChart3,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Film,
  FolderOpen,
  Layers3,
  Loader2,
  LogOut,
  Play,
  RotateCcw,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import {
  api,
  ApiError,
  dateLabel,
  durationLabel,
  errorText,
  fetchSession,
} from "./api";
import { Button } from "./components/ui/button";
import { TaskWorkspace } from "./TaskWorkspace";
import { TaskNavigation } from "./TaskNavigation";
import { PublishTask } from "./PublishTask";
import { readWorkspacePage, workspacePageKey } from "./workspace-memory";
import type { WorkspacePage } from "./workspace-memory";
import { Statistics } from "./Statistics";
import { PersonalStatistics } from "./PersonalStatistics";
import { ThemeToggle } from "./ThemeToggle";
import type { Session, TaskPage, TaskStatus, Tenant } from "./types";

const statusLabels: Record<TaskStatus, string> = {
  available: "待领取",
  in_progress: "标注中",
  submitted: "已提交",
};

function Brand() {
  return (
    <div className="brand">
      <span className="brand-icon">
        <Layers3 size={22} strokeWidth={1.6} />
      </span>
      <span className="brand-name">
        片段<span className="brand-dot">.</span>
        <small>视频标注工作区</small>
      </span>
    </div>
  );
}

function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={`notice ${error ? "notice-error" : ""}`}
      role={error ? "alert" : "status"}
    >
      <AlertCircle size={16} />
      <span>{children}</span>
    </div>
  );
}

function Loading({ text = "正在加载…" }: { text?: string }) {
  return (
    <div className="state-panel" role="status">
      <Loader2 className="animate-spin" size={24} />
      <p>{text}</p>
    </div>
  );
}

function ErrorState({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="state-panel" role="alert">
      <AlertCircle size={28} />
      <h3>暂时无法加载</h3>
      <p>{errorText(error)}</p>
      <Button variant="outline" onClick={retry}>
        <RotateCcw size={15} />
        重试
      </Button>
    </div>
  );
}

function Login({
  notice,
  onLogin,
}: {
  notice: string;
  onLogin: (session: Session) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      api<Session>("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      }),
    onSuccess: onLogin,
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate();
  }
  return (
    <main className="login-shell">
      <div className="login-theme">
        <ThemeToggle />
      </div>
      <section className="login-story">
        <Brand />
        <div className="story-body">
          <span className="eyebrow">每一个有价值的片段，都值得被看见</span>
          <h1>
            专注每一帧，
            <br />
            留下有用的瞬间。
          </h1>
          <p>
            从视频中发现有价值的动作，
            <br className="desktop-break" />
            在清晰、有序的工作区里完成标注。
          </p>
          <div className="film-illustration" aria-hidden="true">
            <div className="film-window">
              <Play size={28} fill="currentColor" strokeWidth={0} />
              <span>观察 · 选择 · 标注</span>
            </div>
            <div className="film-track">
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
            <div className="film-segments">
              <span />
              <span />
              <span />
            </div>
            <div className="film-tick" />
          </div>
        </div>
      </section>
      <section className="login-form-section">
        <form className="login-form" onSubmit={submit}>
          <span className="eyebrow muted">欢迎回来</span>
          <h2>登录工作区</h2>
          <p className="form-intro">使用你的账号，继续今天的工作。</p>
          {notice && <Notice>{notice}</Notice>}
          <label htmlFor="username">账号</label>
          <input
            id="username"
            autoComplete="username"
            autoFocus
            required
            maxLength={64}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="请输入账号"
            disabled={mutation.isPending}
          />
          <label htmlFor="password">密码</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={256}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="请输入密码"
            disabled={mutation.isPending}
          />
          {mutation.isError && (
            <Notice error>{errorText(mutation.error)}</Notice>
          )}
          <Button
            type="submit"
            className="login-submit"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? (
              <Loader2 size={17} className="animate-spin" />
            ) : (
              <>
                进入工作区
                <ArrowRight size={17} />
              </>
            )}
          </Button>
          <p className="login-help">需要账号或遇到登录问题？请联系管理员。</p>
        </form>
        <span className="login-bottom">视频片段标注平台</span>
      </section>
    </main>
  );
}

function useExpired(error: unknown, onExpired: () => void) {
  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) onExpired();
  }, [error, onExpired]);
}

function TaskList({
  session,
  onSelect,
  onExpired,
  onPublish,
}: {
  session: Session;
  onSelect: (id: string) => void;
  onExpired: () => void;
  onPublish: () => void;
}) {
  const isAdmin = session.user.role === "admin";
  const [status, setStatus] = useState<TaskStatus | "">("");
  const [tenantId, setTenantId] = useState("");
  const [page, setPage] = useState(1);
  const tenants = useQuery({
    queryKey: ["tenants", session.user.id],
    queryFn: () => api<Tenant[]>("/tenants"),
    enabled: isAdmin,
  });
  const query = useQuery({
    queryKey: ["tasks", session.user.id, status, tenantId, page],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        page_size: "10",
      });
      if (status) params.set("status", status);
      if (isAdmin && tenantId) params.set("tenant_id", tenantId);
      return api<TaskPage>(`/tasks?${params}`);
    },
  });
  useExpired(query.error ?? tenants.error, onExpired);
  const tabs: [TaskStatus | "", string][] = [
    ["", "全部任务"],
    ["available", "待领取"],
    ["in_progress", "进行中"],
    ["submitted", "已提交"],
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow muted">
            {isAdmin ? "任务管理" : "我的工作区"}
          </span>
          <h1>{isAdmin ? "所有任务" : "我的任务"}</h1>
          <p>
            {isAdmin
              ? "查看各租户的任务状态与视频内容。"
              : "从待领取任务开始，或查看属于你的进行中任务。"}
          </p>
        </div>
        <div className="heading-actions">
          {isAdmin && <Button onClick={onPublish}>发布任务</Button>}
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RotateCcw
              size={15}
              className={query.isFetching ? "animate-spin" : ""}
            />
            刷新列表
          </Button>
        </div>
      </div>
      <section className="task-panel">
        <div className="list-toolbar">
          <div className="tabs" role="group" aria-label="任务状态">
            {tabs.map(([value, label]) => (
              <button
                key={value}
                aria-pressed={status === value}
                className={status === value ? "active" : ""}
                onClick={() => {
                  setStatus(value);
                  setPage(1);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {isAdmin && (
            <label className="tenant-filter">
              <span className="sr-only">按租户筛选</span>
              <select
                value={tenantId}
                disabled={tenants.isPending || tenants.isError}
                onChange={(event) => {
                  setTenantId(event.target.value);
                  setPage(1);
                }}
              >
                <option value="">全部租户</option>
                {tenants.data?.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {tenants.isError && (
          <Notice error>
            租户筛选加载失败。
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void tenants.refetch()}
            >
              重试
            </Button>
          </Notice>
        )}
        {query.isPending ? (
          <Loading text="正在读取任务…" />
        ) : query.isError ? (
          <ErrorState error={query.error} retry={() => void query.refetch()} />
        ) : query.data.items.length === 0 ? (
          <div className="state-panel">
            <FolderOpen size={36} strokeWidth={1.3} />
            <h3>这里暂时没有任务</h3>
            <p>可以切换状态筛选，或稍后刷新列表。</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>任务名称</th>
                  {isAdmin && <th>租户</th>}
                  <th>视频时长</th>
                  <th>状态</th>
                  <th>领取人</th>
                  <th>
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((task) => (
                  <tr
                    key={task.id}
                    className={
                      task.status === "in_progress" && !isAdmin
                        ? "task-row-active"
                        : undefined
                    }
                  >
                    <td>
                      <button
                        className="task-title"
                        onClick={() => onSelect(task.id)}
                      >
                        <span className="video-icon">
                          <Film size={19} strokeWidth={1.5} />
                        </span>
                        <span>
                          {task.title}
                          <small>{dateLabel(task.created_at)} 创建</small>
                        </span>
                      </button>
                    </td>
                    {isAdmin && <td>{task.tenant_name}</td>}
                    <td className="mono task-duration">
                      {durationLabel(task.duration_ms)}
                    </td>
                    <td>
                      <span className={`status-badge ${task.status}`}>
                        {task.status === "submitted" && <Check size={12} />}
                        {statusLabels[task.status]}
                      </span>
                    </td>
                    <td className="muted-cell">{task.assignee_name ?? "—"}</td>
                    <td>
                      <Button
                        variant={
                          task.status === "in_progress" && !isAdmin
                            ? "default"
                            : "outline"
                        }
                        size="sm"
                        onClick={() => onSelect(task.id)}
                      >
                        {task.status === "in_progress" && !isAdmin
                          ? "继续标注"
                          : task.status === "available" && !isAdmin
                            ? "查看并领取"
                            : "查看详情"}
                        <ArrowRight size={14} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {query.data && !query.isError && (
          <div className="list-footer">
            <span>共 {query.data.total} 个任务</span>
            <div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="上一页"
                disabled={page <= 1 || query.isFetching}
                onClick={() => setPage((value) => value - 1)}
              >
                <ChevronLeft size={17} />
              </Button>
              <span>第 {page} 页</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="下一页"
                disabled={
                  page * query.data.page_size >= query.data.total ||
                  query.isFetching
                }
                onClick={() => setPage((value) => value + 1)}
              >
                <ChevronRight size={17} />
              </Button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function Workspace({
  session,
  onLogout,
  onExpired,
}: {
  session: Session;
  onLogout: () => void;
  onExpired: () => void;
}) {
  const [pageState, setPageState] = useState<WorkspacePage>(() => {
    try {
      return readWorkspacePage(
        sessionStorage,
        session.user.id,
        session.user.role === "admin",
      );
    } catch {
      return { view: "tasks", selectedId: null };
    }
  });
  const { view, selectedId } = pageState;
  const [statisticsVisited, setStatisticsVisited] = useState(view === "stats");
  const [pageMemoryError, setPageMemoryError] = useState("");
  function rememberPage(
    nextView: WorkspacePage["view"],
    nextId: string | null = null,
  ) {
    const next = { view: nextView, selectedId: nextId };
    setPageState(next);
    try {
      sessionStorage.setItem(
        workspacePageKey(session.user.id),
        JSON.stringify(next),
      );
      setPageMemoryError("");
    } catch {
      setPageMemoryError("浏览器无法记住页面位置，刷新后可能返回任务列表。");
    }
  }
  const [activity, setActivity] = useState({ dirty: false, busy: false });
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const [taskNavigationOpen, setTaskNavigationOpen] = useState(true);
  const [taskListVisit, setTaskListVisit] = useState(0);
  const onActivity = useCallback(
    (dirty: boolean, busy: boolean) => setActivity({ dirty, busy }),
    [],
  );
  function canLeave() {
    return (
      !activity.busy &&
      (!activity.dirty || window.confirm("有未保存的内容，确定离开吗？"))
    );
  }
  function navigate(next: WorkspacePage["view"]) {
    if (!canLeave()) return;
    if (next === "stats") setStatisticsVisited(true);
    rememberPage(next);
  }
  const logout = useMutation({
    mutationFn: () =>
      api<void>("/auth/logout", {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrf_token },
      }),
    onSuccess: () => {
      rememberPage("tasks");
      onLogout();
    },
  });
  useExpired(logout.error, onExpired);
  const isAdmin = session.user.role === "admin";
  return (
    <div
      className={`workspace-shell task-navigation-shell ${isAdmin ? "admin-navigation-shell" : ""} ${selectedId ? "editor-shell" : ""} ${sidebarExpanded ? "task-navigation-expanded" : ""}`}
    >
      <aside className="sidebar" id="workspace-sidebar">
        <button
          type="button"
          className="brand-toggle"
          aria-label={sidebarExpanded ? "收起侧栏" : "展开侧栏"}
          title={sidebarExpanded ? "收起侧栏" : "展开侧栏"}
          aria-expanded={sidebarExpanded}
          aria-controls="workspace-sidebar"
          onClick={() => setSidebarExpanded((open) => !open)}
        >
          <Brand />
        </button>
        <div className="workspace-label">WORKSPACE</div>
        {isAdmin ? (
          <button
            className={`nav-item ${view !== "stats" ? "selected" : ""}`}
            aria-label={isAdmin ? "任务管理" : "我的任务"}
            title={isAdmin ? "任务管理" : "我的任务"}
            disabled={activity.busy}
            onClick={() => navigate("tasks")}
          >
            <FolderOpen size={18} />
            <span>{isAdmin ? "任务管理" : "我的任务"}</span>
          </button>
        ) : (
          <TaskNavigation
            active={view !== "personal"}
            sidebarExpanded={sidebarExpanded}
            onSidebarExpand={() => setSidebarExpanded(true)}
            open={taskNavigationOpen}
            onOpenChange={setTaskNavigationOpen}
            session={session}
            selectedId={selectedId}
            busy={activity.busy}
            onList={() => {
              if (!canLeave()) return;
              setTaskListVisit((value) => value + 1);
              rememberPage("tasks");
            }}
            onSelect={(id) => {
              if (id === selectedId) return true;
              if (!canLeave()) return false;
              rememberPage("tasks", id);
              return true;
            }}
            onExpired={onExpired}
          />
        )}
        {isAdmin && (
          <button
            className={`nav-item ${view === "stats" ? "selected" : ""}`}
            aria-label="每日统计"
            title="每日统计"
            disabled={activity.busy}
            onClick={() => navigate("stats")}
          >
            <Layers3 size={18} />
            <span>每日统计</span>
          </button>
        )}
        {!isAdmin && (
          <button
            className={`nav-item personal-nav ${view === "personal" ? "selected" : ""}`}
            aria-label="个人统计"
            title="个人统计"
            aria-current={view === "personal" ? "page" : undefined}
            disabled={activity.busy}
            onClick={() => navigate("personal")}
          >
            <BarChart3 size={18} />
            <span>个人统计</span>
          </button>
        )}
        <div className="sidebar-bottom">
          <ShieldCheck size={17} />
          <div>
            {isAdmin ? "平台管理空间" : session.user.tenant_name}
            <small>{isAdmin ? "跨租户任务管理" : "独立租户工作区"}</small>
          </div>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="topbar">
          <span>
            {isAdmin ? "平台管理" : session.user.tenant_name}
            <span className="breadcrumb-divider">/</span>
            {selectedId
              ? "任务详情"
              : view === "personal"
                ? "个人统计"
                : view === "stats"
                  ? "每日统计"
                  : view === "publish"
                    ? "发布任务"
                    : "任务列表"}
          </span>
          <div className="user-menu">
            <ThemeToggle />
            <span className="user-avatar">
              <UserRound size={16} />
            </span>
            <span>{session.user.display_name}</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="退出登录"
              title="退出登录"
              disabled={logout.isPending || activity.busy}
              onClick={() => {
                if (canLeave()) logout.mutate();
              }}
            >
              {logout.isPending ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <LogOut size={16} />
              )}
            </Button>
          </div>
        </header>
        <main className="workspace-content">
          {pageMemoryError && <Notice error>{pageMemoryError}</Notice>}
          {logout.isError && <Notice error>{errorText(logout.error)}</Notice>}
          {isAdmin && statisticsVisited && (
            <Statistics
              session={session}
              active={view === "stats" && !selectedId}
              onSelect={(id) => rememberPage("stats", id)}
              onExpired={onExpired}
            />
          )}
          {!isAdmin && view === "personal" ? (
            <PersonalStatistics session={session} onExpired={onExpired} />
          ) : selectedId ? (
            <TaskWorkspace
              key={selectedId}
              id={selectedId}
              session={session}
              onActivity={onActivity}
              backLabel={view === "stats" ? "返回每日统计" : "返回任务列表"}
              onBack={() => {
                if (canLeave()) rememberPage(view);
              }}
              onExpired={onExpired}
            />
          ) : view === "publish" ? (
            <PublishTask
              session={session}
              onBack={() => navigate("tasks")}
              onPublished={(id) => {
                rememberPage("tasks", id);
              }}
              onExpired={onExpired}
              onActivity={onActivity}
            />
          ) : view === "stats" ? null : (
            <TaskList
              key={taskListVisit}
              session={session}
              onSelect={(id) => rememberPage(view, id)}
              onPublish={() => navigate("publish")}
              onExpired={onExpired}
            />
          )}
        </main>
      </div>
    </div>
  );
}

export function App() {
  const client = useQueryClient();
  const [notice, setNotice] = useState("");
  const session = useQuery({
    queryKey: ["session"],
    queryFn: fetchSession,
    retry: false,
  });
  const replaceSession = useCallback(
    async (value: Session | null, message: string) => {
      await client.cancelQueries();
      client.removeQueries({
        predicate: (query) => query.queryKey[0] !== "session",
      });
      client.setQueryData(["session"], value);
      setNotice(message);
    },
    [client],
  );
  const expired = useCallback(() => {
    void replaceSession(null, "登录已过期，请重新登录。");
  }, [replaceSession]);
  if (session.isPending)
    return (
      <main className="initial-state">
        <Loading text="正在连接工作区…" />
      </main>
    );
  if (session.isError)
    return (
      <main className="initial-state">
        <ErrorState
          error={session.error}
          retry={() => void session.refetch()}
        />
      </main>
    );
  if (!session.data)
    return (
      <Login
        notice={notice}
        onLogin={(value) => {
          void replaceSession(value, "");
        }}
      />
    );
  return (
    <Workspace
      key={session.data.user.id}
      session={session.data}
      onLogout={() => {
        void replaceSession(null, "你已安全退出登录。");
      }}
      onExpired={expired}
    />
  );
}
