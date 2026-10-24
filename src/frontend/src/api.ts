import type { Session } from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "连接失败，请检查网络后重试");
  }
  if (response.status === 204) return undefined as T;
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const detail =
      data && typeof data === "object" && "detail" in data ? data.detail : null;
    throw new ApiError(
      response.status,
      typeof detail === "string" ? detail : "请求未完成，请稍后重试",
    );
  }
  if (data === null) throw new ApiError(502, "服务响应异常，请稍后重试");
  return data as T;
}

export async function fetchSession(): Promise<Session | null> {
  try {
    return await api<Session>("/auth/me");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : "发生错误，请重试";
}

export function durationLabel(milliseconds: number) {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60;
  return `${[hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":")}.${String(milliseconds % 1000).padStart(3, "0")}`;
}

export function dateLabel(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
