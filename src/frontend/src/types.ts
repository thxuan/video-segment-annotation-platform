export type TaskStatus = "available" | "in_progress" | "submitted";

export interface User {
  id: string;
  username: string;
  display_name: string;
  role: "admin" | "annotator";
  tenant_id: string | null;
  tenant_name: string | null;
}

export interface Session {
  user: User;
  csrf_token: string;
}
export interface Tenant {
  id: string;
  name: string;
}

export interface Task {
  id: string;
  title: string;
  tenant_id: string;
  tenant_name: string;
  duration_ms: number;
  status: TaskStatus;
  assignee_id: string | null;
  assignee_name: string | null;
  created_at: string;
  submitted_at: string | null;
  revision: number;
}

export interface Segment {
  start_ms: number;
  end_ms: number;
}
export interface TaskDetailData extends Task {
  segments: Segment[];
  effective_ms: number;
}
export interface DailyRow {
  date: string;
  tenant_id: string;
  tenant_name: string;
  user_id: string;
  user_name: string;
  task_count: number;
  effective_ms: number;
}
export interface DailyReport {
  timezone: string;
  start_date: string;
  end_date: string;
  task_count: number;
  effective_ms: number;
  items: DailyRow[];
}

export interface TaskPage {
  items: Task[];
  total: number;
  page: number;
  page_size: number;
}

export interface PersonalReport {
  timezone: string;
  year: number | null;
  years: number[];
  as_of: string;
  start_date: string;
  end_date: string;
  task_count: number;
  effective_ms: number;
  today_count: number;
  active_days: number;
  items: { date: string; task_count: number; effective_ms: number }[];
}
