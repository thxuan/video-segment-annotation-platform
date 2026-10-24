import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, dateLabel, durationLabel, errorText } from "./api";
import { beijingToday } from "./annotations";
import { Button } from "./components/ui/button";
import type { DailyReport, DailyRow, Session, Task, Tenant } from "./types";

const rowKey = (row: DailyRow) => `${row.date}-${row.tenant_id}-${row.user_id}`;

export function Statistics({
  session,
  onSelect,
  onExpired,
  active = true,
}: {
  session: Session;
  onSelect: (id: string) => void;
  onExpired: () => void;
  active?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const returnPosition = useRef<{
    x: number;
    y: number;
    focus: HTMLElement | null;
    tables: { element: HTMLElement; left: number; top: number }[];
  } | null>(null);
  function openTask(id: string) {
    returnPosition.current = {
      x: window.scrollX,
      y: window.scrollY,
      focus:
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
      tables: Array.from(
        container.current?.querySelectorAll<HTMLElement>(".table-scroll") ?? [],
      ).map((element) => ({
        element,
        left: element.scrollLeft,
        top: element.scrollTop,
      })),
    };
    onSelect(id);
  }
  useLayoutEffect(() => {
    if (!active || !returnPosition.current) return;
    const position = returnPosition.current;
    returnPosition.current = null;
    position.tables.forEach(({ element, left, top }) =>
      element.scrollTo(left, top),
    );
    position.focus?.focus({ preventScroll: true });
    window.scrollTo(position.x, position.y);
  }, [active]);
  const [start, setStart] = useState(beijingToday);
  const [end, setEnd] = useState(beijingToday);
  const [tenant, setTenant] = useState("");
  const [filter, setFilter] = useState(() => ({
    start_date: start,
    end_date: end,
    tenant_id: "",
  }));
  const [selected, setSelected] = useState<DailyRow | null>(null);
  const [error, setError] = useState("");
  const tenants = useQuery({
    queryKey: ["tenants", session.user.id],
    queryFn: () => api<Tenant[]>("/tenants"),
    refetchOnWindowFocus: active,
    refetchOnReconnect: active,
  });
  const query = useQuery({
    queryKey: ["stats", session.user.id, filter],
    refetchOnWindowFocus: active,
    refetchOnReconnect: active,
    queryFn: () => {
      const params = new URLSearchParams({
        start_date: filter.start_date,
        end_date: filter.end_date,
      });
      if (filter.tenant_id) params.set("tenant_id", filter.tenant_id);
      return api<DailyReport>(`/stats/daily?${params}`);
    },
  });
  useEffect(() => {
    if (
      [query.error, tenants.error].some(
        (e) => e instanceof ApiError && e.status === 401,
      )
    )
      onExpired();
  }, [query.error, tenants.error, onExpired]);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (start > end || (Date.parse(end) - Date.parse(start)) / 86400000 > 365) {
      setError("请选择顺序正确且不超过 366 天的日期范围");
      return;
    }
    setError("");
    setSelected(null);
    if (
      filter.start_date === start &&
      filter.end_date === end &&
      filter.tenant_id === tenant
    ) {
      void query.refetch();
    } else {
      setFilter({ start_date: start, end_date: end, tenant_id: tenant });
    }
  }
  return (
    <div ref={container} hidden={!active}>
      <div className="page-heading">
        <div>
          <span className="eyebrow muted">工作成果</span>
          <h1>每日有效时长</h1>
          <p>仅统计已提交任务，按提交当天归属 · 北京时间</p>
        </div>
      </div>
      <form className="stats-filters" onSubmit={submit}>
        <label>
          开始日期
          <input
            type="date"
            required
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label>
          结束日期
          <input
            type="date"
            required
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        <label>
          租户
          <select
            aria-label="租户"
            value={tenant}
            disabled={!tenants.data}
            onChange={(e) => setTenant(e.target.value)}
          >
            <option value="">全部租户</option>
            {tenants.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" disabled={query.isFetching}>
          {query.isFetching ? "查询中…" : "查询"}
        </Button>
      </form>
      {(error || tenants.isError) && (
        <div className="notice notice-error" role="alert">
          {error || errorText(tenants.error)}
          {tenants.isError && (
            <Button variant="outline" onClick={() => void tenants.refetch()}>
              重试租户列表
            </Button>
          )}
        </div>
      )}
      {query.isPending ? (
        <div className="state-panel">正在统计…</div>
      ) : query.isError ? (
        <div className="state-panel" role="alert">
          {errorText(query.error)}
          <Button onClick={() => void query.refetch()}>重试</Button>
        </div>
      ) : (
        <>
          <p className="field-help">
            当前结果：{query.data.start_date} 至 {query.data.end_date} ·{" "}
            {filter.tenant_id
              ? tenants.data?.find((t) => t.id === filter.tenant_id)?.name
              : "全部租户"}
          </p>
          <div className="summary-cards">
            <div>
              <span>有效时长</span>
              <strong className="mono">
                {durationLabel(query.data.effective_ms)}
              </strong>
            </div>
            <div>
              <span>已提交任务</span>
              <strong>
                {query.data.task_count}
                <small> 个</small>
              </strong>
            </div>
          </div>
          <section className="task-panel">
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>提交日期</th>
                    <th>租户</th>
                    <th>标注员</th>
                    <th>任务数</th>
                    <th>有效时长</th>
                    <th>明细</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((row) => {
                    const key = rowKey(row);
                    const expanded =
                      selected !== null && rowKey(selected) === key;
                    const detailId = `stats-detail-${key}`;
                    return (
                      <Fragment key={key}>
                        <tr
                          className={
                            expanded ? "stats-row-expanded" : undefined
                          }
                        >
                          <td>{row.date}</td>
                          <td>{row.tenant_name}</td>
                          <td>{row.user_name}</td>
                          <td>{row.task_count}</td>
                          <td className="mono">
                            {durationLabel(row.effective_ms)}
                          </td>
                          <td>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-expanded={expanded}
                              aria-controls={expanded ? detailId : undefined}
                              onClick={() => setSelected(expanded ? null : row)}
                            >
                              {expanded ? "收起任务" : "查看任务"}
                              {expanded ? (
                                <ChevronUp size={14} />
                              ) : (
                                <ChevronDown size={14} />
                              )}
                            </Button>
                          </td>
                        </tr>
                        {expanded && (
                          <tr className="stats-detail-row">
                            <td colSpan={6}>
                              <StatTasks
                                id={detailId}
                                row={row}
                                session={session}
                                active={active}
                                onSelect={openTask}
                                onExpired={onExpired}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!query.data.items.length && (
              <div className="state-panel">该日期范围内尚无已提交任务。</div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function StatTasks({
  id,
  active,
  row,
  session,
  onSelect,
  onExpired,
}: {
  id: string;
  active: boolean;
  row: DailyRow;
  session: Session;
  onSelect: (id: string) => void;
  onExpired: () => void;
}) {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ["stats", "tasks", session.user.id, row, page],
    refetchOnWindowFocus: active,
    refetchOnReconnect: active,
    queryFn: () =>
      api<{
        items: (Task & { effective_ms: number })[];
        total: number;
        page_size: number;
      }>(
        `/stats/tasks?${new URLSearchParams({ day: row.date, tenant_id: row.tenant_id, user_id: row.user_id, page: String(page) })}`,
      ),
  });
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401)
      onExpired();
  }, [query.error, onExpired]);
  return (
    <section
      id={id}
      className="stats-detail"
      aria-label={`${row.date} ${row.tenant_name} ${row.user_name}的任务明细`}
    >
      <div className="section-heading">
        <h3>已提交任务</h3>
        <span>
          {row.task_count} 个 · {durationLabel(row.effective_ms)}
        </span>
      </div>
      {query.isPending ? (
        <p>正在加载任务…</p>
      ) : query.isError ? (
        <div role="alert">
          {errorText(query.error)}
          <Button onClick={() => void query.refetch()}>重试</Button>
        </div>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>任务</th>
                  <th>提交时间</th>
                  <th>有效时长</th>
                  <th>片段</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((task) => (
                  <tr key={task.id}>
                    <td>{task.title}</td>
                    <td>{dateLabel(task.submitted_at!)}</td>
                    <td className="mono">{durationLabel(task.effective_ms)}</td>
                    <td>
                      <Button variant="ghost" onClick={() => onSelect(task.id)}>
                        查看片段
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!query.data.items.length && (
            <p className="field-help">暂无对应任务，请重新查询统计。</p>
          )}
          <div className="list-footer">
            <span>共 {query.data.total} 个任务</span>
            <div>
              <Button
                variant="ghost"
                disabled={page === 1}
                onClick={() => setPage((p) => p - 1)}
              >
                上一页
              </Button>
              <span>第 {page} 页</span>
              <Button
                variant="ghost"
                disabled={page * query.data.page_size >= query.data.total}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
