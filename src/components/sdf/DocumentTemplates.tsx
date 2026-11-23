import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { appsQuery } from "@/data/sdf";
import { downloadFile } from "@/data/download";
import {
  copyTemplate, createTemplate, patchTemplate, previewArtifactsQuery, restoreTemplateVersion, saveTemplateVersion, templatesQuery,
  type CoverFlags, type TemplateItem,
} from "@/data/templates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ErrorBox, errorText } from "./common";

const STATUS: Record<string, string> = { draft: "草稿", active: "启用", retired: "已停用" };
const COVER_FIELDS: { key: keyof CoverFlags; label: string }[] = [
  { key: "app_name", label: "应用名称" },
  { key: "classification", label: "密级" },
  { key: "artifact_version", label: "文档版本" },
  { key: "generated_at", label: "生成时间" },
  { key: "step_info", label: "步骤" },
  { key: "agent_role", label: "智能体角色" },
];
const PLACEHOLDERS = ["{{app_name}}", "{{classification}}", "{{doc_title}}", "{{version}}", "{{template_name}}"];
const WORD = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type Draft = {
  name: string;
  description: string;
  header_text: string;
  footer_text: string;
  show_page_numbers: boolean;
  cover: CoverFlags;
  accent: string;
  change_note: string;
  bind_types: string[];
};

function fromItem(item: TemplateItem): Draft {
  const version = item.versions.find((row) => row.version === item.current_version) ?? item.versions[item.versions.length - 1];
  return {
    name: item.name,
    description: item.description,
    header_text: version?.header_text ?? "{{app_name}} · {{classification}}",
    footer_text: version?.footer_text ?? "{{template_name}} · 内部交付资料",
    show_page_numbers: version?.show_page_numbers !== false,
    cover: version?.cover ?? { app_name: true, classification: true, artifact_version: true, generated_at: true, step_info: true, agent_role: true },
    accent: version?.style_config?.accent ?? "FF462D",
    change_note: "",
    bind_types: [...item.bindings],
  };
}

