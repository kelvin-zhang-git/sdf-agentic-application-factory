import { queryOptions } from "@tanstack/react-query";
import { api } from "./http";
import { getAccessToken } from "./auth";

export interface LogRow { id: string; created_at: string; code: string; path: string; error_id?: string; trace_id: string; status?: number }
export interface LogBundle { app_logs: LogRow[]; client_errors: LogRow[]; llm_calls: { id: string; model: string; status: string; trace_id: string; total_tokens: number }[] }
export const logsQuery = (errorId = "") => queryOptions({ queryKey: ["admin", "logs", errorId], queryFn: () => api<LogBundle>(`/admin/logs?error_id=${encodeURIComponent(errorId)}`) });
export const healthQuery = () => queryOptions({ queryKey: ["admin", "health"], queryFn: () => api<{ checks: { name: string; status: string }[] }>("/admin/health") });
export const exportDiagnostics = () => api<LogBundle>("/admin/diagnostics");
export const reportClientError = (code: "RENDER_ERROR" | "UNHANDLED_ERROR" | "UNHANDLED_REJECTION") => api<{ error_id: string; trace_id: string }>("/client-errors", { method: "POST", body: { code, path: window.location.pathname } });

// Signed-out errors stay in bounded memory; no raw error messages or form values are captured.
export function installClientReporting() {
  const queue: { code: "UNHANDLED_ERROR" | "UNHANDLED_REJECTION"; path: string; operations: string[] }[] = [];
  const operations: string[] = [];
  let sending = false;
  const flush = async () => {
    if (sending || !queue.length) return;
    sending = true;
    try {
      if (!(await getAccessToken())) return;
      while (queue.length) { const item = queue[0]; if (!item) break; await api("/client-errors", { method: "POST", body: item }); queue.shift(); }
    } catch { /* keep bounded queue; never recursively report */ } finally { sending = false; }
  };
  const capture = (code: "UNHANDLED_ERROR" | "UNHANDLED_REJECTION") => { queue.push({ code, path: window.location.pathname, operations: operations.slice(-20) }); if (queue.length > 20) queue.shift(); void flush(); };
  const onError = () => capture("UNHANDLED_ERROR"); const onRejection = () => capture("UNHANDLED_REJECTION");
  const click = () => { operations.push("click"); if (operations.length > 20) operations.shift(); };
  const submit = () => { operations.push("submit"); if (operations.length > 20) operations.shift(); };
  window.addEventListener("error",onError); window.addEventListener("unhandledrejection",onRejection);
  document.addEventListener("click",click); document.addEventListener("submit",submit);
  const timer = setInterval(() => { void flush(); },5000);
  return () => { clearInterval(timer); window.removeEventListener("error",onError); window.removeEventListener("unhandledrejection",onRejection); document.removeEventListener("click",click); document.removeEventListener("submit",submit); };
}