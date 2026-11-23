import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { appRunsQuery, sourcesQuery, startRun, workflowsQuery, WEIGHT_LABEL, type Weight } from "@/data/runs";
import { useLiveRun } from "@/hooks/use-live-run";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StepBar, StatusBadge } from "./StepBar";
import { LiveNote } from "./LiveNote";
import { errorText } from "./common";

const FILTERS = ["all", "running", "waiting_human", "waiting_model", "failed", "completed", "cancelled"];
export function AppRuns({ appId, canStart }: { appId: string; canStart: boolean }) {
  useLiveRun(["app", appId, "runs"]);
  const { data: runs } = useSuspenseQuery(appRunsQuery(appId));
  const [filter, setFilter] = useState("all");
  const list = runs.filter((r) => filter === "all" || r.status === filter);
  return (
    <div className="space-y-4">
      {canStart && <StartRun appId={appId} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select value={filter} onValueChange={setFilter}><SelectTrigger className="w-40" aria-label="按状态筛选"><SelectValue /></SelectTrigger>
          <SelectContent>{FILTERS.map((f) => <SelectItem key={f} value={f}>{f === "all" ? "全部状态" : <StatusText s={f} />}</SelectItem>)}</SelectContent></Select>
        <LiveNote />
      </div>
      <ul className="space-y-2">
        {list.map((r) => (
          <li key={r.id}>
            <Link to="/apps/$appId/runs/$runId" params={{ appId, runId: r.id }} className="panel-surface flex flex-wrap items-center justify-between gap-3 rounded-md p-3.5 transition-colors hover:border-primary/50">
              <div className="flex flex-wrap items-center gap-3"><span className="rounded-xs bg-primary/10 px-1.5 py-0.5 font-mono text-xs font-medium text-primary">{r.code}</span><span className="font-medium">{r.workflows?.name} v{r.workflows?.version}</span><span className="text-xs text-muted-foreground">{WEIGHT_LABEL[r.weight]}档 · {new Date(r.started_at).toLocaleString("zh-CN")}</span></div>
              <div className="flex items-center gap-3"><StepBar compact steps={r.step_runs.map((s) => ({ key: s.step_key, name: s.step_key, status: s.status }))} /><StatusBadge status={r.status} /></div>
            </Link>
          </li>
        ))}
        {!list.length && <li className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">还没有运行记录</li>}
      </ul>
    </div>
  );
}
function StatusText({ s }: { s: string }) { return <StatusBadge status={s} />; }

export function StartRun({ appId, workflowId }: { appId: string; workflowId?: string }) {
  const nav = useNavigate();
  const wfs = useQuery(workflowsQuery());
  const sources = useQuery(sourcesQuery(appId));
  const startable = (wfs.data ?? []).filter((w) => w.startable);
  const [wf, setWf] = useState<string | undefined>(workflowId);
  const [weight, setWeight] = useState<Weight>("standard");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const chosen = wf ?? startable[0]?.id;
  const parsed = (sources.data ?? []).filter((s) => s.parse_status === "parsed");
  return (
    <section className="panel-surface space-y-3 rounded-md p-5" aria-label="启动运行">
      <h3 className="font-semibold">启动运行</h3>
      <div className="flex flex-wrap gap-3">
        <div className="space-y-1"><Label>工作流</Label><Select value={chosen ?? ""} onValueChange={setWf}><SelectTrigger className="w-56" aria-label="工作流"><SelectValue placeholder="选择工作流" /></SelectTrigger><SelectContent>{startable.map((w) => <SelectItem key={w.id} value={w.id}>{w.name} v{w.version}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1"><Label>档位</Label><Select value={weight} onValueChange={(v) => setWeight(v as Weight)}><SelectTrigger className="w-32" aria-label="档位"><SelectValue /></SelectTrigger><SelectContent>{(["light", "standard", "full"] as Weight[]).map((w) => <SelectItem key={w} value={w}>{WEIGHT_LABEL[w]}</SelectItem>)}</SelectContent></Select></div>
      </div>
      <div className="space-y-1"><Label>输入资料（不选则使用本应用全部已解析资料）</Label>
        {parsed.length ? <ul className="flex flex-wrap gap-3">{parsed.map((s) => <li key={s.id} className="flex items-center gap-2"><Checkbox id={`src-${s.id}`} checked={picked.includes(s.id)} onCheckedChange={(v) => setPicked((p) => v ? [...p, s.id] : p.filter((x) => x !== s.id))} /><Label htmlFor={`src-${s.id}`} className="font-normal">{s.code} {s.title}</Label></li>)}</ul>
          : <p className="text-sm text-muted-foreground">还没有已解析的资料，请先在「需求 → 原始资料」上传。</p>}
      </div>
      <Button disabled={busy || !chosen || !parsed.length} onClick={async () => {
        setBusy(true);
        try { const r = await startRun(appId, { workflow_id: chosen!, weight, source_ids: picked }); toast.success("运行已启动"); await nav({ to: "/apps/$appId/runs/$runId", params: { appId, runId: r.id } }); }
        catch (e) { toast.error(errorText(e)); } finally { setBusy(false); }
      }}>启动</Button>
    </section>
  );
}
