import { Hono, type Context } from "hono";
import { z } from "zod";
import { AppError } from "@/core/errors";
import { serviceQuery } from "@/adapters/pg-client";
import { dbFail } from "../middleware";
import { appAccess, requireRole } from "../perm";
import { parseJson, parseUuid } from "../validate";
import type { AppEnv } from "../context";

function clean<T extends Record<string, unknown>>(o: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as never;
}

export const appRoutes = new Hono<AppEnv>();

const APP_ROLES = ["lead", "ba", "architect", "security", "dev", "qa", "business"] as const;
const appInput = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(""),
  phase: z.enum(["development", "maintenance"]).default("development"),
  classification: z.enum(["public", "internal", "sensitive", "confidential"]).default("internal"),
  redact_before_llm: z.boolean().default(false),
  redact_terms: z.array(z.string().trim().min(2).max(80)).max(50).optional(),
  current_version: z.string().max(30).nullable().optional(),
});

function audit(c: Context<AppEnv>, action: string, appId: string | null, target_type: string, target_id: string, detail?: Record<string, unknown>) {
  return c.get("deps").sys.writeAudit({ trace_id: c.get("traceId"), actor_id: c.get("userId"), app_id: appId, action, target_type, target_id, detail });
}

appRoutes.get("/", async (c) => {
  const { data, error } = await c.get("db").from("apps").select("*, app_members(count)").order("created_at", { ascending: false });
  dbFail(error);
  return c.json({ items: data ?? [] });
});

appRoutes.post("/", async (c) => {
  const body = await parseJson(c.req, appInput.extend({ domain_pack: z.enum(["automotive"]).optional() }));
  const { domain_pack: domainPack, ...rest } = body;
  const input = clean(rest);
  const { data, error } = await c.get("db").from("apps").insert({ ...input, created_by: c.get("userId") }).select().single();
  dbFail(error, "新建应用失败");
  if (domainPack === "automotive") {
    const { AUTOMOTIVE_DICTIONARY, AUTOMOTIVE_FEATURES } = await import("@/core/oem-pack");
    for (const feature of AUTOMOTIVE_FEATURES) {
      const saved = await c.get("db").rpc("sdf_create_feature", { _app: data!.id, _name: feature.name, _iteration: null });
      dbFail(saved.error, "套用领域包失败");
    }
    const artifact = await c.get("db").rpc("sdf_write_artifact", {
      _app: data!.id,
      _a: { type: "domain_pack", key: "automotive", title: "汽车领域包第一版", content: AUTOMOTIVE_DICTIONARY, agent_role: "architect", citations: [] },
      _step: null,
      _actor: c.get("userId"),
      _source: "import",
    });
    dbFail(artifact.error, "写入领域包失败");
  }
  await audit(c, "app.created", data!.id, "app", data!.id, { name: input.name, domain_pack: domainPack ?? null });
  return c.json(data, 201);
});

appRoutes.get("/:id", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const db = c.get("db");
  const { data, error } = await db.from("apps").select("*").eq("id", id).maybeSingle();
  dbFail(error);
  if (!data) throw new AppError("NOT_FOUND", "应用不存在或您没有访问权限");
  const mine = await db.from("app_members").select("role").eq("app_id", id).eq("user_id", c.get("userId"));
  dbFail(mine.error);
  return c.json({ ...data, my_roles: (mine.data ?? []).map((x) => x.role) });
});

appRoutes.patch("/:id", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const input = clean(await parseJson(c.req, appInput.partial()));
  const { data, error } = await c.get("db").from("apps").update(input).eq("id", id).select().maybeSingle();
  dbFail(error, "保存应用失败");
  if (!data) throw new AppError("FORBIDDEN", "没有权限修改此应用");
  await audit(c, "app.updated", id, "app", id, { fields: Object.keys(input) });
  return c.json(data);
});

// Members
appRoutes.get("/:id/members", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const { data, error } = await c.get("db").from("app_members")
    .select("id, role, user_id, created_at, expires_at, profiles(id,email,display_name)").eq("app_id", id).order("created_at");
  dbFail(error);
  return c.json({ items: data ?? [] });
});

