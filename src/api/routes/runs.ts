import { Hono, type Context } from "hono";
import { z } from "zod";
import { AppError } from "@/core/errors";
import { planPreview, validateWorkflow } from "@/core/engine/validate";
import { disabledBlockIds } from "./examples";
import type { WorkflowDef } from "@/core/engine/builtin";
import { BLOCKS } from "@/core/blocks";
import { serviceQuery } from "@/adapters/pg-client";
import { dbFail } from "../middleware";
import { parseJson, parseUuid } from "../validate";
import { appAccess, originOf, requireRole } from "../perm";
import type { AppEnv } from "../context";

export const runRoutes = new Hono<AppEnv>();
const WEIGHTS = ["light", "standard", "full"] as const;

runRoutes.get("/workflows", async (c) => {
  const { data, error } = await c.get("db").from("workflows").select("*").order("startable", { ascending: false }).order("key");
  dbFail(error);
  const disabled = await disabledBlockIds(c.get("db"));
  return c.json({ items: (data ?? []).map((w) => {
    const def = w.definition as unknown as WorkflowDef;
    return { ...w, issues: validateWorkflow(w.yaml, def), plans: Object.fromEntries(WEIGHTS.map((x) => [x, planPreview(def, x, disabled)])) };
  }) });
});

runRoutes.post("/apps/:id/runs", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  const input = await parseJson(c.req, z.object({
    workflow_id: z.string().uuid(), weight: z.enum(WEIGHTS), source_ids: z.array(z.string().uuid()).max(50).default([]),
    change_request_id: z.string().uuid().optional(), version: z.string().max(30).optional(), iteration_id: z.string().uuid().optional(),
    feature_id: z.string().uuid().optional(),
  }));
  const access = await appAccess(c, appId);
  requireRole(access, ["lead", "ba"], "只有负责人、需求分析师或管理员可以启动运行");
  const wf = await c.get("db").from("workflows").select("*").eq("id", input.workflow_id).maybeSingle();
  dbFail(wf.error);
  if (!wf.data) throw new AppError("NOT_FOUND", "工作流不存在");
  const issues = validateWorkflow(wf.data.yaml, wf.data.definition as unknown as WorkflowDef).filter((x) => !x.includes("只能由负责人"));
  if (!wf.data.startable || issues.length) throw new AppError("VALIDATION", `该工作流不能启动：${issues.join("；") || "未开放"}`);
  if (input.source_ids.length) {
    const src = await c.get("db").from("sources").select("id").eq("app_id", appId).eq("parse_status", "parsed").in("id", input.source_ids);
    dbFail(src.error);
    if ((src.data ?? []).length !== input.source_ids.length) throw new AppError("VALIDATION", "所选资料不存在、未解析完成或不属于本应用");
  }
  const inputs: Record<string, unknown> = { source_ids: input.source_ids };
  if (input.change_request_id) {
    const change = await c.get("db").from("change_requests").select("requirement_codes,iteration_id").eq("id", input.change_request_id).eq("app_id", appId).maybeSingle();
    dbFail(change.error);
    if (!change.data) throw new AppError("VALIDATION", "变更请求不属于这个应用");
    inputs["change_request_id"] = input.change_request_id;
    inputs["requirement_codes"] = change.data.requirement_codes ?? [];
    if (change.data.iteration_id) inputs["iteration_id"] = change.data.iteration_id;
  }
  if (input.iteration_id) inputs["iteration_id"] = input.iteration_id;
  if (input.feature_id) {
    const links = await c.get("db").from("feature_requirements").select("requirement_id").eq("app_id", appId).eq("feature_id", input.feature_id);
    dbFail(links.error);
    const ids = (links.data ?? []).map((row) => String(row.requirement_id));
    const reqs = ids.length ? await c.get("db").from("requirements").select("code").in("id", ids) : { data: [], error: null };
    dbFail(reqs.error);
    inputs["feature_id"] = input.feature_id;
    inputs["requirement_codes"] = (reqs.data ?? []).map((row) => String(row.code)).slice(0, 40);
  }
  if (input.version) inputs["version"] = input.version;
  const id = await c.get("deps").commands.startRun({ app: appId, workflow: input.workflow_id, weight: input.weight, inputs, actor: c.get("userId"), trace: c.get("traceId") });
  if (input.change_request_id && wf.data.key === "feature_enhance") await serviceQuery()("UPDATE public.change_requests SET run_id = $1 WHERE id = $2 AND app_id = $3", [id, input.change_request_id, appId]);
  c.get("deps").kick(originOf(c), id);
  return c.json({ id }, 201);
});

