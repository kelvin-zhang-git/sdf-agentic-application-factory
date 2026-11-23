import { Hono } from "hono";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { zipSync, strToU8 } from "fflate";
import { AppError } from "@/core/errors";
import { ROLE_OF_BLOCK } from "@/core/agents";
import { planPreview, validateWorkflow } from "@/core/engine/validate";
import { disabledBlockIds } from "./examples";
import type { WorkflowDef } from "@/core/engine/builtin";
import { createServiceDb, serviceQuery } from "@/adapters/pg-client";
import { dbFail } from "../middleware";
import { appAccess, requireRole } from "../perm";
import { parseJson, parseUuid } from "../validate";
import type { AppEnv } from "../context";

export const stage4Routes = new Hono<AppEnv>();
const WEIGHTS = ["light", "standard", "full"] as const;

function like(q: string): string {
  return `%${q.replace(/[%_\\]/g, "")}%`;
}

stage4Routes.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 80);
  if (q.length < 2) return c.json({ items: [] });
  const db = c.get("db");
  const code = /^(REQ|AC|FB|CR|T|TC|DEC|R)-/i.test(q);
  const pattern = code ? `${q.replace(/[%_\\]/g, "")}%` : like(q);
  const col = code ? "code" : "title";
  const [requirements, criteria, feedback, changes, tasks, cases, decisions, runs] = await Promise.all([
    db.from("requirements").select("id,app_id,code,title").ilike(code ? "code" : "title", pattern).limit(8),
    db.from("acceptance_criteria").select("id,app_id,code,text").ilike(code ? "code" : "text", pattern).limit(8),
    db.from("feedback_items").select("id,app_id,code,title").ilike(col, pattern).limit(8),
    db.from("change_requests").select("id,app_id,code,title").ilike(col, pattern).limit(8),
    db.from("tasks").select("id,app_id,code,title").ilike(col, pattern).limit(8),
    db.from("test_cases").select("id,app_id,code,title").ilike(col, pattern).limit(8),
    db.from("decisions").select("id,app_id,code,title").ilike(col, pattern).limit(8),
    db.from("workflow_runs").select("id,app_id,code").ilike("code", code ? pattern : like(q)).limit(8),
  ]);
  for (const result of [requirements, criteria, feedback, changes, tasks, cases, decisions, runs]) dbFail(result.error);
  const items = [
    ...(requirements.data ?? []).map((row) => hit("需求", row.code, row.title, row.app_id, null)),
    ...(criteria.data ?? []).map((row) => hit("验收标准", row.code, row.text, row.app_id, null)),
    ...(feedback.data ?? []).map((row) => hit("反馈", row.code, row.title, row.app_id, null)),
    ...(changes.data ?? []).map((row) => hit("变更", row.code, row.title, row.app_id, null)),
    ...(tasks.data ?? []).map((row) => hit("任务", row.code, row.title, row.app_id, null)),
    ...(cases.data ?? []).map((row) => hit("用例", row.code, row.title, row.app_id, null)),
    ...(decisions.data ?? []).map((row) => hit("决策", row.code, row.title, row.app_id, null)),
    ...(runs.data ?? []).map((row) => hit("运行", row.code, row.code, row.app_id, row.id)),
  ].slice(0, 20);
  return c.json({ items });
});

function hit(kind: string, code: string, title: string, appId: string, runId: string | null) {
  return { kind, code, title, app_id: appId, run_id: runId };
}