appRoutes.post("/:id/members", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const input = await parseJson(c.req, z.object({ email: z.string().trim().email().max(200), role: z.enum(APP_ROLES) }));
  const db = c.get("db");
  const f = await db.rpc("find_profile_id_by_email", { _email: input.email });
  dbFail(f.error);
  if (!f.data) throw new AppError("NOT_FOUND", "找不到该邮箱对应的已注册用户（对方需要先注册）");
  const { data, error } = await db.from("app_members").insert({ app_id: id, user_id: f.data, role: input.role }).select().maybeSingle();
  dbFail(error, "添加成员失败");
  if (!data) throw new AppError("FORBIDDEN", "没有权限管理成员");
  await audit(c, "app.member_added", id, "app_member", data.id, { user_id: f.data, role: input.role });
  return c.json(data, 201);
});

appRoutes.delete("/:id/members/:mid", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const mid = parseUuid(c.req.param("mid"));
  const { data, error } = await c.get("db").from("app_members").delete().eq("id", mid).eq("app_id", id).select().maybeSingle();
  dbFail(error, "移除成员失败");
  if (!data) throw new AppError("FORBIDDEN", "没有权限或成员不存在");
  await audit(c, "app.member_removed", id, "app_member", mid, { user_id: data.user_id, role: data.role });
  return c.json({ ok: true });
});

appRoutes.patch("/:id/members/:mid/expiry", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const mid = parseUuid(c.req.param("mid"));
  const body = await parseJson(c.req, z.object({ expires_at: z.string().nullable() }));
  if (body.expires_at && Number.isNaN(Date.parse(body.expires_at))) throw new AppError("VALIDATION", "有效期不是有效时间");
  const saved = await c.get("db").rpc("sdf_set_member_expiry", { _member: mid, _at: body.expires_at });
  if (saved.error?.message.includes("SDF_FORBIDDEN")) throw new AppError("FORBIDDEN", "只有负责人可以设置成员有效期");
  if (saved.error?.message.includes("SDF_NOT_FOUND")) throw new AppError("NOT_FOUND", "成员不存在");
  dbFail(saved.error, "设置成员有效期失败");
  await audit(c, "app.member_expiry", id, "app_member", mid, { expires_at: body.expires_at });
  return c.json({ ok: true });
});

// 项目虚拟团队（Virtual Team）：供负责人或管理员检索平台已注册用户并拉入项目
appRoutes.get("/:id/directory", async (c) => {
  const id = parseUuid(c.req.param("id"));
  requireRole(await appAccess(c, id), ["lead"], "只有交付负责人或平台管理员可以查看可邀请用户目录");
  const rows = await serviceQuery()(
    `SELECT p.id, p.email, p.display_name
     FROM public.profiles p
     JOIN auth.users u ON u.id = p.id
     WHERE COALESCE(u.disabled, false) = false
       AND (p.expires_at IS NULL OR p.expires_at > now())
     ORDER BY p.display_name, p.email
     LIMIT 300`,
    [],
  );
  return c.json({
    items: rows.map((r) => ({
      id: String(r["id"]),
      email: r["email"] ? String(r["email"]) : null,
      display_name: String(r["display_name"] ?? ""),
    })),
  });
});

// 项目虚拟团队（Virtual Team）：按用户一次性配置他在本项目中的多个角色及有效期（不影响其在其他项目的角色）
appRoutes.put("/:id/members/by-user/:uid", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const uid = parseUuid(c.req.param("uid"));
  requireRole(await appAccess(c, id), ["lead"], "只有交付负责人或平台管理员可以管理项目虚拟团队");
  const body = await parseJson(c.req, z.object({
    roles: z.array(z.enum(APP_ROLES)).max(APP_ROLES.length),
    expires_at: z.string().nullable().optional(),
  }));
  if (body.expires_at && Number.isNaN(Date.parse(body.expires_at))) {
    throw new AppError("VALIDATION", "有效期不是有效时间");
  }
  const userRows = await serviceQuery()("SELECT id FROM public.profiles WHERE id = $1", [uid]);
  if (!userRows.length) throw new AppError("NOT_FOUND", "找不到对应的已注册用户");

  const db = c.get("db");
  const cur = await db.from("app_members").select("id,role,expires_at").eq("app_id", id).eq("user_id", uid);
  dbFail(cur.error);
  const existing = (cur.data ?? []) as { id: string; role: string; expires_at: string | null }[];
  const have = new Set(existing.map((x) => x.role));
  const want = new Set(body.roles);
  const add = [...want].filter((r) => !have.has(r));
  const del = existing.filter((x) => !want.has(x.role as (typeof APP_ROLES)[number]));
  const inheritedExpiry = body.expires_at !== undefined ? body.expires_at : (existing[0]?.expires_at ?? null);

  if (add.length) {
    const ins = await db.from("app_members").insert(add.map((role) => ({ app_id: id, user_id: uid, role }))).select("id");
    dbFail(ins.error, "分配项目角色失败");
    if (inheritedExpiry) {
      for (const row of ins.data ?? []) {
        await db.rpc("sdf_set_member_expiry", { _member: row.id, _at: inheritedExpiry });
      }
    }
  }
  for (const row of del) {
    const rm = await db.from("app_members").delete().eq("id", row.id).eq("app_id", id);
    dbFail(rm.error, "移除项目角色失败");
  }
  if (body.expires_at !== undefined && want.size > 0) {
    const refreshed = await db.from("app_members").select("id").eq("app_id", id).eq("user_id", uid);
    dbFail(refreshed.error);
    for (const row of refreshed.data ?? []) {
      const saved = await db.rpc("sdf_set_member_expiry", { _member: row.id, _at: body.expires_at });
      dbFail(saved.error, "设置成员有效期失败");
    }
  }
  await audit(c, "app.team_roles_updated", id, "user", uid, {
    add,
    del: del.map((x) => x.role),
    ...(body.expires_at !== undefined ? { expires_at: body.expires_at } : {}),
  });
  return c.json({ ok: true, roles: [...want] });
});

