// 报告模板的管理接口。写操作记审计，内置模板的停用和删除由数据库触发器兜底。
import { Hono, type Context } from "hono";
import { z } from "zod";
import { AppError } from "@/core/errors";
import { docxAttachment } from "@/core/docx-export";
import { BINDABLE_TYPES, DEFAULT_COVER, DEFAULT_STYLE, SAMPLE_SECTIONS, buildFromTemplate } from "@/core/document-template";
import { dbFail, requireAdmin } from "../middleware";
import { parseJson, parseUuid } from "../validate";
import { loadTemplateForExport } from "../template-store";
import type { AppEnv } from "../context";

export const templateRoutes = new Hono<AppEnv>();
templateRoutes.use("/admin/document-templates", requireAdmin);
templateRoutes.use("/admin/document-templates/*", requireAdmin);

const keySchema = z.string().regex(/^[a-z][a-z0-9-]{0,40}$/, "标识只能用小写英文、数字和短横线");
const coverSchema = z.object({
  app_name: z.boolean(), classification: z.boolean(), artifact_version: z.boolean(),
  generated_at: z.boolean(), step_info: z.boolean(), agent_role: z.boolean(),
});
const styleSchema = z.object({
  accent: z.string().regex(/^[0-9A-Fa-f]{6}$/).optional(),
  font_ascii: z.enum(["Calibri", "Arial"]).optional(),
  font_east_asia: z.enum(["Microsoft YaHei", "DengXian", "SimSun"]).optional(),
});
const versionSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(400).optional(),
  header_text: z.string().max(200),
  footer_text: z.string().max(200),
  show_page_numbers: z.boolean(),
  cover: coverSchema,
  style_config: styleSchema.default({}),
  change_note: z.string().max(200).default(""),
  bind_types: z.array(z.enum(BINDABLE_TYPES)).max(BINDABLE_TYPES.length).optional(),
});

function failTemplate(error: { message: string; code?: string } | null): void {
  if (!error) return;
  const hit = error.message.match(/内置模板[^。]*/);
  if (hit) throw new AppError("VALIDATION", hit[0]);
  dbFail(error);
}

const nowIso = () => new Date().toISOString();

function audit(c: Context<AppEnv>, action: string, id: string, detail: Record<string, unknown>) {
  return c.get("deps").sys.writeAudit({ trace_id: c.get("traceId"), actor_id: c.get("userId"), action, target_type: "document_template", target_id: id, detail });
}

async function replaceBindings(c: Context<AppEnv>, templateId: string, types: string[]) {
  const db = c.get("db");
  const mine = await db.from("template_bindings").select("artifact_type").eq("template_id", templateId);
  dbFail(mine.error);
  for (const row of mine.data ?? []) {
    if (types.includes(row.artifact_type)) continue;
    const removed = await db.from("template_bindings").delete().eq("artifact_type", row.artifact_type);
    dbFail(removed.error);
  }
  for (const type of types) {
    const removed = await db.from("template_bindings").delete().eq("artifact_type", type);
    dbFail(removed.error);
    const inserted = await db.from("template_bindings").insert({ artifact_type: type, template_id: templateId, updated_by: c.get("userId"), updated_at: nowIso() });
    dbFail(inserted.error);
  }
  await audit(c, "template.bindings_updated", templateId, { types });
}

templateRoutes.get("/admin/document-templates/preview-artifacts", async (c) => {
  const appId = parseUuid(c.req.query("app_id") ?? "");
  const rows = await c.get("db").from("artifacts").select("id,type,title,version").eq("app_id", appId).eq("is_latest", true).order("type").limit(80);
  dbFail(rows.error);
  return c.json({ items: rows.data ?? [] });
});

templateRoutes.get("/admin/document-templates", async (c) => {
  const db = c.get("db");
  const [templates, versions, bindings] = await Promise.all([
    db.from("document_templates").select("id,key,name,description,status,is_builtin,is_default,current_version,updated_at").order("name"),
    db.from("document_template_versions").select("template_id,version,header_text,footer_text,show_page_numbers,cover,style_config,change_note,created_at").order("version"),
    db.from("template_bindings").select("artifact_type,template_id"),
  ]);
  dbFail(templates.error); dbFail(versions.error); dbFail(bindings.error);
  const items = (templates.data ?? []).map((template) => ({
    ...template,
    versions: (versions.data ?? []).filter((row) => row.template_id === template.id),
    bindings: (bindings.data ?? []).filter((row) => row.template_id === template.id).map((row) => row.artifact_type),
  }));
  return c.json({ items, bindable_types: BINDABLE_TYPES });
});

