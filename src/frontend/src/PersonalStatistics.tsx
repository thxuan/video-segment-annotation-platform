import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  CalendarDays,
  CheckCheck,
  Clock3,
  RotateCcw,
} from "lucide-react";
import { api, ApiError, durationLabel, errorText } from "./api";
import { Button } from "./components/ui/button";
import {
  activityCalendar,
  activityLevel,
  contributionCount,
  contributionDuration,
} from "./personal-statistics";
import { PersonalMetricValue } from "./PersonalMetricValue";
import type { PersonalReport, Session } from "./types";

function usePersonalStatistics(session: Session, year?: number) {
  return useQuery({
    queryKey:
      year === undefined
        ? ["personal-stats", session.user.id]
        : ["personal-stats", session.user.id, year],
    queryFn: ({ signal }) =>
      api<PersonalReport>(
        `/stats/me${year === undefined ? "" : `?year=${year}`}`,
        { signal },
      ),
    enabled: session.user.role === "annotator",
    staleTime: 30_000,
    retry: false,
    refetchInterval: 60_000,
  });
}

export function PersonalStatistics({
  session,
  onExpired,
}: {
  session: Session;
  onExpired: () => void;
}) {
  const query = usePersonalStatistics(session);
  const [year, setYear] = useState<number | undefined>(undefined);
  const activity = usePersonalStatistics(session, year);
  const scroll = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [shownMetric, setShownMetric] = useState<string | null>(null);
  const data = query.data;
  const annual = activity.data;
  const cells = annual
    ? activityCalendar(annual.start_date, annual.end_date)
    : [];
  const columns = cells.length / 7;
  const byDate = new Map(annual?.items.map((day) => [day.date, day]));
  const selectedDay = selected ? byDate.get(selected) : null;
  useEffect(() => {
    if (
      [query.error, activity.error].some(
        (error) => error instanceof ApiError && error.status === 401,
      )
    )
      onExpired();
  }, [query.error, activity.error, onExpired]);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const showLatest = () => {
      const latest = element.querySelector<HTMLButtonElement>(
        "[data-activity-latest]",
      );
      element.scrollLeft = latest
        ? Math.max(
            0,
            element.scrollLeft +
              latest.getBoundingClientRect().right -
              element.getBoundingClientRect().right +
              3,
          )
        : 0;
    };
    showLatest();
    const observer = new ResizeObserver(showLatest);
    observer.observe(element);
    return () => observer.disconnect();
  }, [annual?.end_date, activity.isError, query.isError]);
  const metrics = data
    ? [
        {
          label: "累计完成",
          metric: contributionCount(data.task_count),
          icon: CheckCheck,
        },
        {
          label: "累计有效时长",
          metric: contributionDuration(data.effective_ms),
          icon: Clock3,
        },
        {
          label: "今日完成",
          metric: contributionCount(data.today_count),
          icon: BarChart3,
        },
        {
          label: "活跃天数",
          metric: contributionCount(data.active_days, "天"),
          icon: CalendarDays,
        },
      ]
    : [];
  return (
    <div className="personal-statistics">
      <div className="page-heading">
        <div>
          <h1>个人统计</h1>
        </div>
        <Button
          variant="outline"
          disabled={query.isFetching || activity.isFetching}
          onClick={() => {
            void query.refetch();
            if (year !== undefined) void activity.refetch();
          }}
        >
          <RotateCcw
            size={15}
            className={
              query.isFetching || activity.isFetching ? "animate-spin" : ""
            }
          />
          刷新统计
        </Button>
      </div>
      {query.isPending ? (
        <div className="state-panel" role="status">
          正在整理你的积累…
        </div>
      ) : query.isError ? (
        <div className="state-panel" role="alert">
          <h3>暂时无法加载统计</h3>
          <p>{errorText(query.error)}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            重试
          </Button>
        </div>
      ) : (
        data && (
          <>
            <section className="personal-metrics" aria-label="个人累计成果">
              {metrics.map(({ label, metric, icon: Icon }) => (
                <div className="personal-metric" key={label}>
                  <Icon size={18} strokeWidth={1.5} aria-hidden="true" />
                  <PersonalMetricValue
                    label={label}
                    metric={metric}
                    open={shownMetric === label}
                    onOpen={() => setShownMetric(label)}
                    onClose={() => setShownMetric(null)}
                  />
                  <span>{label}</span>
                </div>
              ))}
            </section>
            <section
              className="activity-section"
              aria-labelledby="activity-title"
            >
              <div className="activity-heading">
                <div>
                  <h2 id="activity-title">标注活动</h2>
                  <p>有完成记录的日子，都是一份积累。</p>
                </div>
                <div className="activity-controls">
                  <span>北京时间</span>
                  <label className="activity-year">
                    <span className="sr-only">选择时间范围</span>
                    <select
                      value={year ?? "recent"}
                      onChange={(event) => {
                        setYear(
                          event.target.value === "recent"
                            ? undefined
                            : Number(event.target.value),
                        );
                        setSelected(null);
                      }}
                    >
                      <option value="recent">最近 365 天</option>
                      {data.years.map((value) => (
                        <option key={value} value={value}>
                          {value} 年
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
              <div className="activity-card">
                {activity.isPending ? (
                  <div className="activity-state" role="status">
                    正在加载年度记录…
                  </div>
                ) : activity.isError ? (
                  <div className="activity-state" role="alert">
                    <p>暂时无法加载该年份的记录</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void activity.refetch()}
                    >
                      重试年度记录
                    </Button>
                  </div>
                ) : (
                  annual && (
                    <>
                      <div
                        className="activity-scroll"
                        ref={scroll}
                        aria-label={`${annual.year === null ? "最近 365 天" : `${annual.year} 年`}标注活动，窄屏可横向滚动`}
                        tabIndex={0}
                      >
                        <div
                          className="activity-chart"
                          style={{
                            gridTemplateColumns: `repeat(${columns}, minmax(12px, 1fr))`,
                          }}
                        >
                          <div
                            className="activity-months"
                            style={{
                              gridColumn: `1 / span ${columns}`,
                              gridTemplateColumns: `repeat(${columns}, 1fr)`,
                            }}
                          >
                            {Array.from({ length: columns }, (_, col) => {
                              const week = cells.slice(col * 7, col * 7 + 7);
                              const monthStart = week.find(
                                (day) =>
                                  day.inRange && day.date.endsWith("-01"),
                              );
                              const firstDay = week.find((day) => day.inRange);
                              // A short partial month would collide with the next month's label.
                              const label =
                                monthStart ??
                                (col === 0 &&
                                firstDay &&
                                Number(firstDay.date.slice(8)) <= 14
                                  ? firstDay
                                  : undefined);
                              return (
                                <span key={col}>
                                  {label
                                    ? `${Number(label.date.slice(5, 7))}月`
                                    : ""}
                                </span>
                              );
                            })}
                          </div>
                          <div
                            className="activity-grid"
                            style={{
                              gridColumn: `1 / span ${columns}`,
                              gridTemplateColumns: `repeat(${columns}, 1fr)`,
                            }}
                            onKeyDown={(event) => {
                              if (!(event.target instanceof HTMLButtonElement))
                                return;
                              const movement: Record<string, number> = {
                                ArrowUp: -1,
                                ArrowDown: 1,
                                ArrowLeft: -7,
                                ArrowRight: 7,
                              };
                              if (
                                !(event.key in movement) &&
                                !["Home", "End"].includes(event.key)
                              )
                                return;
                              event.preventDefault();
                              const buttons = Array.from(
                                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                                  "button",
                                ),
                              );
                              const index = buttons.indexOf(event.target);
                              const next =
                                event.key === "Home"
                                  ? 0
                                  : event.key === "End"
                                    ? buttons.length - 1
                                    : Math.max(
                                        0,
                                        Math.min(
                                          buttons.length - 1,
                                          index + movement[event.key],
                                        ),
                                      );
                              buttons[next]?.focus();
                            }}
                          >
                            {cells.map(({ date, inRange }) => {
                              const day = byDate.get(date);
                              const label = `${date} · 完成 ${day?.task_count ?? 0} 项 · 有效时长 ${durationLabel(day?.effective_ms ?? 0)}`;
                              return inRange && date <= annual.as_of ? (
                                <button
                                  type="button"
                                  key={date}
                                  data-activity-latest={
                                    date ===
                                    (annual.end_date < annual.as_of
                                      ? annual.end_date
                                      : annual.as_of)
                                      ? ""
                                      : undefined
                                  }
                                  className={`activity-cell level-${activityLevel(day?.task_count ?? 0)} ${selected === date ? "activity-selected" : ""}`}
                                  tabIndex={
                                    date ===
                                    (selected ??
                                      (annual.end_date < annual.as_of
                                        ? annual.end_date
                                        : annual.as_of))
                                      ? 0
                                      : -1
                                  }
                                  title={label}
                                  aria-label={label}
                                  aria-pressed={selected === date}
                                  onFocus={() => setSelected(date)}
                                  onClick={() => setSelected(date)}
                                />
                              ) : (
                                <span
                                  key={date}
                                  className="activity-cell outside-range"
                                />
                              );
                            })}
                          </div>
                        </div>
                      </div>
                      <div className="activity-footer">
                        <p aria-live="polite">
                          {selected
                            ? `${selected} · 完成 ${selectedDay?.task_count ?? 0} 项 · 有效时长 ${durationLabel(selectedDay?.effective_ms ?? 0)}`
                            : annual.items.length
                              ? "选择一个日期，看看那天留下的成果。"
                              : `${annual.year === null ? "最近 365 天" : `${annual.year} 年`}暂无提交记录。`}
                        </p>
                        <div
                          className="activity-legend"
                          aria-label="完成数量：0项、1至2项、3至5项、6至9项、10项及以上"
                        >
                          <span>少</span>
                          {[0, 1, 2, 3, 4].map((level) => (
                            <i
                              key={level}
                              className={`activity-cell level-${level}`}
                            />
                          ))}
                          <span>多</span>
                        </div>
                      </div>
                    </>
                  )
                )}
              </div>
            </section>
            <p className="personal-definition">
              仅统计本人已提交的任务。有效时长为标注片段总时长，非实际工作耗时；活跃天数为历史上有提交记录的日期数。
            </p>
          </>
        )
      )}
    </div>
  );
}
