import { useEffect } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Film,
  FolderOpen,
  Loader2,
} from "lucide-react";
import { api, ApiError, durationLabel, errorText } from "./api";
import type { Session, TaskPage } from "./types";

export function TaskNavigation({
  sidebarExpanded,
  onSidebarExpand,
  open,
  onOpenChange: setOpen,
  session,
  selectedId,
  busy,
  onSelect,
  onList,
  onExpired,
  active = true,
}: {
  sidebarExpanded: boolean;
  onSidebarExpand: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: Session;
  selectedId: string | null;
  busy: boolean;
  onSelect: (id: string) => boolean;
  onList: () => void;
  onExpired: () => void;
  active?: boolean;
}) {
  const visible = sidebarExpanded && open;
  const query = useInfiniteQuery({
    queryKey: ["tasks", session.user.id, "in-progress-navigation"],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      api<TaskPage>(
        `/tasks?status=in_progress&page=${pageParam}&page_size=10`,
        { signal },
      ),
    getNextPageParam: (last) =>
      last.page * last.page_size < last.total ? last.page + 1 : undefined,
    enabled: visible,
  });
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401)
      onExpired();
  }, [query.error, onExpired]);
  const tasks = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="task-navigation">
      <button
        type="button"
        className={`nav-item task-navigation-trigger ${active ? "selected" : ""}`}
        aria-label="我的任务"
        title="我的任务"
        aria-expanded={visible}
        aria-controls="task-navigation-menu"
        onClick={() => {
          if (!sidebarExpanded) onSidebarExpand();
          else setOpen(!open);
        }}
      >
        <FolderOpen size={18} />
        <span>我的任务</span>
        <ChevronDown size={16} className="task-navigation-chevron" />
      </button>
      {visible && (
        <div className="task-navigation-dropdown" id="task-navigation-menu">
          <button
            type="button"
            className="task-navigation-all"
            aria-label="查看全部任务"
            aria-current={active && !selectedId ? "page" : undefined}
            disabled={busy}
            onClick={onList}
          >
            <FolderOpen size={16} />
            <span>全部任务</span>
            <ArrowRight size={14} />
          </button>
          <section
            className="task-navigation-scroll"
            id="in-progress-tasks"
            aria-label="标注中任务"
          >
            <div className="task-navigation-heading">
              <span>标注中任务</span>
              {query.data && <span>{query.data.pages[0].total}</span>}
            </div>
            {query.isPending && <p role="status">正在加载任务…</p>}
            {query.isError && (
              <div className="task-navigation-message" role="alert">
                <p>{errorText(query.error)}</p>
                <button
                  onClick={() =>
                    void (query.isFetchNextPageError
                      ? query.fetchNextPage()
                      : query.refetch())
                  }
                  disabled={query.isFetching}
                >
                  重试
                </button>
              </div>
            )}
            {query.isSuccess && tasks.length === 0 && (
              <p role="status">暂无标注中的任务</p>
            )}
            {tasks.length > 0 && (
              <ul className="task-navigation-list">
                {tasks.map((task) => (
                  <li key={task.id}>
                    <button
                      title={task.title}
                      aria-current={task.id === selectedId ? "page" : undefined}
                      disabled={busy}
                      onClick={() => onSelect(task.id)}
                    >
                      <Film size={16} />
                      <span>
                        <strong>{task.title}</strong>
                        <small>{durationLabel(task.duration_ms)}</small>
                      </span>
                      {task.id === selectedId && <Check size={16} />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {query.hasNextPage && !query.isError && (
              <button
                className="task-navigation-more"
                disabled={query.isFetching}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage && (
                  <Loader2 size={14} className="animate-spin" />
                )}
                加载更多
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
