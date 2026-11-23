import { redact } from "./redact";

/** A failed writer never calls itself; at most one safe fallback per write. */
export async function safeLog(write: () => Promise<void>, fallback: (value: unknown) => void = (value) => console.error("[日志写入失败]", value), timeoutMs = 1500): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([write(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("日志写入超时")), timeoutMs); })]);
  } catch {
    fallback(redact({ message: "日志写入失败" }));
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

// Allowlisted diagnostics never include request bodies, headers, configuration or model output.
export function diagnosticBundle(meta: unknown, logs: unknown[], clients: unknown[], calls: unknown[]) {
  return redact({ generated_at: new Date().toISOString(), meta, app_logs: logs, client_errors: clients, llm_calls: calls });
}