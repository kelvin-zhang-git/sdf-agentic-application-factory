// 报告模板的纯逻辑：三级回退、封面开关、以及套到 Word 上的字段。
import { buildDocx, renderTemplatePlaceholders, STANDARD_TEMPLATE_NAME, type CoverFlags, type DocMeta, type DocSection, type StyleConfig } from "./docx-export";

export const BINDABLE_TYPES = [
  "requirements", "analysis", "clarifications", "document_srs", "document_design",
  "data_model", "prototype_html", "context_pack", "flow_metrics", "review_note",
  "test_report", "architecture", "task_board", "constitution", "priority_list", "test_design",
] as const;

/** 业务方不能从通用导出接口拿到这些技术制品。 */
export const TECHNICAL_EXPORT_TYPES = new Set([
  "data_model", "prototype_html", "document_design", "context_pack", "pipeline",
  "scaffold", "asset_pack", "review_note", "flow_metrics", "test_report",
  "architecture", "openapi", "task_board",
]);

export const DEFAULT_COVER: CoverFlags = {
  app_name: true, classification: true, artifact_version: true, generated_at: true, step_info: true, agent_role: true,
};

export const DEFAULT_STYLE: StyleConfig = { accent: "FF462D", font_ascii: "Calibri", font_east_asia: "Microsoft YaHei" };

export interface TemplateSnapshot {
  id: string;
  key: string;
  name: string;
  status: string;
  version: number;
  header_text: string;
  footer_text: string;
  show_page_numbers: boolean;
  cover: CoverFlags;
  style_config: StyleConfig;
}

export interface TemplateCandidate {
  status: string;
  snap: TemplateSnapshot;
}

/** 绑定且启用优先，其次全局默认，最后内置标准模板。 */
export function resolveTemplateChoice(input: {
  bound: TemplateCandidate | null;
  globalDefault: TemplateSnapshot | null;
  standard: TemplateSnapshot;
}): TemplateSnapshot {
  if (input.bound?.status === "active") return input.bound.snap;
  if (input.globalDefault?.status === "active") return input.globalDefault;
  return input.standard;
}

export function coverFrom(value: unknown): CoverFlags {
  const raw = (value ?? {}) as Partial<CoverFlags>;
  return {
    app_name: raw.app_name !== false,
    classification: raw.classification !== false,
    artifact_version: raw.artifact_version !== false,
    generated_at: raw.generated_at !== false,
    step_info: raw.step_info !== false,
    agent_role: raw.agent_role !== false,
  };
}

export function metaFromSnapshot(snap: TemplateSnapshot, ctx: {
  appName?: string | undefined; classification?: string | undefined; version?: string | undefined; generatedAt?: string | undefined; stepInfo?: string | undefined; agentRole?: string | undefined; docTitle: string;
}): DocMeta {
  const fields: Record<string, string> = {
    app_name: ctx.appName ?? "",
    classification: ctx.classification ?? "",
    doc_title: ctx.docTitle,
    version: ctx.version ?? "",
    template_name: snap.name,
  };
  return {
    templateName: snap.name,
    headerText: renderTemplatePlaceholders(snap.header_text, fields),
    footerText: renderTemplatePlaceholders(snap.footer_text, fields),
    showPageNumbers: snap.show_page_numbers,
    cover: snap.cover,
    style: snap.style_config,
    appName: ctx.appName,
    classification: ctx.classification,
    version: ctx.version,
    generatedAt: ctx.generatedAt,
    stepInfo: ctx.stepInfo,
    agentRole: ctx.agentRole,
    docTitle: ctx.docTitle,
  };
}

export function buildFromTemplate(title: string, sections: DocSection[], snap: TemplateSnapshot | null, ctx: {
  appName?: string | undefined; classification?: string | undefined; version?: string | undefined; generatedAt?: string | undefined; stepInfo?: string | undefined; agentRole?: string | undefined;
}): Uint8Array {
  if (!snap) {
    return buildDocx(title, sections, {
      templateName: STANDARD_TEMPLATE_NAME,
      appName: ctx.appName,
      classification: ctx.classification,
      version: ctx.version,
      generatedAt: ctx.generatedAt,
      stepInfo: ctx.stepInfo,
      agentRole: ctx.agentRole,
      docTitle: title,
    });
  }
  return buildDocx(title, sections, metaFromSnapshot(snap, { ...ctx, docTitle: title }));
}

export const SAMPLE_SECTIONS: DocSection[] = [
  { heading: "样例章节", level: 1, paragraphs: ["这是模板预览用的样例，不是正式制品。"], table: [["编号", "标题"], ["REQ-0001", "开单页免前置选择直接进入"]] },
];
