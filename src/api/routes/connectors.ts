import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "@/core/errors";
import { encryptSecret } from "@/core/secret-crypto";
import { codeRepo } from "@/core/connectors/factory";
import { normalizeGiteaApiBase } from "@/core/connectors/gitea";
import { postNotify } from "@/core/connectors/vendors";
import { bindMergeRequest, flowMetrics, ingestReport, issueIngestToken, receiveWebhook, saveGate, storeReports, syncPullRequests } from "@/adapters/stage2-store";
import { serviceQuery } from "@/adapters/pg-client";
import { processEnv } from "@/adapters/env";
import { dbFail } from "../middleware";
import { appAccess, rejectBusiness, requireRole } from "../perm";
import { parseJson, parseUuid } from "../validate";
import type { AppEnv } from "../context";

export const connectorRoutes = new Hono<AppEnv>();

const createInput = z.object({
  app_id: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  vendor: z.enum(["gitea", "github", "gitlab", "jira", "ado", "wecom", "dingtalk", "feishu", "webhook"]),
  capability: z.enum(["code_repo", "work_item", "notify"]),
  base_url: z.string().trim().url().max(300),
  token: z.string().min(4).max(300),
  webhook_secret: z.string().min(4).max(200).optional(),
  owner: z.string().trim().min(1).max(100).optional(),
  repo: z.string().trim().min(1).max(100).optional(),
  default_branch: z.string().trim().min(1).max(100).optional(),
});

connectorRoutes.get("/connectors", async (c) => {
  const admin = await c.get("db").rpc("is_admin");
  dbFail(admin.error);
  const rows = await serviceQuery()(
    `SELECT c.id, c.name, c.vendor, c.capability, c.status, c.last_error, c.config, b.binding, b.app_id, a.name AS app_name
     FROM public.connectors c
     LEFT JOIN public.app_connectors b ON b.connector_id = c.id
     LEFT JOIN public.apps a ON a.id = b.app_id
     ORDER BY c.name`,
  );
  if (admin.data === true) return c.json({ items: rows });
  const mine = await c.get("db").from("app_members").select("app_id,role").eq("user_id", c.get("userId"));
  dbFail(mine.error);
  const led = new Set((mine.data ?? []).filter((row) => row.role === "lead").map((row) => row.app_id));
  return c.json({ items: rows.filter((row) => led.has(String(row["app_id"] ?? ""))) });
});

connectorRoutes.get("/apps/:id/connectors", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  await appAccess(c, appId);
  const items = await serviceQuery()(
    `SELECT b.id, b.capability, b.binding, c.id AS connector_id, c.name, c.vendor, c.status, c.last_error, c.last_checked_at
     FROM public.app_connectors b JOIN public.connectors c ON c.id = b.connector_id WHERE b.app_id = $1`,
    [appId],
  );
  return c.json({ items });
});

connectorRoutes.post("/connectors", async (c) => {
  const input = await parseJson(c.req, createInput);
  requireRole(await appAccess(c, input.app_id), ["lead"], "只有负责人可以保存连接器");
  const key = processEnv.get("SDF_SECRET_KEY");
  if (!key) throw new AppError("SECRET_KEY_INVALID", "服务器还没有配置 SDF_SECRET_KEY");
  const sys = c.get("deps").sys;
  const secretId = crypto.randomUUID();
  const encrypted = await encryptSecret(input.token, key, secretId, "connector_token");
  await sys.createSecret({ id: secretId, kind: "connector_token", ciphertext: encrypted.ciphertext, last4: encrypted.last4, created_by: c.get("userId") });
  let webhookId: string | null = null;
  if (input.webhook_secret) {
    webhookId = crypto.randomUUID();
    const hook = await encryptSecret(input.webhook_secret, key, webhookId, "webhook_secret");
    await sys.createSecret({ id: webhookId, kind: "webhook_secret", ciphertext: hook.ciphertext, last4: hook.last4, created_by: c.get("userId") });
  }
  const normalizedBaseUrl = input.vendor === "gitea" ? normalizeGiteaApiBase(input.base_url) : input.base_url.trim().replace(/\/+$/, "");
  const config = { base_url: normalizedBaseUrl, owner: input.owner ?? "", repo: input.repo ?? "", default_branch: input.default_branch ?? "main" };
  const saved = await serviceQuery()(
    `INSERT INTO public.connectors(capability, vendor, name, config, secret_id, webhook_secret_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,'untested') RETURNING id`,
    [input.capability, input.vendor, input.name, config, secretId, webhookId],
  ).catch(async (error: unknown) => {
    await sys.deleteSecret(secretId).catch(() => undefined);
    if (webhookId) await sys.deleteSecret(webhookId).catch(() => undefined);
    throw error;
  });
  const connectorId = String(saved[0]?.["id"] ?? "");
  if (!connectorId) throw new AppError("DB_ERROR", "保存连接器失败");
  const binding = { owner: input.owner ?? "", repo: input.repo ?? "", default_branch: input.default_branch ?? "main" };
  const bound = await serviceQuery()(
    `INSERT INTO public.app_connectors(app_id, connector_id, capability, binding) VALUES ($1,$2,$3,$4)
     ON CONFLICT (app_id, capability) DO UPDATE SET connector_id = EXCLUDED.connector_id, binding = EXCLUDED.binding
     RETURNING id`,
    [input.app_id, connectorId, input.capability, binding],
  );
  return c.json({ id: connectorId, app_connector_id: bound[0]?.["id"] }, 201);
});

