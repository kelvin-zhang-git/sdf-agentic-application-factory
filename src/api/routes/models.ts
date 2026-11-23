import { Hono, type Context } from "hono";
import { z } from "zod";
import { AppError, newErrorId } from "@/core/errors";
import { decryptSecret, encryptSecret } from "@/core/secret-crypto";
import {
  callChatCompletion,
  listOpenAiModels,
  normalizeProviderBaseUrl,
  redactMessages,
  selectModelCandidates,
  type Classification,
  type LlmProvider,
  type ModelRoute,
  type TaskTier,
} from "@/core/llm";
import type { LlmCallEntry } from "@/core/ports";
import { dbFail, requireAdmin } from "../middleware";
import { parseJson, parseUuid } from "../validate";
import type { AppEnv } from "../context";

export const modelRoutes = new Hono<AppEnv>();
modelRoutes.use("*", requireAdmin);

const tier = z.enum(["fast", "standard", "deep"]);
const modelId = z.string().trim().min(1).max(200);
const providerFields = z.object({
  name: z.string().trim().min(1).max(100),
  base_url: z.string().trim().min(1).max(1000),
  models: z.array(modelId).max(100),
  allowed_for_sensitive: z.boolean(),
  enabled: z.boolean(),
  priority: z.number().int().min(1).max(100000),
});
const createProviderInput = providerFields.extend({ api_key: z.string().min(4).max(8192) });
const updateProviderInput = providerFields.partial().extend({ api_key: z.string().min(4).max(8192).optional() });
const routeInput = z.object({
  task_tier: tier,
  provider_id: z.string().uuid(),
  model: modelId,
  fallback_order: z.number().int().min(1).max(100),
});

function uniqueModels(models: string[]): string[] {
  return Array.from(new Set(models.map((m) => m.trim()).filter(Boolean)));
}

function audit(c: Context<AppEnv>, action: string, targetId: string, detail?: Record<string, unknown>) {
  return c.get("deps").sys.writeAudit({
    trace_id: c.get("traceId"), actor_id: c.get("userId"), action,
    target_type: "model_configuration", target_id: targetId, detail,
  });
}

async function providerById(c: Context<AppEnv>, id: string): Promise<LlmProvider> {
  const { data, error } = await c.get("db").from("llm_providers").select("*").eq("id", id).maybeSingle();
  dbFail(error);
  if (!data) throw new AppError("NOT_FOUND", "模型服务不存在");
  return data;
}

async function providerKey(c: Context<AppEnv>, provider: LlmProvider): Promise<string> {
  const { sys, env } = c.get("deps");
  const stored = await sys.readSecret(provider.secret_id);
  if (!stored) throw new AppError("SECRET_DECRYPT_FAILED", "密钥不存在或无法读取，请重新填写");
  const key = env.get("SDF_SECRET_KEY");
  if (!key) throw new AppError("SECRET_KEY_INVALID", "尚未配置 SDF_SECRET_KEY");
  return decryptSecret(stored.ciphertext, key, provider.secret_id, "llm_provider");
}

async function record(c: Context<AppEnv>, entry: Omit<LlmCallEntry, "trace_id" | "actor_id">) {
  await c.get("deps").sys.writeLlmCall({ ...entry, trace_id: c.get("traceId"), actor_id: c.get("userId") });
}

const EXPECTED_MODEL_ERRORS = new Set([
  "LLM_UNAVAILABLE", "LLM_HTTP", "LLM_TIMEOUT", "LLM_RESPONSE_INVALID",
  "SECRET_KEY_INVALID", "SECRET_DECRYPT_FAILED",
]);

function asExpectedModelError(error: unknown): AppError | null {
  if (!(error instanceof AppError)) return new AppError("LLM_UNAVAILABLE", "无法连接模型服务，请检查地址和网络");
  return EXPECTED_MODEL_ERRORS.has(error.code) ? error : null;
}

// A reachable API with a failed external-model result is not an application crash.
// Return a structured 200 result; the data layer turns it back into a local, caught ApiError.
async function expectedModelFailure(c: Context<AppEnv>, error: AppError) {
  const errorId = newErrorId();
  await c.get("deps").sys.writeServerLog({ actor_id: c.get("userId"), trace_id: c.get("traceId"), error_id: errorId, code: error.code, level: "error", path: c.req.path, method: c.req.method, status: 200, duration_ms: 0 });
  return {
    errorId,
    response: c.json({
      ok: false,
      error: { code: error.code, message: error.message, error_id: errorId, trace_id: c.get("traceId") },
    }),
  };
}