runRoutes.get("/apps/:id/runs", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  const { data, error } = await c.get("db").from("workflow_runs").select("id,code,status,weight,current_step_key,started_at,finished_at,started_by,workflows(key,name,version),step_runs(step_key,block_key,seq,status,is_current,attempt)")
    .eq("app_id", appId).order("started_at", { ascending: false }).limit(100);
  dbFail(error);
  return c.json({ items: (data ?? []).map((r) => ({ ...r, step_runs: ((r.step_runs ?? []) as { is_current: boolean; seq: number }[]).filter((s) => s.is_current).sort((a, b) => a.seq - b.seq) })) });
});

async function loadRun(c: Context<AppEnv>, runId: string) {
  const { data, error } = await c.get("db").from("workflow_runs").select("*, workflows(key,name,version)").eq("id", runId).maybeSingle();
  dbFail(error);
  if (!data) throw new AppError("NOT_FOUND", "运行不存在或您没有访问权限");
  return data;
}

runRoutes.get("/runs/:id", async (c) => {
  const runId = parseUuid(c.req.param("id"));
  const db = c.get("db");
  const run = await loadRun(c, runId);
  const [steps, events, access] = await Promise.all([
    db.from("step_runs").select("*").eq("run_id", runId).order("seq").order("attempt"),
    db.from("step_events").select("id,step_run_id,ts,kind,message,data").in("step_run_id", (await db.from("step_runs").select("id").eq("run_id", runId)).data?.map((x) => x.id) ?? []).order("id").limit(1000),
    appAccess(c, run.app_id),
  ]);
  dbFail(steps.error); dbFail(events.error);
  const artIds = (steps.data ?? []).flatMap((s) => (s.output_artifacts as string[]) ?? []);
  const arts = artIds.length ? await db.from("artifacts").select("id,type,key,version,title,content,status,is_latest,possibly_stale,step_run_id,agent_role,model,reviewed_at,edit_ratio,confidence,created_at").in("id", artIds) : { data: [], error: null };
  dbFail(arts.error);
  const callQuery = db.from("llm_calls").select("id,model,status,duration_ms,total_tokens,attempt,created_at,step_run_id").eq("trace_id", run.trace_id).order("created_at").limit(200);
  const calls = access.isAdmin
    ? await db.from("llm_calls").select("id,model,status,duration_ms,total_tokens,attempt,error_code,created_at,step_run_id").eq("trace_id", run.trace_id).order("created_at").limit(200)
    : await callQuery;
  dbFail(calls.error);
  const blocks = Object.fromEntries(Object.values(BLOCKS).map((b) => [b.key, { name: b.name, agent_role: b.agentRole, task_tier: b.taskTier }]));
  return c.json({ run, steps: steps.data ?? [], events: events.data ?? [], artifacts: arts.data ?? [], llm_calls: calls.data, blocks,
    access: { ...access, user_id: c.get("userId") } });
});

const isLeadOrStarter = (access: { isAdmin: boolean; roles: string[] }, starter: string, uid: string) => access.isAdmin || access.roles.includes("lead") || starter === uid;

runRoutes.post("/runs/:id/cancel", async (c) => {
  const run = await loadRun(c, parseUuid(c.req.param("id")));
  if (!isLeadOrStarter(await appAccess(c, run.app_id), run.started_by, c.get("userId"))) throw new AppError("FORBIDDEN", "只有负责人或发起人可以取消运行");
  await c.get("deps").commands.cancel(run.id, c.get("userId"), c.get("traceId"));
  return c.json({ ok: true });
});

runRoutes.post("/runs/:id/rerun", async (c) => {
  const run = await loadRun(c, parseUuid(c.req.param("id")));
  const input = await parseJson(c.req, z.object({ step_key: z.string().min(1).max(60) }));
  if (!isLeadOrStarter(await appAccess(c, run.app_id), run.started_by, c.get("userId"))) throw new AppError("FORBIDDEN", "只有负责人或发起人可以重跑");
  await c.get("deps").commands.rerun(run.id, input.step_key, c.get("userId"), c.get("traceId"));
  c.get("deps").kick(originOf(c), run.id);
  return c.json({ ok: true });
});

async function loadStep(c: Context<AppEnv>) {
  const id = parseUuid(c.req.param("id") ?? "");
  const { data, error } = await c.get("db").from("step_runs").select("id,run_id,app_id,status,checkpoint,block_key,is_current,workflow_runs(started_by)").eq("id", id).maybeSingle();
  dbFail(error);
  if (!data) throw new AppError("NOT_FOUND", "步骤不存在或您没有访问权限");
  return { step: data, access: await appAccess(c, data.app_id) };
}

