import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "@/core/errors";
import { compareBaselines, markChangeApproved, meetingAgenda, triageFeedback } from "@/adapters/stage3-store";
import { serviceQuery } from "@/adapters/pg-client";
import { dbFail } from "../middleware";
import { appAccess, rejectBusiness, requireRole } from "../perm";
import { parseJson, parseUuid } from "../validate";
import type { AppEnv } from "../context";

export const evolutionRoutes = new Hono<AppEnv>();

evolutionRoutes.get("/apps/:id/feedback", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  await appAccess(c, appId);
  const rows = await c.get("db").from("feedback_items").select("id,code,title,body,status,category,duplicate_code,requirement_code,suggested_priority,triage_reason,released_in,created_at").eq("app_id", appId).order("created_at", { ascending: false }).limit(100);
  dbFail(rows.error);
  return c.json({ items: rows.data ?? [] });
});

evolutionRoutes.post("/apps/:id/feedback", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  await appAccess(c, appId);
  const input = await parseJson(c.req, z.object({ title: z.string().trim().min(2).max(120), body: z.string().trim().min(2).max(8000) }));
  const code = await serviceQuery()("SELECT public.next_code($1, 'FB') AS code", [appId]);
  const saved = await c.get("db").from("feedback_items").insert({
    app_id: appId, code: code[0]?.["code"], title: input.title, body: input.body, created_by: c.get("userId"),
  }).select("id,code").single();
  dbFail(saved.error, "提交反馈失败");
  await triageFeedback(appId, saved.data!.id);
  return c.json(saved.data, 201);
});

evolutionRoutes.post("/apps/:id/changes", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, appId), ["lead", "ba"], "只有负责人或需求分析师可以合并变更");
  const input = await parseJson(c.req, z.object({ title: z.string().trim().min(2).max(120), feedback_ids: z.array(z.string().uuid()).min(1).max(20) }));
  const feedback = await serviceQuery()("SELECT id, requirement_code FROM public.feedback_items WHERE app_id = $1 AND id = ANY($2::uuid[])", [appId, input.feedback_ids]);
  if (feedback.length !== input.feedback_ids.length) throw new AppError("VALIDATION", "有反馈不属于这个应用");
  const codes = Array.from(new Set(feedback.map((row) => row["requirement_code"]).filter((code): code is string => typeof code === "string" && code.length > 0)));
  const code = await serviceQuery()("SELECT public.next_code($1, 'CR') AS code", [appId]);
  const iteration = await serviceQuery()(
    `INSERT INTO public.iterations(app_id, code, name) VALUES ($1, public.next_code($1, 'IT'), $2) RETURNING id`,
    [appId, input.title],
  );
  const saved = await serviceQuery()(
    `INSERT INTO public.change_requests(app_id, code, title, requirement_codes, iteration_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, code`,
    [appId, code[0]?.["code"], input.title, codes, iteration[0]?.["id"], c.get("userId")],
  );
  for (const row of feedback) {
    await serviceQuery()("INSERT INTO public.cr_feedback(change_request_id, feedback_id) VALUES ($1,$2)", [saved[0]?.["id"], row["id"]]);
    await serviceQuery()("UPDATE public.feedback_items SET status = 'accepted' WHERE id = $1", [row["id"]]);
  }
  return c.json({ id: saved[0]?.["id"], code: saved[0]?.["code"], iteration_id: iteration[0]?.["id"] }, 201);
});

evolutionRoutes.get("/apps/:id/changes", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  await appAccess(c, appId);
  const rows = await c.get("db").from("change_requests").select("id,code,title,status,business_summary,requirement_codes,iteration_id,created_at").eq("app_id", appId).order("created_at", { ascending: false }).limit(50);
  dbFail(rows.error);
  return c.json({ items: rows.data ?? [] });
});

