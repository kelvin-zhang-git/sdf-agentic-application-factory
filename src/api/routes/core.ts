import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "@/core/errors";
import { timingSafeEqualStr } from "@/core/crypto-util";
import { FEATURES, API_VERSION } from "@/core/meta";
import { issueApiToken, listApiTokens, revokeApiToken } from "@/adapters/api-tokens";
import { requireAdmin, dbFail } from "../middleware";
import { parseJson, parseUuid } from "../validate";
import type { AppEnv } from "../context";

export const coreRoutes = new Hono<AppEnv>();

coreRoutes.get("/me", async (c) => {
  const db = c.get("db");
  const uid = c.get("userId");
  const [p, r, b] = await Promise.all([
    db.from("profiles").select("id,email,display_name").eq("id", uid).maybeSingle(),
    db.from("user_roles").select("role").eq("user_id", uid),
    db.rpc("is_bootstrapped"),
  ]);
  dbFail(p.error); dbFail(r.error); dbFail(b.error);
  const m = await db.from("app_members").select("role").eq("user_id", uid);
  dbFail(m.error);
  const appRoles = Array.from(new Set((m.data ?? []).map((x) => x.role)));
  return c.json({
    user_id: uid,
    profile: p.data,
    global_roles: (r.data ?? []).map((x) => x.role),
    app_roles: appRoles,
    business_only: appRoles.length > 0 && appRoles.every((x) => x === "business") && (r.data ?? []).length === 0,
    bootstrapped: b.data === true,
  });
});

coreRoutes.patch("/me", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { display_name?: unknown };
  const name = typeof body.display_name === "string" ? body.display_name.trim() : "";
  if (!name || name.length > 50) throw new AppError("VALIDATION", "显示名称需为 1–50 个字");
  const { error } = await c.get("db").from("profiles").update({ display_name: name }).eq("id", c.get("userId"));
  dbFail(error);
  return c.json({ ok: true });
});

coreRoutes.get("/tokens", async (c) => {
  return c.json({ items: await listApiTokens(c.get("userId")) });
});

coreRoutes.post("/tokens", async (c) => {
  const body = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new AppError("VALIDATION", "请填写令牌名称");
  const issued = await issueApiToken(c.get("userId"), body.data.name);
  await c.get("deps").sys.writeAudit({
    trace_id: c.get("traceId"), actor_id: c.get("userId"), action: "token.issued",
    target_type: "api_token", target_id: issued.id, detail: { name: body.data.name, prefix: issued.prefix },
  });
  return c.json({ id: issued.id, prefix: issued.prefix, token: issued.token }, 201);
});

coreRoutes.post("/tokens/:id/revoke", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const ok = await revokeApiToken(c.get("userId"), id);
  if (!ok) throw new AppError("NOT_FOUND", "令牌不存在或已经吊销");
  await c.get("deps").sys.writeAudit({
    trace_id: c.get("traceId"), actor_id: c.get("userId"), action: "token.revoked",
    target_type: "api_token", target_id: id,
  });
  return c.json({ ok: true });
});

coreRoutes.post("/bootstrap", async (c) => {
  const { sys, env } = c.get("deps");
  if (await sys.isBootstrapped()) throw new AppError("BOOTSTRAP_CLOSED", "系统已完成初始化，此入口已关闭");
  const expected = env.get("SDF_BOOTSTRAP_TOKEN");
  if (!expected) throw new AppError("BOOTSTRAP_NOT_CONFIGURED", "尚未配置初始化口令，请联系部署人员");
  const given = c.req.header("x-sdf-bootstrap-token") ?? "";
  if (!timingSafeEqualStr(given, expected)) throw new AppError("BOOTSTRAP_TOKEN_INVALID", "初始化口令不正确");
  const uid = c.get("userId"); // only from verified token
  const ok = await sys.bootstrapAdmin(uid);
  if (!ok) throw new AppError("BOOTSTRAP_CLOSED", "系统已完成初始化，此入口已关闭");
  await sys.writeAudit({ trace_id: c.get("traceId"), actor_id: uid, action: "system.bootstrap_admin", target_type: "user", target_id: uid });
  return c.json({ ok: true });
});

coreRoutes.get("/meta", requireAdmin, async (c) => {
  return c.json({
    version: API_VERSION,
    batch: "2",
    runtime: "tanstack-start/cloudflare-workers",
    trace_id: c.get("traceId"),
    features: FEATURES,
    scheduler_active: process.env["VITEST"] !== "true" && process.env["SDF_DISABLE_SCHEDULER"] !== "1",
    secrets_configured: {
      SDF_BOOTSTRAP_TOKEN: Boolean(c.get("deps").env.get("SDF_BOOTSTRAP_TOKEN")),
      SDF_SECRET_KEY: Boolean(c.get("deps").env.get("SDF_SECRET_KEY")),
    },
  });
});