stage4Routes.post("/apps/:id/comments", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  await appAccess(c, appId);
  const input = await parseJson(c.req, z.object({
    body: z.string().trim().min(1).max(2000),
    target_kind: z.string().trim().min(2).max(40).default("app"),
    target_id: z.string().uuid().optional(),
  }));
  const emails = [...input.body.matchAll(/@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)].map((item) => item[1]?.toLowerCase() ?? "");
  const people = emails.length ? await c.get("db").from("profiles").select("id,email").in("email", emails) : { data: [], error: null };
  dbFail(people.error);
  const mentioned = [...new Set((people.data ?? []).map((row) => row.id))];
  const saved = await c.get("db").from("comments").insert({
    app_id: appId,
    target_kind: input.target_kind,
    target_id: input.target_id ?? appId,
    body: input.body,
    author_id: c.get("userId"),
    mentioned_user_ids: mentioned,
  }).select("id").single();
  dbFail(saved.error);
  return c.json({ id: saved.data?.id, mentioned }, 201);
});

function parsedWorkflow(yamlText: string): WorkflowDef {
  let parsed: unknown;
  try { parsed = parse(yamlText); } catch { throw new AppError("VALIDATION", "YAML 无法解析"); }
  const def = parsed as WorkflowDef;
  if (!def || typeof def !== "object" || !Array.isArray(def.steps)) throw new AppError("VALIDATION", "YAML 里需要有 steps");
  return def;
}

stage4Routes.post("/workflows/validate", async (c) => {
  const input = await parseJson(c.req, z.object({ yaml: z.string().min(2).max(100_000) }));
  const def = parsedWorkflow(input.yaml);
  const issues = validateWorkflow(stringify(def), def, undefined, true);
  const disabled = await disabledBlockIds(c.get("db"));
  return c.json({ issues, plans: Object.fromEntries(WEIGHTS.map((weight) => [weight, planPreview(def, weight, disabled)])) });
});

stage4Routes.post("/workflows", async (c) => {
  const input = await parseJson(c.req, z.object({
    id: z.string().uuid().optional(),
    app_id: z.string().uuid().nullable().optional(),
    key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,40}$/),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).default(""),
    yaml: z.string().min(2).max(100_000),
    copied_from: z.string().uuid().nullable().optional(),
  }));
  const admin = await c.get("db").rpc("is_admin");
  dbFail(admin.error);
  if (input.app_id) requireRole(await appAccess(c, input.app_id), ["lead"], "只有负责人可以保存这个应用的工作流");
  else if (admin.data !== true) throw new AppError("FORBIDDEN", "只有管理员可以保存全局工作流");
  const def = parsedWorkflow(input.yaml);
  def.key = input.key;
  def.name = input.name;
  const yaml = stringify(def);
  const issues = validateWorkflow(yaml, def, undefined, true);
  const startable = issues.length === 0;
  const db = createServiceDb();
  if (input.id) {
    const current = await db.from("workflows").select("id,is_builtin,version").eq("id", input.id).maybeSingle();
    dbFail(current.error);
    if (!current.data) throw new AppError("NOT_FOUND", "工作流不存在");
    if (current.data.is_builtin) throw new AppError("VALIDATION", "内置工作流不能修改，请先复制");
    const saved = await db.from("workflows").update({
      key: input.key, name: input.name, description: input.description, yaml, definition: def, startable, app_id: input.app_id ?? null,
    }).eq("id", input.id).select("id,version").single();
    dbFail(saved.error);
    return c.json({ id: saved.data?.id, version: saved.data?.version, startable, issues });
  }
  const version = "1.0.0";
  const saved = await db.from("workflows").insert({
    key: input.key, version, name: input.name, description: input.description, yaml, definition: def,
    is_builtin: false, startable, app_id: input.app_id ?? null, copied_from: input.copied_from ?? null,
  }).select("id,version").single();
  dbFail(saved.error);
  if (!saved.data) throw new AppError("DB_ERROR", saved.error?.message ?? "保存工作流失败");
  return c.json({ id: saved.data.id, version: saved.data.version, startable, issues }, 201);
});

