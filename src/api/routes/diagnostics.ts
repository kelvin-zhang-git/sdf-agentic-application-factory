import { Hono } from "hono";
import { z } from "zod";
import { newErrorId } from "@/core/errors";
import { FEATURES, API_VERSION } from "@/core/meta";
import { diagnosticBundle } from "@/core/log";
import { decryptSecret, encryptSecret } from "@/core/secret-crypto";
import { dbFail, requireAdmin } from "../middleware";
import { parseJson } from "../validate";
import type { AppEnv } from "../context";

export const diagnosticRoutes = new Hono<AppEnv>();
diagnosticRoutes.post("/client-errors", async (c) => {
  // Only allow safe error categories and operation names, never arbitrary messages/stack/URL query.
  const input = await parseJson(c.req, z.object({
    code: z.enum(["RENDER_ERROR", "UNHANDLED_ERROR", "UNHANDLED_REJECTION"]),
    path: z.string().regex(/^\/[A-Za-z0-9_\-/.$]*$/).max(300),
    operations: z.array(z.enum(["click", "submit", "navigate"])).max(20).default([]),
  }));
  const errorId = newErrorId();
  await c.get("deps").sys.writeClientError({ actor_id: c.get("userId"), trace_id: c.get("traceId"), error_id: errorId, code: input.code, path: input.path, detail: { operations: input.operations } });
  return c.json({ ok: true, error_id: errorId, trace_id: c.get("traceId") });
});
diagnosticRoutes.use("/admin/*", requireAdmin);
diagnosticRoutes.get("/admin/logs", async (c) => {
  const search = z.string().max(80).regex(/^[A-Za-z0-9_-]*$/).parse(c.req.query("error_id") ?? "");
  const db = c.get("db");
  let logs = db.from("app_logs").select("*").order("created_at", { ascending: false }).limit(100);
  let clients = db.from("client_errors").select("*").order("created_at", { ascending: false }).limit(100);
  if (search) { logs = logs.eq("error_id", search); clients = clients.eq("error_id", search); }
  const [a, b] = await Promise.all([logs, clients]); dbFail(a.error); dbFail(b.error);
  const traces = [...new Set([...(a.data ?? []), ...(b.data ?? [])].map((row) => row.trace_id))];
  let calls = db.from("llm_calls").select("*").order("created_at", { ascending: false }).limit(100);
  if (search) calls = calls.in("trace_id", traces.length ? traces : ["no-matching-trace"]);
  const models = await calls; dbFail(models.error);
  return c.json(diagnosticBundle({ version: API_VERSION }, a.data ?? [], b.data ?? [], models.data ?? []));
});
diagnosticRoutes.get("/admin/diagnostics", async (c) => {
  const db = c.get("db");
  const [a,b,m] = await Promise.all([
    db.from("app_logs").select("*").order("created_at", { ascending: false }).limit(100),
    db.from("client_errors").select("*").order("created_at", { ascending: false }).limit(100),
    db.from("llm_calls").select("id,trace_id,model,status,duration_ms,total_tokens,error_code,created_at").order("created_at", { ascending: false }).limit(100),
  ]); dbFail(a.error); dbFail(b.error); dbFail(m.error);
  await c.get("deps").sys.writeAudit({ actor_id: c.get("userId"), trace_id: c.get("traceId"), action: "system.diagnostics_exported" });
  return c.json(diagnosticBundle({ version: API_VERSION, features: FEATURES }, a.data ?? [], b.data ?? [], m.data ?? []));
});
diagnosticRoutes.get("/admin/health", async (c) => {
  const db = c.get("db");
  const boot = await db.rpc("is_bootstrapped"); dbFail(boot.error);
  let keyValid = false;
  const key = c.get("deps").env.get("SDF_SECRET_KEY");
  if (key) { try { await encryptSecret("health-check", key, crypto.randomUUID(), "llm_provider"); keyValid = true; } catch { /* never expose key-derived data */ } }
  const logs = await db.from("app_logs").select("id").limit(1); dbFail(logs.error);
  const [cleanup, catalog, artifacts, providers, calls] = await Promise.all([
    db.from("cleanup_runs").select("*").order("finished_at", { ascending: false }).limit(1),
    db.from("example_catalog").select("id,kind"),
    db.from("example_artifacts").select("id"),
    db.from("llm_providers").select("secret_id"),
    db.from("llm_calls").select("id").not("app_id", "is", null).eq("status", "success").limit(1),
  ]);
  for (const result of [cleanup, catalog, artifacts, providers, calls]) dbFail(result.error);
  let decryptable = Boolean(key && providers.data?.length);
  if (key) for (const provider of providers.data ?? []) {
    try { const stored = await c.get("deps").sys.readSecret(provider.secret_id); if (!stored) { decryptable = false; continue; } await decryptSecret(stored.ciphertext, key, provider.secret_id, "llm_provider"); }
    catch { decryptable = false; }
  }
  const lastCleanup = cleanup.data?.[0];
  const wf = await db.from("workflows").select("key,startable").eq("key", "requirement_only"); dbFail(wf.error);
  const userClaim = await db.rpc("claim_step" as never, { _run: null, _lease_seconds: 1 } as never);
  const requirementReady = (wf.data ?? []).some((row) => row.startable === true);
  return c.json({ checks: [
    { name: "管理员权限与数据库连接", status: "passed" },
    { name: "初始化入口关闭", status: boot.data ? "passed" : "failed" },
    { name: "加密密钥格式与加密能力", status: keyValid ? "passed" : "failed" },
    { name: "系统日志读取", status: "passed" },
    { name: "已配置凭据逐条解密", status: decryptable ? "passed" : "failed" },
    { name: "定时清理最近执行（每小时，日志保留30天）", status: lastCleanup && Date.now() - new Date(lastCleanup.finished_at).getTime() < 2 * 60 * 60 * 1000 ? "passed" : "failed" },
    { name: "示例目录（33个积木、10个角色）", status: catalog.data?.filter((item) => item.kind === "block").length === 33 && catalog.data?.filter((item) => item.kind === "agent").length === 10 ? "passed" : "failed" },
    { name: "示例制品读取", status: artifacts.data?.length ? "passed" : "failed" },
    { name: "真实应用调用成功记录", status: calls.data?.length ? "passed" : "failed" },
    { name: "内置工作流 requirement_only 可启动", status: requirementReady ? "passed" : "failed" },
    { name: "引擎函数禁止普通用户直接调用", status: userClaim.error ? "passed" : "failed" },
    ...FEATURES.filter((f) => f.status !== "implemented").map((f) => ({ name: f.name, status: "not_started" })),
  ], cleanup: lastCleanup ?? null });
});