modelRoutes.get("/", async (c) => {
  const db = c.get("db");
  const [p, r] = await Promise.all([
    db.from("llm_providers").select("*").order("priority").order("created_at"),
    db.from("model_routes").select("*").order("task_tier").order("fallback_order"),
  ]);
  dbFail(p.error); dbFail(r.error);
  const metadata = await c.get("deps").sys.secretMetadata((p.data ?? []).map((x) => x.secret_id));
  const last4 = new Map(metadata.map((x) => [x.id, x.last4]));
  return c.json({
    providers: (p.data ?? []).map((x) => ({ ...x, key_last4: last4.get(x.secret_id) ?? null })),
    routes: r.data ?? [],
  });
});

modelRoutes.post("/providers", async (c) => {
  const input = await parseJson(c.req, createProviderInput);
  const { sys, env } = c.get("deps");
  const key = env.get("SDF_SECRET_KEY");
  if (!key) throw new AppError("SECRET_KEY_INVALID", "尚未配置 SDF_SECRET_KEY，无法保存模型密钥");
  const secretId = crypto.randomUUID();
  const values = {
    name: input.name,
    base_url: normalizeProviderBaseUrl(input.base_url),
    models: uniqueModels(input.models),
    secret_id: secretId,
    allowed_for_sensitive: input.allowed_for_sensitive,
    enabled: input.enabled,
    priority: input.priority,
    created_by: c.get("userId"),
  };
  const encrypted = await encryptSecret(input.api_key, key, secretId, "llm_provider");
  await sys.createSecret({ id: secretId, kind: "llm_provider", ciphertext: encrypted.ciphertext, last4: encrypted.last4, created_by: c.get("userId") });
  const { data, error } = await c.get("db").from("llm_providers").insert(values).select().maybeSingle();
  if (error || !data) {
    await sys.deleteSecret(secretId).catch(() => undefined);
    dbFail(error, "保存模型服务失败");
    throw new AppError("DB_ERROR", "保存模型服务失败");
  }
  await audit(c, "model.provider_created", data.id, { name: data.name, base_url: data.base_url, models: data.models, allowed_for_sensitive: data.allowed_for_sensitive });
  return c.json({ ...data, key_last4: encrypted.last4 }, 201);
});

modelRoutes.patch("/providers/:id", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const input = await parseJson(c.req, updateProviderInput);
  const existing = await providerById(c, id);
  const { api_key: apiKey, ...fields } = input;
  const values = {
    ...(fields.name !== undefined ? { name: fields.name } : {}),
    ...(fields.base_url !== undefined ? { base_url: normalizeProviderBaseUrl(fields.base_url) } : {}),
    ...(fields.models !== undefined ? { models: uniqueModels(fields.models) } : {}),
    ...(fields.allowed_for_sensitive !== undefined ? { allowed_for_sensitive: fields.allowed_for_sensitive } : {}),
    ...(fields.enabled !== undefined ? { enabled: fields.enabled } : {}),
    ...(fields.priority !== undefined ? { priority: fields.priority } : {}),
  };
  const { data, error } = await c.get("db").from("llm_providers").update(values).eq("id", id).select().maybeSingle();
  dbFail(error, "保存模型服务失败");
  if (!data) throw new AppError("FORBIDDEN", "没有权限修改模型服务");
  let last4: string | null = null;
  if (apiKey !== undefined) {
    const key = c.get("deps").env.get("SDF_SECRET_KEY");
    if (!key) throw new AppError("SECRET_KEY_INVALID", "尚未配置 SDF_SECRET_KEY，无法更新模型密钥");
    const encrypted = await encryptSecret(apiKey, key, existing.secret_id, "llm_provider");
    await c.get("deps").sys.updateSecret({ id: existing.secret_id, kind: "llm_provider", ciphertext: encrypted.ciphertext, last4: encrypted.last4 });
    last4 = encrypted.last4;
    await audit(c, "model.secret_rotated", id, { provider_id: id });
  }
  await audit(c, "model.provider_updated", id, { fields: Object.keys(fields), secret_rotated: apiKey !== undefined });
  return c.json({ ...data, key_last4: last4 });
});