evolutionRoutes.post("/apps/:id/changes/:crId/confirm", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  const crId = parseUuid(c.req.param("crId"));
  const access = await appAccess(c, appId);
  requireRole(access, ["business", "lead"], "只有业务方或负责人可以确认");
  const input = await parseJson(c.req, z.object({ decision: z.enum(["approve", "reject"]), comment: z.string().max(2000).default("") }));
  const change = await c.get("db").from("change_requests").select("id,business_summary,run_id").eq("id", crId).eq("app_id", appId).maybeSingle();
  dbFail(change.error);
  if (!change.data) throw new AppError("NOT_FOUND", "变更请求不存在");
  if (input.decision === "approve") await markChangeApproved(appId, crId, c.get("userId"), change.data.business_summary || input.comment || "同意");
  else {
    if (input.comment.trim().length < 2) throw new AppError("VALIDATION", "请写下要修改的地方");
    await serviceQuery()("UPDATE public.change_requests SET status = 'draft' WHERE id = $1", [crId]);
  }
  if (change.data.run_id) {
    const steps = await serviceQuery()("SELECT id FROM public.step_runs WHERE run_id = $1 AND is_current AND status = 'waiting_human' AND block_key = 'B32'", [change.data.run_id]);
    if (steps[0]) {
      await c.get("deps").commands.decide(String(steps[0]["id"]), c.get("userId"), input.decision, input.comment || null, input.decision === "reject" ? "plan" : null, c.get("traceId"));
      c.get("deps").kick(new URL(c.req.url).origin, String(change.data.run_id));
    }
  }
  return c.json({ ok: true });
});

evolutionRoutes.get("/apps/:id/uat", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  const access = await appAccess(c, appId);
  const rows = await c.get("db").from("uat_items").select("id,ac_code,title,steps,expected,result,fail_reason").eq("app_id", appId).order("ac_code").limit(100);
  dbFail(rows.error);
  const items = access.isAdmin || access.roles.some((role) => role !== "business") ? rows.data ?? [] : rows.data ?? [];
  return c.json({ items });
});

evolutionRoutes.post("/uat/:itemId", async (c) => {
  const itemId = parseUuid(c.req.param("itemId"));
  const input = await parseJson(c.req, z.object({ result: z.enum(["passed", "failed"]), fail_reason: z.string().max(1000).default("") }));
  if (input.result === "failed" && input.fail_reason.trim().length < 2) throw new AppError("VALIDATION", "请写下不通过的原因");
  const saved = await c.get("db").from("uat_items").update({ result: input.result, fail_reason: input.fail_reason || null }).eq("id", itemId).select("id,feedback_id").maybeSingle();
  dbFail(saved.error);
  if (!saved.data) throw new AppError("NOT_FOUND", "验收项不存在或不能由您填写");
  return c.json({ ok: true, feedback_id: saved.data.feedback_id });
});

evolutionRoutes.get("/apps/:id/decisions", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  await appAccess(c, appId);
  const rows = await c.get("db").from("decisions").select("id,code,title,body,created_at").eq("app_id", appId).order("created_at", { ascending: false }).limit(50);
  dbFail(rows.error);
  return c.json({ items: rows.data ?? [] });
});

evolutionRoutes.get("/apps/:id/releases", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  await appAccess(c, appId);
  const rows = await c.get("db").from("releases").select("id,version,notes_business,published_at").eq("app_id", appId).order("published_at", { ascending: false }).limit(20);
  dbFail(rows.error);
  return c.json({ items: rows.data ?? [] });
});

evolutionRoutes.get("/apps/:id/agenda", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  rejectBusiness(await appAccess(c, appId));
  return c.json({ markdown: await meetingAgenda(appId) });
});

evolutionRoutes.get("/apps/:id/baselines/compare", async (c) => {
  const appId = parseUuid(c.req.param("id"));
  await appAccess(c, appId);
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  if (!from || !to) throw new AppError("VALIDATION", "请选择两个版本");
  return c.json(await compareBaselines(appId, from, to));
});

evolutionRoutes.get("/admin/hooks", async (c) => {
  const admin = await c.get("db").rpc("is_admin");
  if (admin.data !== true) throw new AppError("FORBIDDEN", "只有管理员可以查看自动规则");
  const rows = await serviceQuery()("SELECT event_key, enabled, description FROM public.hooks ORDER BY event_key", []);
  return c.json({ items: rows });
});

evolutionRoutes.patch("/admin/hooks/:key", async (c) => {
  const admin = await c.get("db").rpc("is_admin");
  if (admin.data !== true) throw new AppError("FORBIDDEN", "只有管理员可以修改自动规则");
  const input = await parseJson(c.req, z.object({ enabled: z.boolean() }));
  await serviceQuery()("UPDATE public.hooks SET enabled = $2 WHERE event_key = $1", [c.req.param("key"), input.enabled]);
  return c.json({ ok: true });
});

evolutionRoutes.post("/notifications/:id/read", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const saved = await c.get("db").from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id).eq("user_id", c.get("userId")).select("id").maybeSingle();
  dbFail(saved.error);
  if (!saved.data) throw new AppError("NOT_FOUND", "通知不存在");
  return c.json({ ok: true });
});
