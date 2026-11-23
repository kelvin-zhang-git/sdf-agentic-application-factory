import { useMemo, useState } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { cancelRun, decideStep, requirementsQuery, rerunFrom, retryStep, runQuery, skipStep, STATUS_LABEL, WAIT_LABEL, WEIGHT_LABEL, type RunDetail, type StepRun } from "@/data/runs";
import { downloadFile } from "@/data/download";
import { exportDiagnostics } from "@/data/diagnostics";
import { withRequirementLink } from "@/core/report-link";
import { useLiveRun } from "@/hooks/use-live-run";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Markdown } from "./Markdown";
import { StepBar, StatusBadge, since } from "./StepBar";
import { LiveNote } from "./LiveNote";
import { ErrorBox, Mono, errorText } from "./common";

const TERMINAL = ["completed", "cancelled"];
function useAct(runId: string, appId: string) {
  const qc = useQueryClient(); const [busy, setBusy] = useState(false);
  return { busy, run: async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast.success(ok); } catch (e) { toast.error(errorText(e)); } finally {
      setBusy(false);
      // 仅精准刷新当前运行、待办和当前应用相关缓存，避免全站缓存清空触发请求风暴
      void qc.invalidateQueries({ queryKey: ["run", runId] });
      void qc.invalidateQueries({ queryKey: ["inbox"] });
      void qc.invalidateQueries({ queryKey: ["app", appId] });
    }
  } };
}

export function RunDetailView({ runId }: { runId: string }) {
  const key = useMemo(() => ["run", runId], [runId]);
  useLiveRun(key);
  const { data } = useSuspenseQuery(runQuery(runId));
  const { run, steps, access } = data;
  const current = steps.filter((s) => s.is_current).sort((a, b) => a.seq - b.seq);
  const names = Object.fromEntries((run.workflow_snapshot.steps ?? []).map((s) => [s.key, s.name]));
  const [sel, setSel] = useState<string | null>(null);
  const active = current.find((s) => s.step_key === (sel ?? run.current_step_key)) ?? current.find((s) => s.status !== "succeeded" && s.status !== "skipped") ?? current[current.length - 1];
  const isLead = access.isAdmin || access.roles.includes("lead");
  const canManage = isLead || run.started_by === access.user_id;
  const act = useAct(runId, run.app_id);
  const waitingSince = active?.status === "waiting_human" ? data.events.filter((e) => e.step_run_id === active.id).at(-1)?.ts : active?.started_at;
  return (
    <div className="space-y-5">
      <div className="panel-surface overflow-hidden rounded-md">
        <div className="blueprint-grid">
          <div className="flex flex-wrap items-start justify-between gap-4 bg-panel/85 px-5 py-5 sm:px-6">
            <div className="space-y-1">
              <p className="stencil text-[10px] font-medium text-primary">WORKFLOW EXECUTION</p>
              <h1 className="text-2xl font-semibold tracking-tight">运行 {run.code}</h1>
              <p className="text-sm text-muted-foreground">{run.workflows?.name} v{run.workflows?.version} · {WEIGHT_LABEL[run.weight]}档 · 开始于 {new Date(run.started_at).toLocaleString("zh-CN")}</p>
              <div className="flex flex-wrap items-center gap-2"><StatusBadge status={run.status} />{!TERMINAL.includes(run.status) && <span className="text-xs text-muted-foreground">当前状态已持续 {since(waitingSince)}</span>}<Mono>trace {run.trace_id}</Mono></div>
            </div>
            <div className="flex flex-wrap gap-2">
              {canManage && active && run.status !== "cancelled" && <Button variant="outline" disabled={act.busy || active.status === "running" || active.status === "pending"} onClick={() => act.run(() => rerunFrom(run.id, active.step_key), `已从「${names[active.step_key]}」重新排队`)}>从选中步骤重跑</Button>}
              {canManage && !TERMINAL.includes(run.status) && <Button variant="destructive" disabled={act.busy} onClick={() => { if (confirm("确定取消这次运行？未完成的步骤将标记为已取消。")) void act.run(() => cancelRun(run.id), "运行已取消"); }}>取消运行</Button>}
            </div>
          </div>
        </div>
      </div>
      <div className="panel-surface rounded-md p-4">
        <StepBar steps={current.map((s) => ({ key: s.step_key, name: names[s.step_key] ?? s.step_key, status: s.status, checkpoint: s.checkpoint?.role ?? null, summary: s.summary, attempt: s.attempt }))} onSelect={setSel} selected={active?.step_key ?? null} />
        <div className="mt-2"><LiveNote /></div>
      </div>
      <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        <StepList steps={steps} current={current} names={names} selected={active?.step_key} onSelect={setSel} />
        {active && <StepPanel key={active.id} data={data} step={active} names={names} isLead={isLead} act={act} />}
      </div>
    </div>
  );
}