export function DocumentTemplates() {
  const qc = useQueryClient();
  const q = useQuery(templatesQuery());
  const apps = useQuery(appsQuery());
  const items = q.data?.items ?? [];
  const [sel, setSel] = useState<string | null>(null);
  const item = items.find((row) => row.id === sel) ?? items[0];
  const [draft, setDraft] = useState<Draft | null>(null);
  const [fresh, setFresh] = useState({ key: "", name: "" });
  const [copy, setCopy] = useState({ key: "", name: "" });
  const [appId, setAppId] = useState("");
  const arts = useQuery({ ...previewArtifactsQuery(appId), enabled: Boolean(appId) });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (item) setDraft(fromItem(item));
  }, [item?.id, item?.current_version, item?.bindings.join("|")]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast.success(ok); await qc.invalidateQueries({ queryKey: ["admin", "document-templates"] }); }
    catch (error) { toast.error(errorText(error)); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <ErrorBox error={q.error} />
      <p className="text-sm text-muted-foreground">一套模板只改 Word 的封面、页眉和页脚。正文仍来自制品。停用后，已绑定的制品会回退到全局默认模板，没有默认时回退到内置标准模板。</p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
        event.preventDefault();
        void run(() => createTemplate({ key: fresh.key.trim(), name: fresh.name.trim() }), "已新建草稿模板");
      }}>
        <Input className="max-w-40" aria-label="新模板标识" placeholder="标识，如 review" value={fresh.key} onChange={(e) => setFresh({ ...fresh, key: e.target.value })} />
        <Input className="max-w-56" aria-label="新模板名称" placeholder="名称" value={fresh.name} onChange={(e) => setFresh({ ...fresh, name: e.target.value })} />
        <Button type="submit" disabled={busy || !fresh.key || !fresh.name}>新建模板</Button>
      </form>
      <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <ul className="space-y-2">
          {items.map((row) => (
            <li key={row.id}>
              <button type="button" className={`w-full rounded-md border px-3 py-2 text-left ${item?.id === row.id ? "border-primary" : ""}`} onClick={() => setSel(row.id)}>
                <div className="font-medium">{row.name}</div>
                <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
                  <span>{row.key}</span><span>v{row.current_version}</span><span>{STATUS[row.status]}</span>
                  {row.is_default && <span>全局默认</span>}
                  {row.is_builtin && <span>内置</span>}
                  <span>{row.bindings.length} 个绑定</span>
                </div>
              </button>
            </li>
          ))}
          {!items.length && <li className="text-sm text-muted-foreground">还没有模板。迁移完成后这里会出现内置的标准交付文档。</li>}
        </ul>
        {item && draft && (
          <div className="space-y-4 rounded-md border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">{item.name}</h3>
              <Badge variant="outline">{STATUS[item.status]}</Badge>
              {item.is_default && <Badge variant="outline">全局默认</Badge>}
              {item.is_builtin && <Badge variant="outline">内置</Badge>}
            </div>
            <div className="flex flex-wrap gap-2">
              {item.status !== "active" && <Button size="sm" disabled={busy} onClick={() => run(() => patchTemplate(item.id, { status: "active" }), "已启用")}>启用</Button>}
              {!item.is_builtin && item.status === "active" && <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => patchTemplate(item.id, { status: "retired" }), "已停用")}>停用</Button>}
              {item.status === "active" && !item.is_default && <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => patchTemplate(item.id, { is_default: true }), "已设为全局默认")}>设为全局默认</Button>}
              <Button size="sm" variant="outline" onClick={() => downloadFile(`/admin/document-templates/${item.id}/preview.docx`, `${item.name}-预览.docx`, WORD).catch((error) => toast.error(errorText(error)))}>预览样例</Button>
            </div>
            {!item.is_builtin && item.bindings.length > 0 && item.status === "active" && (
              <p className="text-sm text-muted-foreground">这套模板绑了 {item.bindings.length} 种制品。停用后，这些制品导出时会自动改用全局默认模板；没有全局默认时，改用内置标准模板。</p>
            )}
            <label className="block text-sm">名称<Input className="mt-1" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <label className="block text-sm">说明<Textarea className="mt-1" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
            <label className="block text-sm">页眉<Input className="mt-1" value={draft.header_text} onChange={(e) => setDraft({ ...draft, header_text: e.target.value })} /></label>
            <label className="block text-sm">页脚<Input className="mt-1" value={draft.footer_text} onChange={(e) => setDraft({ ...draft, footer_text: e.target.value })} /></label>
            <div className="flex flex-wrap gap-2">
              {PLACEHOLDERS.map((token) => (
                <Button key={token} type="button" size="sm" variant="outline" onClick={() => setDraft({ ...draft, header_text: `${draft.header_text}${token}` })}>{token}</Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">上面的占位符会追加到页眉。页脚里也可以手写同样的记号。</p>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={draft.show_page_numbers} onCheckedChange={(v) => setDraft({ ...draft, show_page_numbers: v === true })} />页脚显示页码</label>
            <div className="grid gap-2 sm:grid-cols-2">
              {COVER_FIELDS.map((field) => (
                <label key={field.key} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={draft.cover[field.key]} onCheckedChange={(v) => setDraft({ ...draft, cover: { ...draft.cover, [field.key]: v === true } })} />
                  {field.label}
                </label>
              ))}
            </div>
            <label className="block text-sm">主题色（6 位，不含 #）<Input className="mt-1 max-w-40" value={draft.accent} onChange={(e) => setDraft({ ...draft, accent: e.target.value.replace("#", "").slice(0, 6) })} /></label>
            <div>
              <p className="mb-2 text-sm">单独绑定的制品类型。草稿保存时不会改线上绑定，启用后保存才会生效。</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {(q.data?.bindable_types ?? []).map((type) => (
                  <label key={type} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={draft.bind_types.includes(type)} onCheckedChange={(v) => setDraft({
                      ...draft,
                      bind_types: v === true ? [...draft.bind_types, type] : draft.bind_types.filter((x) => x !== type),
                    })} />
                    {type}
                  </label>
                ))}
              </div>
            </div>
            <label className="block text-sm">这次改了什么<Input className="mt-1" value={draft.change_note} onChange={(e) => setDraft({ ...draft, change_note: e.target.value })} /></label>
            <Button disabled={busy} onClick={() => run(() => saveTemplateVersion(item.id, {
              name: draft.name, description: draft.description, header_text: draft.header_text, footer_text: draft.footer_text,
              show_page_numbers: draft.show_page_numbers, cover: draft.cover, style_config: { accent: draft.accent || "FF462D" },
              change_note: draft.change_note, bind_types: item.status === "active" ? draft.bind_types : undefined,
            }), item.status === "active" ? "已保存新版本" : "已保存新版本，绑定未改")}>保存为新版本</Button>
            <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const created = await copyTemplate(item.id, { key: copy.key.trim(), name: copy.name.trim() });
                setSel(created.id);
              }, "已复制为草稿");
            }}>
              <Input className="max-w-40" aria-label="复制后的标识" placeholder="新标识" value={copy.key} onChange={(e) => setCopy({ ...copy, key: e.target.value })} />
              <Input className="max-w-56" aria-label="复制后的名称" placeholder="新名称" value={copy.name} onChange={(e) => setCopy({ ...copy, name: e.target.value })} />
              <Button type="submit" variant="outline" disabled={busy || !copy.key || !copy.name}>复制</Button>
            </form>
            <div className="space-y-2">
              <h4 className="text-sm font-medium">用真实制品预览</h4>
              <div className="flex flex-wrap gap-2">
                <select className="h-9 rounded-md border bg-transparent px-2 text-sm" aria-label="选择应用" value={appId} onChange={(e) => setAppId(e.target.value)}>
                  <option value="">选择应用</option>
                  {(apps.data ?? []).map((app) => <option key={app.id} value={app.id}>{app.name}</option>)}
                </select>
                <select className="h-9 max-w-xs rounded-md border bg-transparent px-2 text-sm" aria-label="选择制品" defaultValue="" onChange={(e) => {
                  if (!e.target.value) return;
                  const art = arts.data?.find((row) => row.id === e.target.value);
                  downloadFile(`/artifacts/${e.target.value}/export.docx?template_id=${item.id}`, `${art?.title ?? "预览"}.docx`, WORD).catch((error) => toast.error(errorText(error)));
                }}>
                  <option value="">选择制品并下载</option>
                  {(arts.data ?? []).map((art) => <option key={art.id} value={art.id}>{art.type} · {art.title}</option>)}
                </select>
              </div>
            </div>
            <div>
              <h4 className="mb-2 text-sm font-medium">历史版本</h4>
              <ul className="space-y-2 text-sm">
                {[...item.versions].reverse().map((version) => (
                  <li key={version.version} className="flex flex-wrap items-center gap-2 border-b py-2">
                    <span>v{version.version}</span>
                    <span className="text-muted-foreground">{version.change_note || "无说明"}</span>
                    <span className="text-muted-foreground">{new Date(version.created_at).toLocaleString("zh-CN", { hour12: false })}</span>
                    {version.version !== item.current_version && <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => restoreTemplateVersion(item.id, version.version), "已恢复为新版本")}>恢复此版本</Button>}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
