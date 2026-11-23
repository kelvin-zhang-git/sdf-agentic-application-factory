import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { artifactDiff } from "@/core/artifacts";
import {
  answerQuestion, applyAnswers, confirmRequirements, constitutionQuery, draftConstitution, editRequirement, findingsQuery, questionsQuery, reqVersionsQuery, requirementsQuery,
  returnRequirements, runAcceptance, saveConstitution, sealBaseline, setFindingStatus, sourceQuery, sourcesQuery, uploadSource, type Finding, type Requirement,
} from "@/data/runs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Markdown } from "./Markdown";
import { ErrorBox, errorText } from "./common";
import { downloadFile } from "@/data/download";
import { fillExternalRefs } from "@/data/oem";

const SEV: Record<string, string> = { blocker: "阻断", major: "重要", minor: "建议" };
const FST: Record<string, string> = { open: "待处理", resolved: "已解决", accepted_risk: "接受风险", stale: "已过期" };
const QST: Record<string, string> = { open: "待回答", answered: "已回答", applied: "已应用", stale: "已过期" };

export function RequirementsTab({ appId, canEdit, canSpec }: { appId: string; canEdit: boolean; canSpec: boolean }) {
  const [cite, setCite] = useState<string | null>(null);
  return (
    <>
      <Tabs defaultValue="sources">
        <TabsList className="h-auto flex-wrap justify-start"><TabsTrigger value="sources">原始资料</TabsTrigger><TabsTrigger value="reqs">需求和验收标准</TabsTrigger><TabsTrigger value="findings">分析问题</TabsTrigger><TabsTrigger value="questions">澄清问题</TabsTrigger><TabsTrigger value="spec">工程规范</TabsTrigger></TabsList>
        <TabsContent value="sources"><Sources appId={appId} canEdit={canEdit} /></TabsContent>
        <TabsContent value="reqs"><Requirements appId={appId} canEdit={canEdit} onCite={setCite} /></TabsContent>
        <TabsContent value="findings"><Findings appId={appId} canEdit={canEdit} /></TabsContent>
        <TabsContent value="questions"><Questions appId={appId} canEdit={canEdit} /></TabsContent>
        <TabsContent value="spec"><Constitution appId={appId} canEdit={canSpec} /></TabsContent>
      </Tabs>
      <CitationDialog segmentId={cite} appId={appId} onClose={() => setCite(null)} />
    </>
  );
}

