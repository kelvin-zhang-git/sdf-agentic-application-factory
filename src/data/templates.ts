import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { api } from "./http";

export interface CoverFlags {
  app_name: boolean;
  classification: boolean;
  artifact_version: boolean;
  generated_at: boolean;
  step_info: boolean;
  agent_role: boolean;
}

export interface TemplateVersion {
  version: number;
  header_text: string;
  footer_text: string;
  show_page_numbers: boolean;
  cover: CoverFlags;
  style_config: { accent?: string; font_ascii?: string; font_east_asia?: string };
  change_note: string;
  created_at: string;
}

export interface TemplateItem {
  id: string;
  key: string;
  name: string;
  description: string;
  status: "draft" | "active" | "retired";
  is_builtin: boolean;
  is_default: boolean;
  current_version: number;
  updated_at: string;
  versions: TemplateVersion[];
  bindings: string[];
}

export interface TemplateList {
  items: TemplateItem[];
  bindable_types: string[];
}

export const templatesQuery = () => queryOptions({
  queryKey: ["admin", "document-templates"],
  queryFn: () => api<TemplateList>("/admin/document-templates"),
});

export const previewArtifactsQuery = (appId: string) => queryOptions({
  queryKey: ["admin", "preview-artifacts", appId],
  queryFn: () => api<{ items: { id: string; type: string; title: string; version: number }[] }>(`/admin/document-templates/preview-artifacts?app_id=${appId}`).then((r) => r.items),
  enabled: Boolean(appId),
});

export const createTemplate = (body: { key: string; name: string; description?: string }) =>
  api<{ id: string }>("/admin/document-templates", { method: "POST", body });

export const copyTemplate = (id: string, body: { key: string; name: string }) =>
  api<{ id: string }>(`/admin/document-templates/${id}/copy`, { method: "POST", body });

export const patchTemplate = (id: string, body: { name?: string; description?: string; status?: string; is_default?: boolean }) =>
  api(`/admin/document-templates/${id}`, { method: "PATCH", body });

export const saveTemplateVersion = (id: string, body: Record<string, unknown>) =>
  api<{ version: number; bindings_applied: boolean }>(`/admin/document-templates/${id}/versions`, { method: "POST", body });

export const restoreTemplateVersion = (id: string, version: number) =>
  api<{ version: number }>(`/admin/document-templates/${id}/restore`, { method: "POST", body: { version, change_note: `恢复自 v${version}` } });

export function refreshTemplates(qc: ReturnType<typeof useQueryClient>) {
  return qc.invalidateQueries({ queryKey: ["admin", "document-templates"] });
}