modelRoutes.delete("/providers/:id", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const existing = await providerById(c, id);
  const { data, error } = await c.get("db").from("llm_providers").delete().eq("id", id).select().maybeSingle();
  dbFail(error, "删除模型服务失败");
  if (!data) throw new AppError("FORBIDDEN", "没有权限删除模型服务");
  await c.get("deps").sys.deleteSecret(existing.secret_id);
  await audit(c, "model.provider_deleted", id, { name: existing.name });
  return c.json({ ok: true });
});

modelRoutes.post("/providers/:id/discover", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const provider = await providerById(c, id);
  try {
    const apiKey = await providerKey(c, provider);
    const models = await listOpenAiModels({ baseUrl: provider.base_url, apiKey });
    const { error } = await c.get("db").from("llm_providers").update({ models }).eq("id", id);
    dbFail(error, "保存模型列表失败");
    await audit(c, "model.models_discovered", id, { count: models.length });
    return c.json({ ok: true as const, models });
  } catch (error) {
    const e = asExpectedModelError(error);
    if (!e) throw error;
    const failure = await expectedModelFailure(c, e);
    await c.get("db").from("llm_providers").update({
      last_status: "error", last_checked_at: new Date().toISOString(),
      last_error: `${e.message}（错误编号 ${failure.errorId}）`,
    }).eq("id", id);
    return failure.response;
  }
});

modelRoutes.post("/providers/:id/test", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const input = await parseJson(c.req, z.object({ model: modelId }));
  const provider = await providerById(c, id);
  if (!provider.models.includes(input.model)) throw new AppError("VALIDATION", "该模型 ID 不在此模型服务的数据库配置中");
  const started = Date.now();
  try {
    const apiKey = await providerKey(c, provider);
    const result = await callChatCompletion({
      baseUrl: provider.base_url, apiKey, model: input.model,
      messages: [{ role: "user", content: "请只回复 OK" }], maxTokens: 256, timeoutMs: 120_000,
    });
    const duration = Date.now() - started;
    await record(c, { provider_id: id, task_tier: "standard", model: input.model, status: "success", duration_ms: duration, ...result.usage, attempt: 1, redacted: false });
    const { error } = await c.get("db").from("llm_providers").update({ last_status: "success", last_checked_at: new Date().toISOString(), last_error: null }).eq("id", id);
    dbFail(error, "保存测试结果失败");
    return c.json({ ok: true, model: input.model, duration_ms: duration, usage: result.usage, reply: result.content.slice(0, 200) });
  } catch (error) {
    const e = asExpectedModelError(error);
    if (!e) throw error;
    const failure = await expectedModelFailure(c, e);
    const message = `${e.message}（错误编号 ${failure.errorId}）`;
    await record(c, { provider_id: id, task_tier: "standard", model: input.model, status: "error", duration_ms: Date.now() - started, attempt: 1, redacted: false, error_code: e.code, error_message: message });
    await c.get("db").from("llm_providers").update({ last_status: "error", last_checked_at: new Date().toISOString(), last_error: message }).eq("id", id);
    return failure.response;
  }
});

modelRoutes.post("/routes", async (c) => {
  const input = await parseJson(c.req, routeInput);
  const provider = await providerById(c, input.provider_id);
  if (!provider.models.includes(input.model)) throw new AppError("VALIDATION", "模型 ID 必须来自所选模型服务的数据库配置");
  const { data, error } = await c.get("db").from("model_routes").insert({ ...input, created_by: c.get("userId") }).select().maybeSingle();
  dbFail(error, "保存模型路由失败");
  if (!data) throw new AppError("FORBIDDEN", "没有权限保存模型路由");
  await audit(c, "model.route_created", data.id, { task_tier: input.task_tier, provider_id: input.provider_id, model: input.model, fallback_order: input.fallback_order });
  return c.json(data, 201);
});