coreRoutes.get("/audit", async (c) => {
  const appId = c.req.query("app_id");
  const action = (c.req.query("action") ?? "").trim().slice(0, 80);
  const target = (c.req.query("target_type") ?? "").trim().slice(0, 40);
  const fromRaw = c.req.query("from") ?? "";
  const toRaw = c.req.query("to") ?? "";
  const from = fromRaw && !Number.isNaN(Date.parse(fromRaw)) ? new Date(fromRaw).toISOString() : "";
  const to = toRaw && !Number.isNaN(Date.parse(toRaw)) ? new Date(toRaw).toISOString() : "";
  let q = c.get("db").from("audit_logs").select("*").order("created_at", { ascending: false }).limit(200);
  if (appId) q = q.eq("app_id", appId);
  if (action) q = q.ilike("action", `%${action.replace(/[%_\\]/g, "")}%`);
  if (target) q = q.eq("target_type", target);
  if (from) q = q.gte("created_at", from);
  if (to) q = q.lte("created_at", to);
  const { data, error } = await q;
  dbFail(error);
  const items = data ?? [];
  if (c.req.query("format") === "csv") {
    const rows = ["时间,操作,对象类型,对象编号,请求编号"];
    for (const item of items) {
      const created = String(item.created_at ?? "");
      const action = String(item.action ?? "").replaceAll(",", " ");
      rows.push([created, action, String(item.target_type ?? ""), String(item.target_id ?? ""), String(item.trace_id ?? "")].join(","));
    }
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", "attachment; filename=\"audit.csv\"");
    return c.body(`\uFEFF${rows.join("\n")}\n`);
  }
  return c.json({ items });
});

// Admin: users, global roles, and cross-app virtual team memberships (RLS: admin only)
coreRoutes.get("/admin/users", requireAdmin, async (c) => {
  const db = c.get("db");
  const [p, r, m, a] = await Promise.all([
    db.from("profiles").select("id,email,display_name,created_at,expires_at").order("created_at"),
    db.from("user_roles").select("user_id,role"),
    db.from("app_members").select("user_id,app_id,role,expires_at"),
    db.from("apps").select("id,name"),
  ]);
  dbFail(p.error); dbFail(r.error); dbFail(m.error); dbFail(a.error);
  const appNames = new Map((a.data ?? []).map((row) => [String(row.id), String(row.name)]));
  const byUser = new Map<string, Map<string, { app_id: string; app_name: string; roles: string[]; expires_at: string | null }>>();
  for (const row of m.data ?? []) {
    const uid = String(row.user_id);
    const aid = String(row.app_id);
    let userApps = byUser.get(uid);
    if (!userApps) { userApps = new Map(); byUser.set(uid, userApps); }
    const existing = userApps.get(aid) ?? { app_id: aid, app_name: appNames.get(aid) ?? aid, roles: [], expires_at: row.expires_at ? String(row.expires_at) : null };
    if (!existing.roles.includes(String(row.role))) existing.roles.push(String(row.role));
    if (!existing.expires_at && row.expires_at) existing.expires_at = String(row.expires_at);
    userApps.set(aid, existing);
  }
  return c.json({
    items: (p.data ?? []).map((u) => ({
      ...u,
      roles: (r.data ?? []).filter((x) => x.user_id === u.id).map((x) => x.role),
      memberships: Array.from(byUser.get(String(u.id))?.values() ?? []),
    })),
  });
});

const GLOBAL_ROLES = ["admin", "lead", "ba", "architect", "security", "dev", "qa", "business"] as const;
coreRoutes.put("/admin/users/:id/roles", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as { roles?: unknown } | null;
  const roles = body && Array.isArray(body.roles) ? body.roles : null;
  if (!roles || !roles.every((r) => (GLOBAL_ROLES as readonly string[]).includes(String(r))))
    throw new AppError("VALIDATION", "角色不正确");
  const db = c.get("db");
  const cur = await db.from("user_roles").select("role").eq("user_id", id);
  dbFail(cur.error);
  const have = new Set((cur.data ?? []).map((x) => x.role as string));
  const want = new Set(roles as string[]);
  if (id === c.get("userId") && have.has("admin") && !want.has("admin"))
    throw new AppError("VALIDATION", "不能移除自己的管理员角色");
  const add = [...want].filter((r) => !have.has(r));
  const del = [...have].filter((r) => !want.has(r));
  if (add.length) dbFail((await db.from("user_roles").insert(add.map((role) => ({ user_id: id, role: role as never })))).error);
  if (del.length) dbFail((await db.from("user_roles").delete().eq("user_id", id).in("role", del as never[])).error);
  await c.get("deps").sys.writeAudit({ trace_id: c.get("traceId"), actor_id: c.get("userId"), action: "user.roles_changed", target_type: "user", target_id: id, detail: { add, del } });
  return c.json({ ok: true });
});

coreRoutes.put("/admin/users/:id/expiry", requireAdmin, async (c) => {
  const id = parseUuid(c.req.param("id"));
  const body = await parseJson(c.req, z.object({ expires_at: z.string().nullable() }));
  if (body.expires_at && Number.isNaN(Date.parse(body.expires_at))) throw new AppError("VALIDATION", "有效期不是有效时间");
  const saved = await c.get("db").rpc("sdf_set_account_expiry", { _user: id, _at: body.expires_at });
  if (saved.error?.message.includes("SDF_NOT_FOUND")) throw new AppError("NOT_FOUND", "用户不存在");
  dbFail(saved.error, "设置有效期失败");
  await c.get("deps").sys.writeAudit({ trace_id: c.get("traceId"), actor_id: c.get("userId"), action: "user.expiry_changed", target_type: "user", target_id: id, detail: { expires_at: body.expires_at } });
  return c.json({ ok: true });
});