connectorRoutes.post("/connectors/:id/test", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const admin = await c.get("db").rpc("is_admin");
  if (admin.data !== true) {
    const links = await serviceQuery()(`SELECT app_id FROM public.app_connectors WHERE connector_id = $1`, [id]);
    let allowed = false;
    for (const link of links) {
      try { requireRole(await appAccess(c, String(link["app_id"])), ["lead"]); allowed = true; }
      catch { /* 这个应用没有权限，继续看下一处绑定 */ }
    }
    if (!allowed) throw new AppError("FORBIDDEN", "只有管理员或应用负责人可以测试连接");
  }
  const found = await serviceQuery()(`SELECT id, vendor, capability, config, secret_id FROM public.connectors WHERE id = $1`, [id]);
  const row = found[0];
  if (!row) throw new AppError("NOT_FOUND", "连接器不存在");
  const stored = await c.get("deps").sys.readSecret(String(row["secret_id"]));
  const key = processEnv.get("SDF_SECRET_KEY");
  if (!stored || !key) throw new AppError("SECRET_DECRYPT_FAILED", "连接器令牌无法读取");
  const token = await decryptFor(stored, key);
  const config = row["config"] as { base_url: string; owner?: string; repo?: string; default_branch?: string };
  try {
    if (row["capability"] === "code_repo") {
      await codeRepo(String(row["vendor"]), { base_url: config.base_url, owner: config.owner ?? "", repo: config.repo ?? "", ...(config.default_branch ? { default_branch: config.default_branch } : {}) }, token).testConnection();
    } else if (row["capability"] === "notify") {
      await postNotify(config.base_url, "SDF 连接测试");
    } else {
      throw new AppError("VALIDATION", "请在应用里绑定具体项目后再测试工作项");
    }
    await serviceQuery()(`UPDATE public.connectors SET status = 'success', last_checked_at = now(), last_error = NULL WHERE id = $1`, [id]);
    return c.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 180) : "连接失败";
    await serviceQuery()(`UPDATE public.connectors SET status = 'error', last_checked_at = now(), last_error = $2 WHERE id = $1`, [id, message]);
    throw new AppError("VALIDATION", "连接测试没有通过");
  }
});

connectorRoutes.get("/apps/:id/merge-requests", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  rejectBusiness(await appAccess(c, appId));
  const items = await serviceQuery()(
    `SELECT m.id, m.number, m.title, m.url, m.state, m.branch, m.matched_by, m.out_of_scope_files, t.code AS task_code
     FROM public.merge_requests m LEFT JOIN public.tasks t ON t.id = m.task_id
     WHERE m.app_id = $1 ORDER BY m.updated_at DESC LIMIT 50`,
    [appId],
  );
  return c.json({ items });
});

connectorRoutes.post("/apps/:id/merge-requests/:mrId/bind", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  const mrId = parseUuid(c.req.param("mrId"));
  requireRole(await appAccess(c, appId), ["lead", "dev"], "只有负责人或开发可以认领合并请求");
  const input = await parseJson(c.req, z.object({ task_code: z.string().trim().regex(/^T-\d+$/) }));
  await bindMergeRequest(appId, mrId, input.task_code);
  await c.get("deps").sys.writeAudit({
    trace_id: c.get("traceId"), actor_id: c.get("userId"), app_id: appId,
    action: "merge_request.bound", target_type: "merge_request", target_id: mrId, detail: { task_code: input.task_code },
  });
  return c.json({ ok: true });
});

