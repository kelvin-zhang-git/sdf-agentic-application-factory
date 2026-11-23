// 从数据库取出报告模板。表还没迁移时返回 null，导出仍可用内置版式。
import type { UserDb } from "@/adapters/pg-query";
import { coverFrom, DEFAULT_STYLE, resolveTemplateChoice, type TemplateSnapshot } from "@/core/document-template";
import type { StyleConfig } from "@/core/docx-export";

function styleFrom(value: unknown): StyleConfig {
  const raw = (value ?? {}) as StyleConfig;
  return { ...DEFAULT_STYLE, ...raw };
}

function snap(template: Record<string, unknown>, version: Record<string, unknown>): TemplateSnapshot {
  return {
    id: String(template["id"]),
    key: String(template["key"]),
    name: String(template["name"]),
    status: String(template["status"]),
    version: Number(version["version"]),
    header_text: String(version["header_text"] ?? ""),
    footer_text: String(version["footer_text"] ?? ""),
    show_page_numbers: version["show_page_numbers"] !== false,
    cover: coverFrom(version["cover"]),
    style_config: styleFrom(version["style_config"]),
  };
}

async function readTemplate(db: UserDb, templateId: string, version?: number): Promise<TemplateSnapshot | null> {
  const template = await db.from("document_templates").select("id,key,name,status,current_version").eq("id", templateId).maybeSingle();
  if (template.error || !template.data) return null;
  const wanted = version ?? Number(template.data.current_version);
  const row = await db.from("document_template_versions").select("version,header_text,footer_text,show_page_numbers,cover,style_config").eq("template_id", templateId).eq("version", wanted).maybeSingle();
  if (row.error || !row.data) return null;
  return snap(template.data, row.data);
}

async function readByKey(db: UserDb, key: string): Promise<TemplateSnapshot | null> {
  const template = await db.from("document_templates").select("id").eq("key", key).maybeSingle();
  if (template.error || !template.data) return null;
  return readTemplate(db, template.data.id);
}

/** 具体绑定 → 全局默认启用模板 → 内置 standard。任何查询失败都交给调用方用写死版式。 */
export async function loadTemplateForExport(db: UserDb, artifactType: string, overrideId?: string | null, overrideVersion?: number): Promise<TemplateSnapshot | null> {
  try {
    if (overrideId) return await readTemplate(db, overrideId, overrideVersion);
    const binding = await db.from("template_bindings").select("template_id").eq("artifact_type", artifactType).maybeSingle();
    if (binding.error) return null;
    const bound = binding.data ? await readTemplate(db, binding.data.template_id) : null;
    const defaults = await db.from("document_templates").select("id,status").eq("is_default", true).eq("status", "active").limit(1);
    if (defaults.error) return null;
    const globalDefault = defaults.data?.[0] ? await readTemplate(db, defaults.data[0].id) : null;
    const standard = await readByKey(db, "standard");
    if (!standard) return bound?.status === "active" ? bound : globalDefault;
    return resolveTemplateChoice({
      bound: bound ? { status: bound.status, snap: bound } : null,
      globalDefault,
      standard,
    });
  } catch {
    return null;
  }
}