stage4Routes.get("/agents", async (c) => {
  const db = c.get("db");
  const [roles, prompts, steps] = await Promise.all([
    db.from("agent_roles").select("key,name,summary,is_builtin").order("name"),
    db.from("agent_prompt_versions").select("role_key,version,prompt,created_at").order("version", { ascending: false }).limit(200),
    db.from("step_runs").select("block_key,decision,decision_comment,model_calls,tokens,status").in("status", ["succeeded", "rejected"]).limit(5000),
  ]);
  dbFail(roles.error); dbFail(prompts.error); dbFail(steps.error);
  const stats = new Map<string, { calls: number; tokens: number; approved: number; edited: number; rejected: number }>();
  for (const step of steps.data ?? []) {
    const role = ROLE_OF_BLOCK[step.block_key];
    if (!role) continue;
    const row = stats.get(role) ?? { calls: 0, tokens: 0, approved: 0, edited: 0, rejected: 0 };
    row.calls += Number(step.model_calls ?? 0);
    row.tokens += Number(step.tokens ?? 0);
    if (step.decision === "approve" && step.decision_comment) row.edited += 1;
    else if (step.decision === "approve") row.approved += 1;
    else if (step.decision === "reject" || step.status === "rejected") row.rejected += 1;
    stats.set(role, row);
  }
  const items = (roles.data ?? []).map((role) => {
    const versions = (prompts.data ?? []).filter((row) => row.role_key === role.key);
    return { ...role, prompt: versions[0]?.prompt ?? "", version: versions[0]?.version ?? 0, versions: versions.length, stats: stats.get(role.key) ?? { calls: 0, tokens: 0, approved: 0, edited: 0, rejected: 0 } };
  });
  return c.json({ items });
});

stage4Routes.post("/agents/:key/prompts", async (c) => {
  const admin = await c.get("db").rpc("is_admin");
  dbFail(admin.error);
  if (admin.data !== true) throw new AppError("FORBIDDEN", "只有管理员可以修改提示词");
  const key = c.req.param("key");
  const input = await parseJson(c.req, z.object({ prompt: z.string().trim().min(4).max(8000) }));
  const found = await serviceQuery()("SELECT key FROM public.agent_roles WHERE key = $1", [key]);
  if (!found[0]) throw new AppError("NOT_FOUND", "没有这个智能体");
  const latest = await serviceQuery()("SELECT COALESCE(max(version), 0) AS version FROM public.agent_prompt_versions WHERE role_key = $1", [key]);
  const version = Number(latest[0]?.["version"] ?? 0) + 1;
  await serviceQuery()(
    "INSERT INTO public.agent_prompt_versions(role_key, version, prompt, created_by) VALUES ($1,$2,$3,$4)",
    [key, version, input.prompt, c.get("userId")],
  );
  return c.json({ version }, 201);
});

const BUNDLE_TABLES = ["requirements", "acceptance_criteria", "tasks", "test_cases", "feedback_items", "change_requests", "decisions", "releases", "artifacts", "comments", "gate_results", "merge_requests"] as const;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|ciphertext|api_key|authorization/i.test(key)) continue;
      out[key] = redact(item);
    }
    return out;
  }
  if (typeof value === "string") return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱]").replace(/\b1\d{10}\b/g, "[手机号]");
  return value;
}

stage4Routes.get("/apps/:id/export-bundle", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead"], "只有负责人可以导出应用数据包");
  const files: Record<string, Uint8Array> = {};
  const app = await serviceQuery()("SELECT id, name, description, phase, classification, current_version FROM public.apps WHERE id = $1", [appId]);
  files["app.json"] = strToU8(JSON.stringify(redact(app[0] ?? {}), null, 2));
  for (const table of BUNDLE_TABLES) {
    const rows = await serviceQuery()(`SELECT * FROM public.${table} WHERE app_id = $1`, [appId]);
    files[`${table}.json`] = strToU8(JSON.stringify(redact(rows), null, 2));
  }
  files["README.txt"] = strToU8("这个压缩包已去掉令牌、密钥、邮箱和手机号。\n");
  const zip = zipSync(files);
  return c.body(zip, 200, {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="sdf-app-${appId.slice(0, 8)}.zip"`,
  });
});