function Sources({ appId, canEdit }: { appId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const { data } = useSuspenseQuery(sourcesQuery(appId));
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setErr(null); setBusy(true);
    const form = new FormData(e.currentTarget);
    const f = form.get("file"); if (f instanceof File && !f.size && !f.name) form.delete("file");
    try { const r = await uploadSource(appId, form); toast.success(`已导入 ${r.code}，共 ${r.segments} 段`); (e.target as HTMLFormElement).reset(); }
    catch (x) { setErr(x); } finally { setBusy(false); void qc.invalidateQueries({ queryKey: ["app", appId, "sources"] }); }
  };
  return (
    <div className="space-y-4">
      {canEdit && (
        <form onSubmit={submit} className="space-y-3 rounded-lg border bg-card p-4" aria-label="上传资料">
          <h3 className="font-semibold">上传资料</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1"><Label htmlFor="src-title">标题</Label><Input id="src-title" name="title" required maxLength={200} /></div>
            <div className="space-y-1"><Label htmlFor="src-date">会议日期</Label><Input id="src-date" name="meeting_date" type="date" /></div>
            <div className="space-y-1"><Label htmlFor="src-people">参与人（逗号分隔）</Label><Input id="src-people" name="participants" /></div>
          </div>
          <input type="hidden" name="kind" value="minutes" />
          <div className="space-y-1"><Label htmlFor="src-file">文件（txt、md、docx、pdf，不超过 10 MB）</Label><Input id="src-file" name="file" type="file" accept=".txt,.md,.docx,.pdf" /></div>
          <div className="space-y-1"><Label htmlFor="src-text">或粘贴文本（不超过 20 万字）</Label><Textarea id="src-text" name="text" rows={4} maxLength={200000} /></div>
          <ErrorBox error={err} />
          <Button type="submit" disabled={busy}>{busy ? "正在解析…" : "上传并解析"}</Button>
        </form>
      )}
      <ul className="space-y-2">
        {data.map((s) => (
          <li key={s.id} className="rounded-lg border bg-card p-3">
            <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 text-left" onClick={() => setOpen(open === s.id ? null : s.id)}>
              <span><span className="font-mono text-sm">{s.code}</span> {s.title}</span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">{s.source_segments[0]?.count ?? 0} 段 <Badge variant={s.parse_status === "failed" ? "destructive" : "outline"}>{s.parse_status === "parsed" ? "已解析" : s.parse_status === "failed" ? "解析失败" : "处理中"}</Badge></span>
            </button>
            {s.parse_error && <p className="mt-1 text-xs text-destructive">{s.parse_error}</p>}
            {open === s.id && <SourceSegments id={s.id} />}
          </li>
        ))}
        {!data.length && <li className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">还没有资料</li>}
      </ul>
    </div>
  );
}
function SourceSegments({ id }: { id: string }) {
  const q = useQuery(sourceQuery(id));
  if (!q.data) return <p className="mt-2 text-sm text-muted-foreground">加载中…</p>;
  return <ol className="mt-3 max-h-96 space-y-1 overflow-y-auto text-sm">{q.data.segments.map((g) => <li key={g.id}><span className="font-mono text-xs text-muted-foreground">#{g.seq}</span> {g.speaker && <strong>{g.speaker}：</strong>}{g.text}{g.tags?.topic && <Badge variant="outline" className="ml-2">{g.tags.topic}</Badge>}</li>)}</ol>;
}

function Requirements({ appId, canEdit, onCite }: { appId: string; canEdit: boolean; onCite: (id: string) => void }) {
  const { data } = useSuspenseQuery(requirementsQuery(appId));
  const qc = useQueryClient();
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const toggle = (id: string) => setPicked((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {canEdit && <Button size="sm" disabled={!picked.length} onClick={async () => {
          try { const saved = await confirmRequirements(appId, picked); toast.success(`已确认 ${saved.confirmed} 条需求`); setPicked([]); }
          catch (e) { setErr(e); } finally { void qc.invalidateQueries({ queryKey: ["app", appId, "requirements"] }); }
        }}>确认所选</Button>}
        {canEdit && <Button size="sm" variant="outline" disabled={!picked.length} onClick={async () => {
          const note = window.prompt("请填写退回原因");
          if (!note || note.trim().length < 2) return;
          try { const saved = await returnRequirements(appId, picked, note.trim()); toast.success(`已退回 ${saved.returned} 条需求`); setPicked([]); }
          catch (e) { setErr(e); } finally { void qc.invalidateQueries({ queryKey: ["app", appId, "requirements"] }); }
        }}>退回所选</Button>}
        {canEdit && <Button size="sm" variant="outline" onClick={async () => {
          try { const saved = await sealBaseline(appId); toast.success(`已生成基线 ${saved.version}`); }
          catch (e) { setErr(e); }
        }}>用已确认需求生成基线</Button>}
        <Button size="sm" variant="outline" onClick={async () => {
          try { await runAcceptance(appId); toast.success("验收测试已跑完，结果已写入交付检查"); }
          catch (e) { setErr(e); }
        }}>运行脚手架验收</Button>
        <Button size="sm" variant="outline" onClick={() => downloadFile(`/apps/${appId}/ai-usage?format=csv`, "ai-usage.csv", "text/csv").catch((e) => setErr(e))}>导出使用记录</Button>
        {canEdit && <Button size="sm" variant="outline" onClick={async () => {
          try { const saved = await fillExternalRefs(appId); toast.success(`已回填 ${saved.filled} 条甲方编号`); }
          catch (e) { setErr(e); } finally { void qc.invalidateQueries({ queryKey: ["app", appId, "requirements"] }); }
        }}>回填甲方编号</Button>}
      </div>
      <ErrorBox error={err} />
    <ul className="space-y-3">
      {data.map((r) => <RequirementCard key={r.id} r={r} canEdit={canEdit} onCite={onCite} appId={appId} picked={picked.includes(r.id)} onPick={() => toggle(r.id)} />)}
      {!data.length && <li className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">还没有需求，运行「仅需求」工作流后会在这里出现</li>}
    </ul>
    </div>
  );
}
function RequirementCard({ r, canEdit, onCite, appId, picked, onPick }: { r: Requirement; canEdit: boolean; onCite: (id: string) => void; appId: string; picked: boolean; onPick: () => void }) {
  const [mode, setMode] = useState<"none" | "history" | "edit">("none");
  return (
    <li className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">{canEdit && <input type="checkbox" aria-label={`选择 ${r.code}`} checked={picked} onChange={onPick} />}{r.status === "approved" && <Badge>已确认</Badge>}<span className="font-mono text-sm">{r.code}</span>{r.external_ref && <Badge variant="secondary">甲方 {r.external_ref}</Badge>}<h4 className="font-semibold">{r.title}</h4><Badge variant="outline">v{r.current_version}</Badge><Badge variant="outline">{r.priority}</Badge>{r.confidence !== null && <span className="text-xs text-muted-foreground">置信度 {r.confidence}</span>}{r.possibly_stale && <Badge variant="destructive">可能已过期</Badge>}</div>
      <p className="mt-2 text-sm">{r.story}</p>
      <ul className="mt-2 space-y-1 text-sm">{r.acceptance_criteria.map((a) => <li key={a.id}><Badge variant="secondary" className="mr-2">{a.format.toUpperCase()}</Badge>{a.text}</li>)}</ul>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs"><span className="text-muted-foreground">出处：</span>{r.citations.map((c) => <button key={c.segment_id} type="button" className="rounded border px-1.5 py-0.5 font-mono hover:bg-accent" onClick={() => onCite(c.segment_id)}>{c.source_code ?? "SRC"}#{c.seq ?? "?"}</button>)}</div>
      <div className="mt-3 flex gap-2"><Button size="sm" variant="outline" onClick={() => setMode(mode === "history" ? "none" : "history")}>版本历史</Button>{canEdit && <Button size="sm" variant="outline" onClick={() => setMode(mode === "edit" ? "none" : "edit")}>编辑</Button>}</div>
      {mode === "history" && <Versions id={r.id} />}
      {mode === "edit" && <EditRequirement r={r} appId={appId} onDone={() => setMode("none")} />}
    </li>
  );
}
function Versions({ id }: { id: string }) {
  const q = useQuery(reqVersionsQuery(id));
  const items = q.data ?? [];
  const text = (v: (typeof items)[number]) => `${v.snapshot.story ?? ""}\n${(v.snapshot.criteria ?? []).map((c) => `- ${c.text}`).join("\n")}`;
  return (
    <ol className="mt-3 space-y-2 text-sm">
      {items.map((v, i) => (
        <li key={v.id} className="rounded border p-2">
          <p className="text-xs text-muted-foreground">v{v.version} · {new Date(v.created_at).toLocaleString("zh-CN")} · {v.change_reason}</p>
          {i > 0 ? <pre className="mt-1 whitespace-pre-wrap font-mono text-xs">{artifactDiff(text(items[i - 1]!), text(v)).map((p, k) => <span key={k} className={p.kind === "added" ? "bg-success/20" : p.kind === "removed" ? "bg-destructive/20 line-through" : ""}>{p.text}</span>)}</pre> : <pre className="mt-1 whitespace-pre-wrap font-mono text-xs">{text(v)}</pre>}
        </li>
      ))}
    </ol>
  );
}
function EditRequirement({ r, appId, onDone }: { r: Requirement; appId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [story, setStory] = useState(r.story); const [crit, setCrit] = useState(r.acceptance_criteria.map((a) => a.text).join("\n")); const [reason, setReason] = useState("");
  const [err, setErr] = useState<unknown>(null);
  return (
    <div className="mt-3 space-y-2">
      <Label>描述</Label><Textarea value={story} onChange={(e) => setStory(e.target.value)} aria-label="需求描述" />
      <Label>验收标准（每行一条）</Label><Textarea value={crit} onChange={(e) => setCrit(e.target.value)} aria-label="验收标准" />
      <Input placeholder="修改原因（必填）" aria-label="修改原因" value={reason} onChange={(e) => setReason(e.target.value)} />
      <ErrorBox error={err} />
      <Button size="sm" disabled={reason.trim().length < 2} onClick={async () => {
        try { const v = await editRequirement(r.id, { story, criteria: crit.split("\n").map((t) => t.trim()).filter(Boolean).map((text) => ({ format: "gwt", text })), reason }); toast.success(`已保存为 v${v.version}`); onDone(); }
        catch (e) { setErr(e); } finally { void qc.invalidateQueries({ queryKey: ["app", appId] }); void qc.invalidateQueries({ queryKey: ["requirement", r.id] }); }
      }}>保存为新版本</Button>
    </div>
  );
}
function CitationDialog({ segmentId, appId, onClose }: { segmentId: string | null; appId: string; onClose: () => void }) {
  const sources = useQuery({ ...sourcesQuery(appId), enabled: !!segmentId });
  const details = useQuery({ queryKey: ["cite", segmentId], enabled: !!segmentId && !!sources.data, queryFn: async () => {
    for (const s of sources.data ?? []) { const d = await sourceQuery(s.id).queryFn!({} as never); const g = d.segments.find((x) => x.id === segmentId); if (g) return { source: d, seg: g }; }
    return null;
  } });
  return (
    <Dialog open={!!segmentId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>出处原文</DialogTitle></DialogHeader>
        {!details.data ? <p className="text-sm text-muted-foreground">加载中…</p> : (
          <div className="max-h-[60vh] space-y-1 overflow-y-auto text-sm"><p className="text-xs text-muted-foreground">{details.data.source.code} {details.data.source.title}</p>
            {details.data.source.segments.filter((g) => Math.abs(g.seq - details.data!.seg.seq) <= 2).map((g) => <p key={g.id} className={g.id === segmentId ? "rounded bg-warning/20 p-1" : ""}><span className="font-mono text-xs text-muted-foreground">#{g.seq}</span> {g.speaker && <strong>{g.speaker}：</strong>}{g.text}</p>)}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Findings({ appId, canEdit }: { appId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const { data } = useSuspenseQuery(findingsQuery(appId));
  const [sev, setSev] = useState("all"); const [showStale, setShowStale] = useState(false);
  const list = data.filter((f) => (sev === "all" || f.severity === sev) && (showStale || f.status !== "stale"));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2"><Select value={sev} onValueChange={setSev}><SelectTrigger className="w-32" aria-label="按级别筛选"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部级别</SelectItem><SelectItem value="blocker">阻断</SelectItem><SelectItem value="major">重要</SelectItem><SelectItem value="minor">建议</SelectItem></SelectContent></Select>
        <Button size="sm" variant="ghost" onClick={() => setShowStale(!showStale)}>{showStale ? "隐藏已过期" : "显示已过期"}</Button></div>
      <ul className="space-y-2">{list.map((f: Finding) => (
        <li key={f.id} className="rounded-lg border bg-card p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2"><span className="font-mono">{f.code}</span><Badge variant={f.severity === "blocker" ? "destructive" : "outline"}>{SEV[f.severity]}</Badge><Badge variant="outline">{FST[f.status] ?? f.status}</Badge><span className="text-xs text-muted-foreground">{f.rule_or_agent === "rule" ? "规则" : "智能体"} · {f.category}</span></div>
          <p className="mt-1">{f.description}</p>{f.suggestion && <p className="text-xs text-muted-foreground">建议：{f.suggestion}</p>}
          {canEdit && f.status !== "stale" && <div className="mt-2 flex gap-2">{(["resolved", "accepted_risk", "open"] as const).filter((s) => s !== f.status).map((s) => <Button key={s} size="sm" variant="outline" onClick={async () => { try { await setFindingStatus(f.id, s); toast.success("已更新"); } catch (e) { toast.error(errorText(e)); } void qc.invalidateQueries({ queryKey: ["app", appId, "findings"] }); }}>标为{FST[s]}</Button>)}</div>}
        </li>))}
        {!list.length && <li className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">没有分析问题</li>}
      </ul>
    </div>
  );
}

function Questions({ appId, canEdit }: { appId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const { data } = useSuspenseQuery(questionsQuery(appId));
  const live = data.filter((q) => q.status !== "stale");
  const groups = new Map<string, typeof live>();
  for (const q of live) groups.set(q.stakeholder, [...(groups.get(q.stakeholder) ?? []), q]);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-4">
      {canEdit && <Button disabled={busy || !live.some((q) => q.status === "answered")} onClick={async () => { setBusy(true); try { const r = await applyAnswers(appId); toast.success(`已更新 ${r.updated} 条需求（新版本），应用 ${r.applied} 个回答`); } catch (e) { toast.error(errorText(e)); } finally { setBusy(false); void qc.invalidateQueries({ queryKey: ["app", appId] }); } }}>{busy ? "正在更新…" : "根据回答更新需求"}</Button>}
      {[...groups].map(([who, qs]) => (
        <section key={who} className="space-y-2"><h4 className="font-semibold">{who}</h4>
          {qs.map((q) => <QuestionItem key={q.id} q={q} canEdit={canEdit} onSaved={() => qc.invalidateQueries({ queryKey: ["app", appId, "questions"] })} />)}
        </section>
      ))}
      {!live.length && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">没有澄清问题</p>}
    </div>
  );
}
function QuestionItem({ q, canEdit, onSaved }: { q: { id: string; code: string; question: string; answer: string | null; status: string; contacts: { name: string } | null }; canEdit: boolean; onSaved: () => void }) {
  const [a, setA] = useState(q.answer ?? "");
  return (
    <div className="rounded-lg border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2"><span className="font-mono">{q.code}</span><Badge variant="outline">{QST[q.status]}</Badge>{q.contacts && <span className="text-xs text-muted-foreground">提问对象：{q.contacts.name}</span>}</div>
      <p className="mt-1">{q.question}</p>
      {canEdit && q.status !== "applied" ? <div className="mt-2 flex gap-2"><Textarea aria-label={`${q.code} 回答`} value={a} maxLength={5000} onChange={(e) => setA(e.target.value)} placeholder="录入业务方回答" /><Button size="sm" disabled={!a.trim()} onClick={async () => { try { await answerQuestion(q.id, a); toast.success("回答已保存"); onSaved(); } catch (e) { toast.error(errorText(e)); } }}>保存</Button></div>
        : q.answer && <p className="mt-1 text-muted-foreground">答：{q.answer}</p>}
    </div>
  );
}

const SPEC_FIELDS: [string, string, boolean][] = [["stack", "技术栈", true], ["naming", "命名规范", true], ["security", "安全禁止项", true], ["performance", "性能等非功能要求", true], ["other", "其他", false]];
function Constitution({ appId, canEdit }: { appId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const { data } = useSuspenseQuery(constitutionQuery(appId));
  const latest = data[0];
  const [form, setForm] = useState<Record<string, string>>(latest?.content_json ?? {});
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3 rounded-lg border bg-card p-4">
        <h3 className="font-semibold">工程规范（B08）{latest && <Badge variant="outline" className="ml-2">当前 v{latest.version}</Badge>}</h3>
        {SPEC_FIELDS.map(([k, l, req]) => <div key={k} className="space-y-1"><Label htmlFor={`spec-${k}`}>{l}{req && " *"}</Label><Textarea id={`spec-${k}`} disabled={!canEdit} value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} rows={2} /></div>)}
        <ErrorBox error={err} />
        {canEdit && <div className="flex gap-2">
          <Button disabled={busy} onClick={async () => { setErr(null); setBusy(true); try { await saveConstitution(appId, form); toast.success("已保存为新版本"); } catch (e) { setErr(e); } finally { setBusy(false); void qc.invalidateQueries({ queryKey: ["app", appId, "constitution"] }); } }}>保存</Button>
          <Button variant="outline" disabled={busy} onClick={async () => { setBusy(true); try { const r = await draftConstitution(appId); setForm(r.draft); toast.success("智能体草稿已填入，请检查后保存"); } catch (e) { setErr(e); } finally { setBusy(false); } }}>智能体起草</Button>
        </div>}
      </div>
      <div className="space-y-2 rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between"><h3 className="font-semibold">CONSTITUTION.md 预览</h3>{latest && <Button size="sm" variant="outline" onClick={() => { const u = URL.createObjectURL(new Blob([latest.content], { type: "text/markdown" })); const a = document.createElement("a"); a.href = u; a.download = "CONSTITUTION.md"; a.click(); URL.revokeObjectURL(u); }}>导出</Button>}</div>
        {latest ? <Markdown text={latest.content} /> : <p className="text-sm text-muted-foreground">尚未保存</p>}
      </div>
    </div>
  );
}