function StepList({ steps, current, names, selected, onSelect }: { steps: StepRun[]; current: StepRun[]; names: Record<string, string>; selected: string | undefined; onSelect: (k: string) => void }) {
  return (
    <ul className="space-y-2" aria-label="步骤列表">
      {current.map((s) => {
        const history = steps.filter((h) => h.step_key === s.step_key && !h.is_current).sort((a, b) => b.attempt - a.attempt);
        const dur = s.started_at ? Math.round(((s.finished_at ? new Date(s.finished_at).getTime() : Date.now()) - new Date(s.started_at).getTime()) / 1000) : null;
        return (
          <li key={s.step_key} className={`rounded-md border bg-card p-3 ${selected === s.step_key ? "ring-2 ring-ring" : ""}`}>
            <button type="button" className="w-full text-left" onClick={() => onSelect(s.step_key)}>
              <div className="flex items-center justify-between gap-2"><span className="font-medium">{names[s.step_key] ?? s.step_key}</span><StatusBadge status={s.status} /></div>
              <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground"><span>{s.block_key}</span>{s.checkpoint?.role && <span>确认·{s.checkpoint.role}</span>}<span>第 {s.attempt} 次</span>{dur !== null && <span>用时 {dur}s</span>}</div>
            </button>
            {history.length > 0 && (
              <details className="mt-2 text-xs"><summary className="cursor-pointer text-muted-foreground">历史执行 {history.length} 次</summary>
                <ul className="mt-1 space-y-1">{history.map((h) => <li key={h.id} className="flex justify-between gap-2"><span>第 {h.attempt} 次 · {STATUS_LABEL[h.status]}</span><span className="truncate text-muted-foreground">{h.decision_comment ?? h.summary ?? h.error?.message ?? ""}</span></li>)}</ul>
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function StepPanel({ data, step, names, isLead, act }: { data: RunDetail; step: StepRun; names: Record<string, string>; isLead: boolean; act: ReturnType<typeof useAct> }) {
  const events = data.events.filter((e) => e.step_run_id === step.id);
  const arts = data.artifacts.filter((a) => step.output_artifacts.includes(a.id));
  const needsReqs = arts.some((a) => a.type === "requirements" || a.type === "analysis");
  const reqs = useQuery({ ...requirementsQuery(data.run.app_id), enabled: needsReqs });
  const block = data.blocks[step.block_key];
  const canDecide = data.access.isAdmin || data.access.roles.includes("lead") || (!!step.checkpoint?.role && data.access.roles.includes(step.checkpoint.role));
  return (
    <Tabs defaultValue={step.status === "waiting_human" ? "decide" : "overview"} className="min-w-0">
      <TabsList className="h-auto flex-wrap justify-start"><TabsTrigger value="overview">概况</TabsTrigger><TabsTrigger value="log">执行记录</TabsTrigger><TabsTrigger value="io">输入和结果</TabsTrigger><TabsTrigger value="agent">智能体</TabsTrigger><TabsTrigger value="decide">确认</TabsTrigger></TabsList>
      <TabsContent value="overview" className="space-y-3 rounded-lg border bg-card p-4">
        <h3 className="font-semibold">{names[step.step_key]}（{step.block_key}）· 第 {step.attempt} 次</h3>
        {step.status === "running" && <p>正在做：{step.progress_text ?? "处理中…"}</p>}
        {step.status === "pending" && <p className="text-muted-foreground">排队中，等待前面的步骤完成后自动执行。</p>}
        {step.summary && <p>结果摘要：{step.summary}</p>}
        {step.wait_reason && <div role="alert" className="rounded-md border border-warning bg-warning/10 p-3 text-sm">{WAIT_LABEL[step.wait_reason]}{step.wait_reason !== "model_not_configured" && `（已自动重试 ${step.retry_count} 次，最多 12 次）`}{step.wait_reason === "model_not_configured" && "：请管理员在「管理 → 模型」配置后点「重试」。不会自动重试，也不会生成内容。"}</div>}
        {step.error && step.status !== "waiting_model" && <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{step.error.message}{step.error.error_id && `（错误编号 ${step.error.error_id}）`}</div>}
        {step.skip_reason && <p className="text-sm text-muted-foreground">跳过原因：{step.skip_reason}</p>}
        <div className="flex flex-wrap gap-2">
          {["failed", "waiting_model"].includes(step.status) && <Button disabled={act.busy} onClick={() => act.run(() => retryStep(step.id), "已新建一次执行")}>重试</Button>}
          {isLead && ["pending", "failed", "waiting_model"].includes(step.status) && <SkipButton onSkip={(r) => act.run(() => skipStep(step.id, r), "已跳过")} />}
          {data.access.isAdmin && <Button variant="outline" disabled={act.busy} onClick={() => act.run(async () => {
            const result = await exportDiagnostics();
            const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
            const a = document.createElement("a");
            a.href = url; a.download = "sdf-diagnostics.json"; a.click();
            URL.revokeObjectURL(url);
          }, "诊断包已开始下载")}>导出诊断包</Button>}
        </div>
      </TabsContent>
      <TabsContent value="log" className="rounded-lg border bg-card p-4">
        <ol className="space-y-1 font-mono text-xs" aria-label="执行记录">{events.map((e) => <li key={e.id}><span className="text-muted-foreground">{new Date(e.ts).toLocaleTimeString("zh-CN")}</span> [{e.kind}] {e.message}</li>)}{!events.length && <li className="text-muted-foreground">暂无记录</li>}</ol>
      </TabsContent>
      <TabsContent value="io" className="space-y-4">
        {reqs.error && <p className="text-xs text-destructive">编号对照暂时没有读到。导出 Word 时会按需求库再对一次。</p>}
        {!arts.length && <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">本次执行还没有产出制品。</p>}
        {arts.map((a) => {
          const text = reqs.data && (a.type === "requirements" || a.type === "analysis") ? withRequirementLink(a.type, a.content, reqs.data) : a.content;
          const filename = `${a.title}.docx`.replace(/[\\/:*?"<>|]/g, "-");
          return (
          <article key={a.id} className="rounded-lg border bg-card p-4">
            <div className="mb-2 flex flex-wrap items-center gap-2"><h4 className="font-semibold">{a.title}</h4><Badge variant="outline">v{a.version}</Badge><Badge variant="outline">{a.status === "superseded" ? "已被替代" : a.status === "approved" ? "已审核" : a.status === "rejected" ? "已退回" : a.status === "draft" ? "草稿" : a.status}</Badge>{a.possibly_stale && <Badge variant="destructive">可能已过期</Badge>}{a.confidence !== null && <span className="text-xs text-muted-foreground">置信度 {a.confidence}</span>}<Button size="sm" variant="outline" className="ml-auto" onClick={() => downloadFile(`/artifacts/${a.id}/export.docx`, filename, "application/vnd.openxmlformats-officedocument.wordprocessingml.document").catch((e) => toast.error(e instanceof Error ? e.message : "下载失败"))}>导出 Word</Button></div>
            <p className="mb-2 text-xs text-muted-foreground">模型 {a.model || "未记录"}{a.reviewed_at ? ` · 审核于 ${new Date(a.reviewed_at).toLocaleString("zh-CN")}` : ""}{a.edit_ratio !== null && a.edit_ratio !== undefined ? ` · 修改比例 ${a.edit_ratio}` : ""}</p>
            {(data.llm_calls ?? []).some((call) => call.step_run_id && call.step_run_id === a.step_run_id) && <ul className="mb-2 space-y-1 font-mono text-xs text-muted-foreground">{(data.llm_calls ?? []).filter((call) => call.step_run_id === a.step_run_id).map((call) => <li key={call.id}>{call.model} {call.status} {call.total_tokens} tokens</li>)}</ul>}
            <Markdown text={text} />
          </article>
          );
        })}
      </TabsContent>
      <TabsContent value="agent" className="space-y-3 rounded-lg border bg-card p-4 text-sm">
        <dl className="grid gap-2 sm:grid-cols-4"><div><dt className="text-xs text-muted-foreground">智能体角色</dt><dd>{block?.agent_role ?? "—"}</dd></div><div><dt className="text-xs text-muted-foreground">任务档</dt><dd>{block?.task_tier ?? "—"}</dd></div><div><dt className="text-xs text-muted-foreground">模型调用</dt><dd>{step.model_calls} 次</dd></div><div><dt className="text-xs text-muted-foreground">Token</dt><dd>{step.tokens}</dd></div></dl>
        <p className="text-xs text-muted-foreground">系统提示词：运行时自动注入「智能体」中心对应角色的最新版本。模型由管理员在「管理 → 模型」按任务档配置。</p>
        {data.llm_calls && <details><summary className="cursor-pointer">本次运行的模型调用记录（仅管理员）</summary><ul className="mt-2 space-y-1 font-mono text-xs">{data.llm_calls.map((l) => <li key={l.id}>{new Date(l.created_at).toLocaleTimeString("zh-CN")} {l.model} {l.status} {l.duration_ms}ms {l.total_tokens} tokens{l.error_code ? ` ${l.error_code}` : ""}</li>)}</ul></details>}
      </TabsContent>
      <TabsContent value="decide" className="rounded-lg border bg-card p-4">
        {step.status !== "waiting_human" ? <p className="text-sm text-muted-foreground">{step.decision ? `已${step.decision === "approve" ? "通过" : "退回"}${step.decision_comment ? `：${step.decision_comment}` : ""}` : "此步骤当前不需要确认。"}</p>
          : canDecide ? <DecideForm step={step} steps={data.steps.filter((s) => s.is_current && s.seq <= step.seq && s.status !== "skipped")} names={names} act={act} />
          : <p className="text-sm text-muted-foreground">等待「{step.checkpoint?.role}」角色或负责人确认，您没有确认权限。</p>}
      </TabsContent>
    </Tabs>
  );
}

function SkipButton({ onSkip }: { onSkip: (reason: string) => void }) {
  const [open, setOpen] = useState(false); const [r, setR] = useState("");
  if (!open) return <Button variant="outline" onClick={() => setOpen(true)}>跳过</Button>;
  return <div className="flex gap-2"><Input aria-label="跳过原因" placeholder="跳过原因（必填）" value={r} onChange={(e) => setR(e.target.value)} /><Button disabled={r.trim().length < 2} onClick={() => onSkip(r.trim())}>确认跳过</Button></div>;
}

function DecideForm({ step, steps, names, act }: { step: StepRun; steps: StepRun[]; names: Record<string, string>; act: ReturnType<typeof useAct> }) {
  const [comment, setComment] = useState(""); const [goto, setGoto] = useState(steps[0]?.step_key ?? step.step_key);
  const [err, setErr] = useState<unknown>(null);
  const submit = (decision: "approve" | "reject") => act.run(async () => {
    setErr(null);
    try { await decideStep(step.id, { decision, comment: comment.trim() || null, goto: decision === "reject" ? goto : null }); } catch (e) { setErr(e); throw e; }
  }, decision === "approve" ? "已通过" : "已退回");
  return (
    <div className="space-y-3">
      {step.checkpoint?.prompt && <p className="text-sm">{step.checkpoint.prompt}</p>}
      <Textarea aria-label="确认意见" placeholder="意见（退回时必填）" value={comment} onChange={(e) => setComment(e.target.value)} />
      <ErrorBox error={err} />
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={act.busy} onClick={() => submit("approve")}>通过</Button>
        <span className="text-sm text-muted-foreground">或退回到</span>
        <Select value={goto} onValueChange={setGoto}><SelectTrigger className="w-40" aria-label="退回目标"><SelectValue /></SelectTrigger><SelectContent>{steps.map((s) => <SelectItem key={s.step_key} value={s.step_key}>{names[s.step_key] ?? s.step_key}</SelectItem>)}</SelectContent></Select>
        <Button variant="outline" disabled={act.busy || !comment.trim()} onClick={() => submit("reject")}>退回</Button>
      </div>
    </div>
  );
}