templateRoutes.post("/admin/document-templates", async (c) => {
  const input = await parseJson(c.req, z.object({ key: keySchema, name: z.string().min(1).max(80), description: z.string().max(400).default("") }));
  if (input.key === "standard") throw new AppError("VALIDATION", "standard 是内置标识");
  const db = c.get("db");
  const created = await db.from("document_templates").insert({
    key: input.key, name: input.name, description: input.description, status: "draft", is_builtin: false, is_default: false,
    current_version: 1, created_by: c.get("userId"), updated_at: nowIso(),
  }).select("id").single();
  failTemplate(created.error);
  const version = await db.from("document_template_versions").insert({
    template_id: created.data.id, version: 1, header_text: "{{app_name}} · {{classification}}", footer_text: "{{template_name}} · 内部交付资料",
    show_page_numbers: true, cover: DEFAULT_COVER, style_config: DEFAULT_STYLE, change_note: "新建", created_by: c.get("userId"),
  });
  failTemplate(version.error);
  await audit(c, "template.created", created.data.id, { key: input.key });
  return c.json({ id: created.data.id }, 201);
});

templateRoutes.post("/admin/document-templates/:id/copy", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const input = await parseJson(c.req, z.object({ key: keySchema, name: z.string().min(1).max(80) }));
  if (input.key === "standard") throw new AppError("VALIDATION", "standard 是内置标识");
  const db = c.get("db");
  const source = await db.from("document_templates").select("id,current_version,description").eq("id", id).maybeSingle();
  dbFail(source.error);
  if (!source.data) throw new AppError("NOT_FOUND", "模板不存在");
  const ver = await db.from("document_template_versions").select("header_text,footer_text,show_page_numbers,cover,style_config").eq("template_id", id).eq("version", source.data.current_version).maybeSingle();
  dbFail(ver.error);
  if (!ver.data) throw new AppError("NOT_FOUND", "模板版本不存在");
  const created = await db.from("document_templates").insert({
    key: input.key, name: input.name, description: source.data.description, status: "draft", is_builtin: false, is_default: false,
    current_version: 1, created_by: c.get("userId"), updated_at: nowIso(),
  }).select("id").single();
  failTemplate(created.error);
  const copy = await db.from("document_template_versions").insert({ ...ver.data, template_id: created.data.id, version: 1, change_note: "从现有模板复制", created_by: c.get("userId") });
  failTemplate(copy.error);
  await audit(c, "template.created", created.data.id, { key: input.key, copied_from: id });
  return c.json({ id: created.data.id }, 201);
});

templateRoutes.patch("/admin/document-templates/:id", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const input = await parseJson(c.req, z.object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(400).optional(),
    status: z.enum(["draft", "active", "retired"]).optional(),
    is_default: z.boolean().optional(),
  }));
  const db = c.get("db");
  const current = await db.from("document_templates").select("id,key,status,is_builtin,is_default").eq("id", id).maybeSingle();
  dbFail(current.error);
  if (!current.data) throw new AppError("NOT_FOUND", "模板不存在");
  const nextStatus = input.status ?? current.data.status;
  if (current.data.is_builtin && nextStatus !== "active") throw new AppError("VALIDATION", "内置模板不能停用");
  if (input.is_default && nextStatus !== "active") throw new AppError("VALIDATION", "只有启用中的模板可以设为全局默认");
  if (input.is_default) {
    const others = await db.from("document_templates").select("id").eq("is_default", true);
    dbFail(others.error);
    for (const row of others.data ?? []) {
      if (row.id === id) continue;
      const cleared = await db.from("document_templates").update({ is_default: false, updated_at: nowIso() }).eq("id", row.id);
      failTemplate(cleared.error);
    }
  }
  const patch: Record<string, unknown> = { updated_at: nowIso() };
  if (input.name !== undefined) patch["name"] = input.name;
  if (input.description !== undefined) patch["description"] = input.description;
  if (input.status !== undefined) patch["status"] = input.status;
  if (input.is_default !== undefined) patch["is_default"] = input.is_default;
  if (nextStatus !== "active") patch["is_default"] = false;
  const updated = await db.from("document_templates").update(patch).eq("id", id);
  failTemplate(updated.error);
  const action = input.status !== undefined || input.is_default !== undefined ? "template.status_changed" : "template.version_saved";
  await audit(c, action, id, { status: nextStatus, is_default: patch["is_default"] ?? current.data.is_default, key: current.data.key });
  return c.json({ ok: true });
});

