import { getAccessToken } from "./auth";

export class ApiError extends Error {
  code: string; errorId?: string | undefined; traceId?: string | undefined; status: number; details?: unknown;
  constructor(status: number, code: string, message: string, errorId?: string, traceId?: string, details?: unknown) {
    super(message); this.status = status; this.code = code; this.errorId = errorId; this.traceId = traceId; this.details = details;
  }
}

function traceId() {
  const r = new Uint8Array(8); crypto.getRandomValues(r);
  return "t-" + Array.from(r, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const token = await getAccessToken();
  const headers: Record<string, string> = { "X-Trace-Id": traceId(), ...init.headers };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: init.method ?? "GET", headers, body: init.body !== undefined ? JSON.stringify(init.body) : null });
  } catch {
    throw new ApiError(0, "NETWORK", "网络连接失败，请检查网络后重试");
  }
  const text = await res.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
  if (!res.ok) {
    const e = json?.error;
    throw new ApiError(res.status, e?.code ?? "HTTP_" + res.status, e?.message ?? `请求失败（${res.status}）`, e?.error_id, e?.trace_id ?? res.headers.get("x-trace-id") ?? undefined, e?.details);
  }
  return json as T;
}
