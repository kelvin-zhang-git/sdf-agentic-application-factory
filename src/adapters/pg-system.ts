import { createHash, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import type { AuditEntry, AuthVerifier, ClientErrorEntry, LlmCallEntry, ServerLogEntry, StoredSecret, SystemOps } from "@/core/ports";
import { redact } from "@/core/redact";
import { safeLog } from "@/core/log";
import { createServiceDb } from "./pg-client";
import { verifyAccessToken } from "./jwt";

function db() { return createServiceDb(); }

function fail(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`${action}失败：${error.message}`);
}

export const pgAuthVerifier: AuthVerifier = {
  verify: async (token) => {
    const user = await verifyAccessToken(token);
    if (!user) return null;
    return (await accountAllows(user.userId)) ? user : null;
  },
};

async function accountAllows(userId: string): Promise<boolean> {
  const { serviceQuery } = await import("./pg-client");
  try {
    const rows = await serviceQuery()(
      `SELECT u.disabled, p.expires_at
       FROM auth.users u LEFT JOIN public.profiles p ON p.id = u.id
       WHERE u.id = $1`,
      [userId],
    );
    const row = rows[0];
    if (!row || row["disabled"] === true) return false;
    const expires = row["expires_at"] ? Date.parse(String(row["expires_at"])) : NaN;
    if (!Number.isNaN(expires) && expires <= Date.now()) {
      await serviceQuery()("UPDATE auth.users SET disabled = true WHERE id = $1 AND disabled = false", [userId]);
      return false;
    }
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "42703") return true;
    throw error;
  }
}

export const pgSystemOps: SystemOps = {
  async claimCronNonce(nonce) {
    const { error } = await db().from("cron_nonces").insert({ nonce });
    if (error?.code === "23505") return false;
    if (error) throw new Error(error.message);
    return true;
  },
  async cleanupLogs() { fail((await db().rpc("sdf_log_cleanup")).error, "清理日志"); },
  async writeServerLog(entry: ServerLogEntry) {
    await safeLog(async () => { fail((await db().from("app_logs").insert({ ...entry, detail: redact(entry.detail ?? {}) })).error, "写系统日志"); });
  },
  async writeClientError(entry: ClientErrorEntry) {
    await safeLog(async () => { fail((await db().from("client_errors").insert({ ...entry, detail: redact(entry.detail ?? {}) })).error, "写客户端错误"); });
  },
  async bootstrapAdmin(userId) {
    const { data, error } = await db().rpc("bootstrap_admin", { _user_id: userId });
    fail(error, "初始化管理员");
    return data === true;
  },
  async isBootstrapped() {
    const { data, error } = await db().rpc("is_bootstrapped");
    fail(error, "读取初始化状态");
    return data === true;
  },
  async writeAudit(e: AuditEntry) {
    const { error } = await db().from("audit_logs").insert({
      trace_id: e.trace_id ?? null, actor_id: e.actor_id, app_id: e.app_id ?? null, action: e.action,
      target_type: e.target_type ?? null, target_id: e.target_id ?? null, detail: redact(e.detail ?? {}),
    });
    if (error) console.error("[audit-write-failed]", e.action, error.message);
  },
  async createSecret(record: StoredSecret) {
    fail((await db().from("secrets").insert({ id: record.id, kind: record.kind, ciphertext: record.ciphertext, last4: record.last4, created_by: record.created_by ?? null })).error, "保存密钥");
  },
  async updateSecret(record: StoredSecret) {
    fail((await db().from("secrets").update({ ciphertext: record.ciphertext, last4: record.last4 }).eq("id", record.id).eq("kind", record.kind)).error, "更新密钥");
  },
  async readSecret(id) {
    const { data, error } = await db().from("secrets").select("id,kind,ciphertext,last4").eq("id", id).maybeSingle();
    fail(error, "读取密钥");
    if (!data || typeof data !== "object") return null;
    const row = data as StoredSecret;
    const kind = row.kind === "connector_token" || row.kind === "webhook_secret" ? row.kind : "llm_provider";
    return { ...row, kind };
  },
  async secretMetadata(ids) {
    if (!ids.length) return [];
    const { data, error } = await db().from("secrets").select("id,last4,updated_at").in("id", ids);
    fail(error, "读取密钥摘要");
    return (data ?? []) as { id: string; last4: string; updated_at: string }[];
  },
  async deleteSecret(id) { fail((await db().from("secrets").delete().eq("id", id)).error, "删除密钥"); },
  async writeLlmCall(e: LlmCallEntry) {
    const { error } = await db().from("llm_calls").insert({
      trace_id: e.trace_id, actor_id: e.actor_id, app_id: e.app_id ?? null, provider_id: e.provider_id,
      task_tier: e.task_tier, model: e.model, status: e.status, duration_ms: e.duration_ms,
      prompt_tokens: e.prompt_tokens ?? 0, completion_tokens: e.completion_tokens ?? 0, total_tokens: e.total_tokens ?? 0,
      attempt: e.attempt, redacted: e.redacted ?? false, error_code: e.error_code ?? null,
      error_message: e.error_message ? String(redact(e.error_message)).slice(0, 500) : null,
      ...(e.step_run_id ? { step_run_id: e.step_run_id } : {}),
    });
    if (error) console.error("[llm-call-write-failed]", e.trace_id, error.message);
  },
  async nextCode(appId, kind) {
    const { data, error } = await db().rpc("next_code", { _app_id: appId, _kind: kind });
    fail(error, "分配编号");
    return String(data);
  },
};

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}
export async function checkPassword(password: string, hash: string): Promise<boolean> {
  if (!hash.startsWith("$2")) return false;
  return bcrypt.compare(password, hash);
}

export async function authenticateCronRequest(request: Request): Promise<Response | null> {
  const secret = process.env["SDF_CRON_SECRET"];
  if (!secret) return new Response("Server configuration error", { status: 500 });
  const match = /^Bearer ([^\s,]+)$/.exec(request.headers.get("authorization") ?? "");
  if (!match?.[1]) return new Response("Unauthorized", { status: 401 });
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(digest(match[1]), digest(secret))) return new Response("Unauthorized", { status: 401 });
  return null;
}