templateRoutes.post("/admin/document-templates/:id/versions", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const input = await parseJson(c.req, versionSchema);
  const db = c.get("db");
  const current = await db.from("document_templates").select("id,status,current_version").eq("id", id).maybeSingle();
  dbFail(current.error);
  if (!current.data) throw new AppError("NOT_FOUND", "模板不存在");
  const next = Number(current.data.current_version) + 1;
  const inserted = await db.from("document_template_versions").insert({
    template_id: id, version: next, header_text: input.header_text, footer_text: input.footer_text,
    show_page_numbers: input.show_page_numbers, cover: input.cover, style_config: { ...DEFAULT_STYLE, ...input.style_config },
    change_note: input.change_note, created_by: c.get("userId"),
  });
  failTemplate(inserted.error);
  const meta: Record<string, unknown> = { current_version: next, updated_at: nowIso() };
  if (input.name) meta["name"] = input.name;
  if (input.description !== undefined) meta["description"] = input.description;
  const bumped = await db.from("document_templates").update(meta).eq("id", id);
  failTemplate(bumped.error);
  let bindingsApplied = false;
  if (input.bind_types && current.data.status === "active") {
    await replaceBindings(c, id, input.bind_types);
    bindingsApplied = true;
  }
  await audit(c, "template.version_saved", id, { version: next, bindings_applied: bindingsApplied });
  return c.json({ version: next, bindings_applied: bindingsApplied });
});

templateRoutes.post("/admin/document-templates/:id/restore", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const input = await parseJson(c.req, z.object({ version: z.number().int().min(1), change_note: z.string().max(200).default("") }));
  const db = c.get("db");
  const current = await db.from("document_templates").select("id,current_version").eq("id", id).maybeSingle();
  dbFail(current.error);
  if (!current.data) throw new AppError("NOT_FOUND", "模板不存在");
  const old = await db.from("document_template_versions").select("header_text,footer_text,show_page_numbers,cover,style_config").eq("template_id", id).eq("version", input.version).maybeSingle();
  dbFail(old.error);
  if (!old.data) throw new AppError("NOT_FOUND", "要恢复的版本不存在");
  const next = Number(current.data.current_version) + 1;
  const inserted = await db.from("document_template_versions").insert({
    ...old.data, template_id: id, version: next, change_note: input.change_note || `恢复自 v${input.version}`, created_by: c.get("userId"),
  });
  failTemplate(inserted.error);
  const bumped = await db.from("document_templates").update({ current_version: next, updated_at: nowIso() }).eq("id", id);
  failTemplate(bumped.error);
  await audit(c, "template.version_saved", id, { version: next, restored_from: input.version });
  return c.json({ version: next });
});

templateRoutes.get("/admin/document-templates/:id/preview.docx", async (c) => {
  const id = parseUuid(c.req.param("id"));
  const versionRaw = c.req.query("version");
  const version = versionRaw ? Number(versionRaw) : undefined;
  if (versionRaw && !Number.isInteger(version)) throw new AppError("VALIDATION", "版本号不正确");
  const snap = await loadTemplateForExport(c.get("db"), "requirements", id, version);
  if (!snap) throw new AppError("NOT_FOUND", "模板不存在");
  const bytes = buildFromTemplate("模板预览", SAMPLE_SECTIONS, snap, {
    appName: "样例应用", classification: "内部", version: `v${snap.version}`, generatedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    stepInfo: "B03 需求分析", agentRole: "需求评审员",
  });
  const file = docxAttachment(bytes, `${snap.name}-预览.docx`);
  return c.body(file.body, 200, file.headers);
});