modelRoutes.patch("/routes/:id", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const input = await parseJson(c.req, routeInput.partial());
  const current = await c.get("db").from("model_routes").select("*").eq("id", id).maybeSingle();
  dbFail(current.error);
  if (!current.data) throw new AppError("NOT_FOUND", "模型路由不存在");
  const providerId = input.provider_id ?? current.data.provider_id;
  const model = input.model ?? current.data.model;
  const provider = await providerById(c, providerId);
  if (!provider.models.includes(model)) throw new AppError("VALIDATION", "模型 ID 必须来自所选模型服务的数据库配置");
  const values = {
    ...(input.task_tier !== undefined ? { task_tier: input.task_tier } : {}),
    ...(input.provider_id !== undefined ? { provider_id: input.provider_id } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.fallback_order !== undefined ? { fallback_order: input.fallback_order } : {}),
  };
  const { data, error } = await c.get("db").from("model_routes").update(values).eq("id", id).select().maybeSingle();
  dbFail(error, "保存模型路由失败");
  if (!data) throw new AppError("FORBIDDEN", "没有权限保存模型路由");
  await audit(c, "model.route_updated", id, { fields: Object.keys(input) });
  return c.json(data);
});

modelRoutes.delete("/routes/:id", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const { data, error } = await c.get("db").from("model_routes").delete().eq("id", id).select().maybeSingle();
  dbFail(error, "删除模型路由失败");
  if (!data) throw new AppError("NOT_FOUND", "模型路由不存在或没有权限");
  await audit(c, "model.route_deleted", id, { task_tier: data.task_tier, model: data.model });
  return c.json({ ok: true });
});

modelRoutes.post("/invoke", async (c) => {
  const input = await parseJson(c.req, z.object({
    app_id: z.string().uuid(),
    task_tier: tier,
    messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string().min(1).max(20000) })).min(1).max(20),
    max_tokens: z.number().int().min(1).max(4096).optional(),
  }));
  const db = c.get("db");
  const app = await db.from("apps").select("id,classification,redact_before_llm,redact_terms").eq("id", input.app_id).maybeSingle();
  dbFail(app.error);
  if (!app.data) throw new AppError("NOT_FOUND", "应用不存在或您没有访问权限");
  const [p, r] = await Promise.all([db.from("llm_providers").select("*"), db.from("model_routes").select("*")]);
  dbFail(p.error); dbFail(r.error);
  const candidates = selectModelCandidates(input.task_tier, app.data.classification as Classification, p.data ?? [], (r.data ?? []) as ModelRoute[]);
  const customTerms = Array.isArray(app.data.redact_terms) ? (app.data.redact_terms as string[]) : [];
  const messages = app.data.redact_before_llm ? redactMessages(input.messages, customTerms) : input.messages;
  let attempt = 0;
  for (const { provider, route } of candidates) {
    attempt += 1;
    const started = Date.now();
    try {
      const apiKey = await providerKey(c, provider);
      const result = await callChatCompletion({
        baseUrl: provider.base_url, apiKey, model: route.model, messages,
        ...(input.max_tokens !== undefined ? { maxTokens: input.max_tokens } : {}),
        timeoutMs: 120_000,
      });
      await record(c, {
        app_id: app.data.id, provider_id: provider.id, task_tier: input.task_tier, model: route.model,
        status: "success", duration_ms: Date.now() - started, ...result.usage, attempt,
        redacted: app.data.redact_before_llm,
      });
      return c.json({
        ok: true as const,
        content: result.content, usage: result.usage, provider_id: provider.id, provider_name: provider.name,
        model: route.model, task_tier: input.task_tier as TaskTier, attempt, redacted: app.data.redact_before_llm,
        trace_id: c.get("traceId"),
      });
    } catch (error) {
      const e = error instanceof AppError ? error : new AppError("LLM_UNAVAILABLE", "模型调用失败");
      await record(c, {
        app_id: app.data.id, provider_id: provider.id, task_tier: input.task_tier, model: route.model,
        status: "error", duration_ms: Date.now() - started, attempt, redacted: app.data.redact_before_llm,
        error_code: e.code, error_message: e.message,
      });
    }
  }
  return (await expectedModelFailure(c, new AppError("LLM_UNAVAILABLE", "主模型和备用模型均调用失败，请检查地址、密钥和模型 ID"))).response;
});

modelRoutes.get("/calls", async (c) => {
  const { data, error } = await c.get("db").from("llm_calls").select("*").order("created_at", { ascending: false }).limit(100);
  dbFail(error);
  return c.json({ items: data ?? [] });
});