connectorRoutes.post("/apps/:id/merge-requests/:mrId/accept", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  const mrId = parseUuid(c.req.param("mrId"));
  requireRole(await appAccess(c, appId), ["lead", "qa"], "只有负责人或测试可以运行隔离验收");
  const { runIsolatedAcceptance } = await import("@/adapters/isolated-acceptance");
  const saved = await runIsolatedAcceptance(appId, mrId, true);
  return c.json(saved);
});

connectorRoutes.post("/apps/:id/merge-requests/sync", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead", "dev"], "只有负责人或开发可以同步合并请求");
  const count = await syncPullRequests(appId);
  return c.json({ count });
});

connectorRoutes.post("/apps/:id/ingest-tokens", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead"], "只有负责人可以签发上传令牌");
  const input = await parseJson(c.req, z.object({ name: z.string().trim().min(1).max(80) }));
  const token = await issueIngestToken(appId, input.name, c.get("userId"));
  return c.json({ token }, 201);
});

connectorRoutes.get("/apps/:id/gates", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  await appAccess(c, appId);
  const rows = await c.get("db").from("gate_results").select("item_key,status,numerator,denominator,evidence,waiver_reason,created_at").eq("app_id", appId).order("created_at", { ascending: false }).limit(20);
  dbFail(rows.error);
  return c.json({ items: rows.data ?? [] });
});

connectorRoutes.post("/apps/:id/gates/run", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead", "qa"], "只有负责人或测试可以执行交付检查");
  return c.json(await saveGate(appId, null));
});

connectorRoutes.post("/apps/:id/reports", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead", "qa"], "只有负责人或测试可以导入报告");
  const body = z.object({ junit: z.string().max(2_000_000).optional(), sarif: z.string().max(2_000_000).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new AppError("VALIDATION", "请提供 JUnit 或 SARIF 正文");
  return c.json(await storeReports(appId, body.data.junit ?? null, body.data.sarif ?? null));
});

connectorRoutes.get("/apps/:id/flow-metrics", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  await appAccess(c, appId);
  return c.json(await flowMetrics(appId));
});

connectorRoutes.post("/apps/:id/gates/waive", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead"], "只有负责人可以例外放行");
  const input = await parseJson(c.req, z.object({ item_key: z.string().trim().min(2).max(40), reason: z.string().trim().min(2).max(500) }));
  const updated = await serviceQuery()(
    `UPDATE public.gate_results SET waiver_reason = $3, waived_by = $4
     WHERE id = (
       SELECT id FROM public.gate_results WHERE app_id = $1 AND item_key = $2 ORDER BY created_at DESC LIMIT 1
     ) RETURNING id`,
    [appId, input.item_key, input.reason, c.get("userId")],
  );
  if (!updated[0]) throw new AppError("NOT_FOUND", "还没有这项交付检查");
  await c.get("deps").sys.writeAudit({
    trace_id: c.get("traceId"), actor_id: c.get("userId"), app_id: appId,
    action: "gate.waived", target_type: "gate_result", target_id: String(updated[0]["id"]),
    detail: { item_key: input.item_key, reason: input.reason },
  });
  return c.json({ ok: true });
});

connectorRoutes.post("/public/hooks/scm/:id", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const raw = await c.req.text();
  const signature = c.req.header("x-gitea-signature") ?? c.req.header("x-hub-signature-256") ?? c.req.header("x-gitlab-token");
  return c.json(await receiveWebhook(id, raw, signature));
});

connectorRoutes.post("/public/hooks/ingest/reports", async (c) => {
  const type = c.req.header("content-type") ?? "";
  let junit: string | null = null;
  let sarif: string | null = null;
  if (type.includes("multipart/form-data")) {
    const body = await c.req.parseBody();
    junit = await fileText(body["junit"]);
    sarif = await fileText(body["sarif"]);
  } else {
    const body = await c.req.json() as { junit?: string; sarif?: string };
    junit = body.junit ?? null;
    sarif = body.sarif ?? null;
  }
  return c.json(await ingestReport(c.req.header("authorization"), junit, sarif));
});

async function fileText(value: unknown): Promise<string | null> {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value && typeof (value as { text: () => Promise<string> }).text === "function") return (value as { text: () => Promise<string> }).text();
  return null;
}

async function decryptFor(stored: { id: string; kind: string; ciphertext: string }, key: string): Promise<string> {
  const kind = stored.kind === "webhook_secret" || stored.kind === "connector_token" || stored.kind === "llm_provider" ? stored.kind : "connector_token";
  const { decryptSecret } = await import("@/core/secret-crypto");
  return decryptSecret(stored.ciphertext, key, stored.id, kind);
}
