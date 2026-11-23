import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { parse, stringify } from "yaml";
import { toast } from "sonner";
import { workflowsQuery, WEIGHT_LABEL, type Weight, type Workflow } from "@/data/runs";
import { appsQuery } from "@/data/sdf";
import { api } from "@/data/http";
import { PageHeader } from "@/components/sdf/common";
import { StepBar } from "@/components/sdf/StepBar";
import { StartRun } from "@/components/sdf/AppRuns";
import { useWorkflowPreview } from "@/components/sdf/CommandPalette";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/_wb/workflows")({
  head: () => ({ meta: [
    { title: "工作流 · SDF 智能应用工厂" },
    { name: "description", content: "查看内置工作流、YAML、校验结果和计划预览，并启动运行" },
    { property: "og:title", content: "工作流 · SDF 智能应用工厂" },
    { property: "og:description", content: "查看内置工作流、YAML、校验结果和计划预览，并启动运行" },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  loader: ({ context }) => Promise.all([context.queryClient.ensureQueryData(workflowsQuery()), context.queryClient.ensureQueryData(appsQuery())]),
  component: WorkflowsPage,
});

function WorkflowsPage() {
  const { data } = useSuspenseQuery(workflowsQuery());
  const [draft, setDraft] = useState("");
  const [yaml, setYaml] = useState("");
  const [flowKey, setFlowKey] = useState("custom_flow");
  const [flowName, setFlowName] = useState("自定义工作流");
  const [editing, setEditing] = useState<string | null>(null);
  const [copiedFrom, setCopiedFrom] = useState<string | null>(null);
  const [appId, setAppId] = useState("");
  const { data: apps } = useSuspenseQuery(appsQuery());
  const qc = useQueryClient();
  useEffect(() => {
    const timer = window.setTimeout(() => setYaml(draft), 400);
    return () => window.clearTimeout(timer);
  }, [draft]);
  const preview = useWorkflowPreview(yaml);
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="WORKFLOW ORCHESTRATION" title="工作流" desc="内置工作流可以直接启动。复制一份后可以编辑 YAML 串联积木与确认点，右侧实时展示校验与步骤预览。" />
      <section className="panel-surface grid gap-5 rounded-md p-5 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-foreground">自定义工作流</h3>
            <span className="stencil text-[10px] text-muted-foreground">YAML DEFINITION</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <input className="h-9 rounded-md border border-input bg-background px-3 font-mono text-xs" aria-label="工作流编号" value={flowKey} onChange={(event) => setFlowKey(event.target.value)} />
            <input className="h-9 rounded-md border border-input bg-background px-3 text-sm" aria-label="工作流名称" value={flowName} onChange={(event) => setFlowName(event.target.value)} />
            <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" aria-label="归属应用" value={appId} onChange={(event) => setAppId(event.target.value)}>
              <option value="">全局（仅管理员）</option>
              {apps.map((app) => <option key={app.id} value={app.id}>{app.name}</option>)}
            </select>
          </div>
          <textarea className="min-h-64 w-full rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="从下面的内置工作流点「复制」" />
          <Button size="sm" disabled={!draft.trim()} onClick={async () => {
            try {
              const saved = await api<{ id: string; startable: boolean; issues: string[] }>("/workflows", {
                method: "POST",
                body: { ...(editing ? { id: editing } : {}), app_id: appId || null, key: flowKey, name: flowName, yaml: draft, copied_from: copiedFrom },
              });
              setEditing(saved.id);
              toast.success(saved.startable ? "已保存，可以启动" : `已保存，还有 ${saved.issues.length} 个问题`);
              await qc.invalidateQueries({ queryKey: ["workflows"] });
            } catch (error) { toast.error(error instanceof Error ? error.message : "不能保存"); }
          }}>保存</Button>
        </div>
        <div className="space-y-3 rounded-md border border-border bg-background/60 p-4 text-sm">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-foreground">校验和预览</h3>
            <span className="stencil text-[10px] text-muted-foreground">VALIDATION</span>
          </div>
          {preview.data?.issues.length ? <ul className="list-disc space-y-1 pl-5 text-destructive">{preview.data.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : <p className="text-xs font-medium text-success">{yaml.trim() ? "校验通过" : "先从下方选择一个内置工作流点击「复制」或粘贴 YAML"}</p>}
          <StepBar steps={(preview.data?.plans?.["standard"] ?? []).map((step) => ({ key: step.key, name: step.name, status: step.skipped ? "skipped" : "pending", checkpoint: step.checkpoint }))} />
        </div>
      </section>
      <ul className="space-y-4">{data.map((w) => <WorkflowCard key={w.id} w={w} onCopy={() => {
        setDraft(yamlText(w.yaml));
        setFlowKey(w.is_builtin ? `${w.key}_copy` : w.key);
        setFlowName(w.name);
        setEditing(w.is_builtin ? null : w.id);
        setCopiedFrom(w.is_builtin ? w.id : null);
        setAppId("");
      }} />)}</ul>
    </div>
  );
}

function yamlText(raw: string) {
  try { return stringify(parse(raw)); } catch { return raw; }
}

function WorkflowCard({ w, onCopy }: { w: Workflow; onCopy: () => void }) {
  const [weight, setWeight] = useState<Weight>("standard");
  const [view, setView] = useState<"none" | "yaml" | "start">("none");
  const { data: apps } = useSuspenseQuery(appsQuery());
  const [appId, setAppId] = useState<string | undefined>(apps[0]?.id);
  const yamlTextShown = yamlText(w.yaml);
  return (
    <li className="panel-surface space-y-3.5 rounded-md p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold text-foreground">{w.name}</h3>
          <span className="rounded-xs border border-border bg-muted/60 px-2 py-0.5 font-mono text-xs text-muted-foreground">
            {w.key} v{w.version}
          </span>
          {w.is_builtin && <Badge variant="secondary">内置</Badge>}
        </div>
        <div className="flex items-center gap-2">
          {w.issues.length === 0 && <span className="text-xs font-medium text-success">校验通过</span>}
          {w.startable && !w.issues.length ? <Badge>可启动</Badge> : <Badge variant="outline">不能启动</Badge>}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{w.description}</p>
      {w.issues.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-destructive">{w.issues.map((i) => <li key={i}>{i}</li>)}</ul>
      )}
      <div className="flex flex-wrap items-center gap-3 rounded-sm border border-border bg-background/50 p-3">
        <Select value={weight} onValueChange={(v) => setWeight(v as Weight)}><SelectTrigger className="w-28 bg-panel" aria-label={`${w.name} 档位`}><SelectValue /></SelectTrigger><SelectContent>{(["light", "standard", "full"] as Weight[]).map((x) => <SelectItem key={x} value={x}>{WEIGHT_LABEL[x]}</SelectItem>)}</SelectContent></Select>
        <div className="min-w-0 flex-1">
          <StepBar steps={w.plans[weight].map((s) => ({ key: s.key, name: s.name, status: s.skipped ? "skipped" : "pending", checkpoint: s.checkpoint }))} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={onCopy}>复制</Button><Button variant="outline" size="sm" onClick={() => setView(view === "yaml" ? "none" : "yaml")}>查看 YAML</Button>{w.startable && !w.issues.length && <Button size="sm" onClick={() => setView(view === "start" ? "none" : "start")}>启动运行</Button>}</div>
      {view === "yaml" && <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/60 p-3.5 font-mono text-xs leading-relaxed">{yamlTextShown}</pre>}
      {view === "start" && (
        <div className="space-y-2 border-t border-border pt-3">
          <Select value={appId ?? ""} onValueChange={setAppId}><SelectTrigger className="w-64" aria-label="选择应用"><SelectValue placeholder="选择应用" /></SelectTrigger><SelectContent>{apps.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent></Select>
          {appId && <StartRun key={appId} appId={appId} workflowId={w.id} />}
        </div>
      )}
    </li>
  );
}