// Contacts
appRoutes.get("/:id/contacts", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const { data, error } = await c.get("db").from("app_contacts")
    .select("id, app_role, is_business, contacts(id,name,title,org,email,is_demo,linked_profile_id)").eq("app_id", id).order("created_at");
  dbFail(error);
  return c.json({ items: data ?? [] });
});

appRoutes.post("/:id/contacts", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const input = await parseJson(c.req, z.object({
    name: z.string().trim().min(1).max(100), title: z.string().max(100).default(""), org: z.string().max(100).default(""),
    email: z.string().trim().email().max(200).nullable().optional(), app_role: z.enum(APP_ROLES), is_business: z.boolean().default(false),
  }));
  const db = c.get("db");
  const ct = await db.from("contacts").insert({ name: input.name, title: input.title, org: input.org, email: input.email ?? null, created_by: c.get("userId") }).select().single();
  dbFail(ct.error, "新建联系人失败");
  const ac = await db.from("app_contacts").insert({ app_id: id, contact_id: ct.data!.id, app_role: input.app_role, is_business: input.is_business }).select().maybeSingle();
  if (ac.error || !ac.data) {
    await db.from("contacts").delete().eq("id", ct.data!.id);
    dbFail(ac.error ?? { message: "forbidden", code: "42501" }, "关联联系人失败");
  }
  await audit(c, "app.contact_added", id, "contact", ct.data!.id, { app_role: input.app_role });
  return c.json({ ...ac.data, contacts: ct.data }, 201);
});

appRoutes.delete("/:id/contacts/:acid", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const acid = parseUuid(c.req.param("acid"));
  const { data, error } = await c.get("db").from("app_contacts").delete().eq("id", acid).eq("app_id", id).select().maybeSingle();
  dbFail(error, "移除联系人失败");
  if (!data) throw new AppError("FORBIDDEN", "没有权限或联系人不存在");
  await audit(c, "app.contact_removed", id, "app_contact", acid, { contact_id: data.contact_id });
  return c.json({ ok: true });
});

appRoutes.post("/:id/contacts/:acid/link", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const acid = parseUuid(c.req.param("acid"));
  const body = (await c.req.json().catch(() => ({}))) as { unlink?: boolean };
  const db = c.get("db");
  const ac = await db.from("app_contacts").select("contact_id").eq("id", acid).eq("app_id", id).maybeSingle();
  dbFail(ac.error);
  if (!ac.data) throw new AppError("NOT_FOUND", "联系人不存在");
  const { data, error } = await db.from("contacts").update({ linked_profile_id: body.unlink ? null : c.get("userId") }).eq("id", ac.data.contact_id).select().maybeSingle();
  dbFail(error, "关联账号失败");
  if (!data) throw new AppError("FORBIDDEN", "该联系人已关联其他账号或您没有权限");
  await audit(c, body.unlink ? "contact.unlinked" : "contact.linked", id, "contact", ac.data.contact_id, { profile_id: c.get("userId") });
  return c.json(data);
});