runRoutes.post("/steps/:id/decide", async (c) => {
  const input = await parseJson(c.req, z.object({ decision: z.enum(["approve", "reject"]), comment: z.string().max(2000).nullable().default(null), goto: z.string().max(60).nullable().default(null) }));
  const { step, access } = await loadStep(c);
  const role = (step.checkpoint as { role?: string } | null)?.role ?? "lead";
  requireRole(access, [role, "lead"], `只有「${role}」角色、负责人或管理员可以确认此步骤`);
  const status = await c.get("deps").commands.decide(step.id, c.get("userId"), input.decision, input.comment, input.goto, c.get("traceId"));
  c.get("deps").kick(originOf(c), step.run_id);
  return c.json({ ok: true, run_status: status });
});

runRoutes.post("/steps/:id/retry", async (c) => {
  const { step, access } = await loadStep(c);
  const starter = (step.workflow_runs as unknown as { started_by: string } | null)?.started_by ?? "";
  if (!isLeadOrStarter(access, starter, c.get("userId")) && !access.roles.includes("ba")) throw new AppError("FORBIDDEN", "没有重试此步骤的权限");
  await c.get("deps").commands.retry(step.id, c.get("userId"), c.get("traceId"));
  c.get("deps").kick(originOf(c), step.run_id);
  return c.json({ ok: true });
});

runRoutes.post("/steps/:id/skip", async (c) => {
  const input = await parseJson(c.req, z.object({ reason: z.string().trim().min(2).max(500) }));
  const { step, access } = await loadStep(c);
  requireRole(access, ["lead"], "只有负责人可以跳过步骤");
  await c.get("deps").commands.skip(step.id, c.get("userId"), input.reason, c.get("traceId"));
  c.get("deps").kick(originOf(c), step.run_id);
  return c.json({ ok: true });
});

runRoutes.get("/inbox", async (c) => {
  const db = c.get("db");
  const [steps, admin, mine, changes, feedback, uat, notices, apps, comments] = await Promise.all([
    db.from("step_runs").select("id,run_id,app_id,step_key,block_key,checkpoint,created_at,started_at,finished_at,workflow_runs(code,status,workflows(name)),apps(name)").eq("status", "waiting_human").eq("is_current", true).order("created_at").limit(200),
    db.rpc("is_admin"),
    db.from("app_members").select("app_id,role").eq("user_id", c.get("userId")),
    db.from("change_requests").select("id,app_id,code,title,status").eq("status", "pending_confirm").order("created_at", { ascending: false }).limit(30),
    db.from("feedback_items").select("id,app_id,code,title,status").in("status", ["open", "triaged"]).order("created_at", { ascending: false }).limit(30),
    db.from("uat_items").select("id,app_id,ac_code,title,result").eq("result", "pending").order("ac_code").limit(30),
    db.from("notifications").select("id,app_id,user_id,title,body,read_at,created_at").order("created_at", { ascending: false }).limit(40),
    db.from("apps").select("id,name").limit(100),
    db.from("comments").select("id,app_id,body,target_kind,mentioned_user_ids,created_at").order("created_at", { ascending: false }).limit(80),
  ]);
  dbFail(steps.error); dbFail(admin.error); dbFail(mine.error); dbFail(changes.error); dbFail(feedback.error); dbFail(uat.error); dbFail(notices.error); dbFail(apps.error); dbFail(comments.error);
  const roles = new Map<string, string[]>();
  for (const m of mine.data ?? []) roles.set(m.app_id, [...(roles.get(m.app_id) ?? []), m.role]);
  const names = new Map((apps.data ?? []).map((app) => [app.id, app.name]));
  const staff = (appId: string) => admin.data === true || (roles.get(appId) ?? []).some((role) => role === "lead" || role === "ba" || role === "qa");
  const items = (steps.data ?? []).filter((s) => {
    const need = (s.checkpoint as { role?: string } | null)?.role ?? "lead";
    const r = roles.get(s.app_id) ?? [];
    return admin.data === true || r.includes(need) || r.includes("lead");
  });
  return c.json({
    items,
    changes: (changes.data ?? []).map((row) => ({ ...row, app_name: names.get(row.app_id) ?? "" })),
    feedback: (feedback.data ?? []).filter((row) => staff(row.app_id)).map((row) => ({ ...row, app_name: names.get(row.app_id) ?? "" })),
    uat: (uat.data ?? []).map((row) => ({ ...row, app_name: names.get(row.app_id) ?? "" })),
    notices: (notices.data ?? []).filter((row) => !row.read_at && row.user_id === c.get("userId")),
    mentions: (comments.data ?? []).filter((row) => Array.isArray(row.mentioned_user_ids) && row.mentioned_user_ids.includes(c.get("userId"))).map((row) => ({
      id: row.id, app_id: row.app_id, body: row.body, app_name: names.get(row.app_id) ?? "",
    })),
  });
});
