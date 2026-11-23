import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/data/http";
import { downloadFile } from "@/data/download";
import { Button } from "@/components/ui/button";

const STATUSES = ["todo", "doing", "review", "blocked", "done"] as const;
const STATUS_LABEL: Record<(typeof STATUSES)[number], string> = { todo: "待办", doing: "进行中", review: "待复核", blocked: "受阻", done: "完成" };

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="space-y-3 rounded-lg border bg-card p-5"><h3 className="font-semibold">{title}</h3>{children}</section>;
}

export function DesignPanel({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const model = useQuery({ queryKey: ["app", appId, "data-model"], queryFn: () => api<{ item: { version: number; content: string } | null }>(`/apps/${appId}/data-model`) });
  const proto = useQuery({ queryKey: ["app", appId, "prototype"], queryFn: () => api<{ item: { version: number; content: string; content_json: { anchors?: string[] } | null } | null; comments: { id: string; anchor: string; body: string; resolved: boolean }[] }>(`/apps/${appId}/prototype`) });
  const [anchor, setAnchor] = useState("");
  const [body, setBody] = useState("");
  const html = proto.data?.item?.content ?? "";
  return (
    <div className="space-y-6">
      <Panel title="数据模型">
        {model.data?.item ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">{model.data.item.content}</pre> : <p className="text-sm text-muted-foreground">运行「新建小型应用」后，这里会出现可执行的 schema.sql。</p>}
        {model.data?.item && <Button size="sm" variant="outline" onClick={() => downloadFile(`/apps/${appId}/data-model/schema.sql`, "schema.sql", "text/plain").catch((e) => toast.error(e.message))}>下载 schema.sql</Button>}
      </Panel>
      <Panel title="接口说明">
        <Button size="sm" variant="outline" onClick={() => downloadFile(`/apps/${appId}/openapi.yaml`, "openapi.yaml", "application/yaml").catch((e) => toast.error(e.message))}>下载 openapi.yaml</Button>
      </Panel>
      <Panel title="可交互原型">
        {html ? <iframe title="原型" sandbox="allow-scripts" srcDoc={html} className="h-[32rem] w-full rounded border bg-white" /> : <p className="text-sm text-muted-foreground">原型生成后会显示在这里。页面只允许脚本，不允许同源访问。</p>}
        <form className="flex flex-wrap gap-2" onSubmit={async (event) => {
          event.preventDefault();
          try {
            await api(`/apps/${appId}/prototype/comments`, { method: "POST", body: { anchor, body } });
            setBody(""); toast.success("留言已记下");
            await qc.invalidateQueries({ queryKey: ["app", appId, "prototype"] });
          } catch (error) { toast.error(error instanceof Error ? error.message : "留言失败"); }
        }}>
          <input className="h-9 rounded border px-2 text-sm" placeholder="锚点，例如 order-list" value={anchor} onChange={(e) => setAnchor(e.target.value)} />
          <input className="h-9 min-w-64 flex-1 rounded border px-2 text-sm" placeholder="要改什么" value={body} onChange={(e) => setBody(e.target.value)} />
          <Button size="sm" type="submit">留言</Button>
          <Button size="sm" type="button" variant="outline" onClick={async () => {
            try { await api(`/apps/${appId}/prototype/revise`, { method: "POST" }); toast.success("已生成新版本"); await qc.invalidateQueries({ queryKey: ["app", appId, "prototype"] }); }
            catch (error) { toast.error(error instanceof Error ? error.message : "修订失败"); }
          }}>按留言生成下一版</Button>
        </form>
        <ul className="space-y-1 text-sm">{(proto.data?.comments ?? []).map((c) => <li key={c.id}><span className="text-muted-foreground">{c.anchor}</span> {c.body}</li>)}</ul>
      </Panel>
    </div>
  );
}

export function DevPanel({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const tasks = useQuery({ queryKey: ["app", appId, "tasks"], queryFn: () => api<{ items: { id: string; code: string; title: string; status: typeof STATUSES[number]; assignee_kind: string; allowed_paths: string[] }[] }>(`/apps/${appId}/tasks`) });
  const [open, setOpen] = useState<string | null>(null);
  const pack = useQuery({ queryKey: ["app", appId, "context", open], enabled: Boolean(open), queryFn: () => api<{ content: string }>(`/apps/${appId}/tasks/${open}/context`) });
  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-5">
        {STATUSES.map((status) => (
          <section key={status} className="space-y-2 rounded-lg border bg-card p-3">
            <h3 className="text-sm font-semibold">{STATUS_LABEL[status]}</h3>
            {(tasks.data?.items ?? []).filter((task) => task.status === status).map((task) => (
              <button key={task.id} className="block w-full rounded border bg-background p-2 text-left text-sm" onClick={() => setOpen(task.code)}>
                <div className="font-medium">{task.code}</div>
                <div>{task.title}</div>
                <div className="text-xs text-muted-foreground">{task.assignee_kind === "agent" ? "智能体" : "人"}</div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {STATUSES.filter((next) => next !== task.status).map((next) => (
                    <span key={next} className="rounded bg-muted px-1 text-xs" onClick={async (event) => {
                      event.stopPropagation();
                      try { await api(`/tasks/${task.id}`, { method: "PATCH", body: { status: next } }); await qc.invalidateQueries({ queryKey: ["app", appId, "tasks"] }); }
                      catch (error) { toast.error(error instanceof Error ? error.message : "不能改状态"); }
                    }}>{STATUS_LABEL[next]}</span>
                  ))}
                </div>
              </button>
            ))}
          </section>
        ))}
      </div>
      {open && <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded border bg-card p-4 text-xs">{pack.data?.content ?? "正在读取上下文包"}</pre>}
      <ConnectorBar appId={appId} />
    </div>
  );
}

export function QualityPanel({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const cases = useQuery({ queryKey: ["app", appId, "cases"], queryFn: () => api<{ items: { id: string; code: string; ac_code: string; kind: string; title: string; preconditions: string; steps: string[]; expected: string }[]; gaps: { ac_code: string; missing: string[] }[]; document: { id: string; title: string } | null }>(`/apps/${appId}/test-cases`) });
  const kindLabel: Record<string, string> = { normal: "正常", exception: "例外", boundary: "边界" };
  const publish = async () => {
    const saved = await api<{ cases: number; artifact_id: string }>(`/apps/${appId}/test-design/publish`, { method: "POST" });
    toast.success(`已写入 ${saved.cases} 条测试用例`);
    await qc.invalidateQueries({ queryKey: ["app", appId, "cases"] });
    return saved.artifact_id;
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">{cases.data?.gaps.length ? `${cases.data.gaps.length} 条验收标准还缺正常或例外用例` : "每条验收标准都应有正常用例和例外或边界用例"}</p>
        <Button size="sm" variant="outline" onClick={() => publish().catch((error) => toast.error(error instanceof Error ? error.message : "生成失败"))}>生成测试用例文档</Button>
        {cases.data?.document && <Button size="sm" variant="outline" onClick={() => downloadFile(`/artifacts/${cases.data?.document?.id}/export.docx`, "测试用例.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document").catch((error) => toast.error(error instanceof Error ? error.message : "下载失败"))}>导出 Word</Button>}
      </div>
      {!cases.data?.items.length && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">还没有测试用例。点「生成测试用例文档」后，会补齐每条验收标准的正常路径和例外路径，并出现在测试设计这一步的结果里。</p>}
      <div className="overflow-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left"><tr><th className="p-2">用例</th><th className="p-2">验收标准</th><th className="p-2">类型</th><th className="p-2">标题</th><th className="p-2">步骤</th><th className="p-2">期望</th></tr></thead>
          <tbody>{(cases.data?.items ?? []).map((item) => <tr key={item.id} className="border-t align-top"><td className="p-2">{item.code}</td><td className="p-2">{item.ac_code}</td><td className="p-2">{kindLabel[item.kind] ?? item.kind}</td><td className="p-2">{item.title}{item.preconditions ? <div className="text-xs text-muted-foreground">前置：{item.preconditions}</div> : null}</td><td className="p-2">{item.steps.join("；")}</td><td className="p-2">{item.expected}</td></tr>)}</tbody>
        </table>
      </div>
      <GateBar appId={appId} />
    </div>
  );
}

function ConnectorBar({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const links = useQuery({ queryKey: ["app", appId, "connectors"], queryFn: () => api<{ items: { connector_id: string; name: string; vendor: string; status: string; last_error: string | null }[] }>(`/apps/${appId}/connectors`) });
  const merges = useQuery({ queryKey: ["app", appId, "merge-requests"], queryFn: () => api<{ items: { id: string; title: string; state: string; task_code: string | null; url: string | null }[] }>(`/apps/${appId}/merge-requests`) });
  const repo = (links.data?.items ?? []).find((item) => item.vendor);
  return (
    <section className="space-y-4 rounded-lg border bg-card p-4 text-sm">
      <div>
        <h3 className="font-semibold">代码仓</h3>
        <p className="mt-1 text-muted-foreground">{repo ? `${repo.name}（${repo.vendor}）当前${repo.status === "success" ? "可以连接" : repo.status === "error" ? "连接失败" : "还没测试"}` : "还没有绑定代码仓。到应用设置或连接器页面保存地址和令牌。"}</p>
        {repo?.last_error && <p className="mt-1 text-destructive">{repo.last_error}</p>}
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="outline" disabled={!repo} onClick={async () => {
            try { await api(`/connectors/${repo?.connector_id}/test`, { method: "POST" }); toast.success("连接通过"); await qc.invalidateQueries({ queryKey: ["app", appId, "connectors"] }); }
            catch (error) { toast.error(error instanceof Error ? error.message : "连接失败"); }
          }}>测试连接</Button>
          <Button size="sm" variant="outline" onClick={async () => {
            try {
              const result = await api<{ count: number }>(`/apps/${appId}/merge-requests/sync`, { method: "POST" });
              toast.success(`已同步 ${result.count} 个合并请求`);
              await qc.invalidateQueries({ queryKey: ["app", appId, "merge-requests"] });
            }
            catch (error) { toast.error(error instanceof Error ? error.message : "同步失败"); }
          }}>立即同步</Button>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">合并请求</h3>
        <ul className="mt-2 space-y-2">
          {(merges.data?.items ?? []).map((item) => (
            <li key={item.id} className="rounded border p-2">
              <div className="flex flex-wrap items-center gap-2">{item.title || "未命名"} · {item.state}{item.task_code ? ` · 已对应 ${item.task_code}` : " · 未认领"}
                {item.task_code && <Button size="sm" variant="outline" onClick={async () => {
                  try {
                    const result = await api<{ tests: number; findings: number }>(`/apps/${appId}/merge-requests/${item.id}/accept`, { method: "POST" });
                    toast.success(`隔离验收完成，测试 ${result.tests} 条，扫描发现 ${result.findings} 条`);
                  } catch (error) { toast.error(error instanceof Error ? error.message : "隔离验收失败"); }
                }}>隔离验收</Button>}
              </div>
              {!item.task_code && (
                <form className="mt-2 flex gap-2" onSubmit={async (event) => {
                  event.preventDefault();
                  const code = String(new FormData(event.currentTarget).get("task_code") ?? "").trim();
                  try {
                    await api(`/apps/${appId}/merge-requests/${item.id}/bind`, { method: "POST", body: { task_code: code } });
                    toast.success(`已认领到 ${code}`);
                    await qc.invalidateQueries({ queryKey: ["app", appId, "merge-requests"] });
                  } catch (error) { toast.error(error instanceof Error ? error.message : "认领失败"); }
                }}>
                  <input className="h-8 rounded border px-2" name="task_code" required pattern="T-\d+" placeholder="T-0001" />
                  <Button size="sm" type="submit">认领</Button>
                </form>
              )}
            </li>
          ))}
          {!merges.data?.items.length && <li className="text-muted-foreground">还没有合并请求。同步之后，对不上任务的可以在这里按编号认领。</li>}
        </ul>
      </div>
    </section>
  );
}

function GateBar({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const gates = useQuery({ queryKey: ["app", appId, "gates"], queryFn: () => api<{ items: { item_key: string; status: string; evidence: string; numerator: number | null; denominator: number | null; waiver_reason: string | null }[] }>(`/apps/${appId}/gates`) });
  const labels: Record<string, string> = { ac_coverage: "验收标准覆盖", test_pass_rate: "测试通过率", sarif_high: "高危漏洞", out_of_scope: "超范围修改" };
  const statusLabel: Record<string, string> = { PASSED: "通过", FAILED: "未通过", NOT_EXECUTED: "未执行" };
  const latest: { item_key: string; status: string; evidence: string; numerator: number | null; denominator: number | null; waiver_reason: string | null }[] = [];
  const seen = new Set<string>();
  for (const item of gates.data?.items ?? []) {
    if (seen.has(item.item_key)) continue;
    seen.add(item.item_key);
    latest.push(item);
  }
  return (
    <section className="rounded-lg border bg-card p-4 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">交付检查</h3>
        <Button size="sm" variant="outline" onClick={async () => {
          try { await api(`/apps/${appId}/gates/run`, { method: "POST" }); await qc.invalidateQueries({ queryKey: ["app", appId, "gates"] }); }
          catch (error) { toast.error(error instanceof Error ? error.message : "不能计算"); }
        }}>重新计算</Button>
      </div>
      <p className="mt-1 text-muted-foreground">没有报告或分母为 0 时，该项是未执行，不能当成通过。例外放行会留下原因，不把结果改成通过。</p>
      <ul className="mt-3 space-y-3">
        {latest.map((item) => (
          <li key={item.item_key}>
            <div>{labels[item.item_key] ?? item.item_key}：{item.waiver_reason ? "已例外放行" : (statusLabel[item.status] ?? item.status)} {item.numerator != null && item.denominator != null ? `（${item.numerator}/${item.denominator}）` : ""}</div>
            <div className="text-muted-foreground">{item.evidence}</div>
            {item.waiver_reason && <div>放行原因：{item.waiver_reason}</div>}
            {item.status !== "PASSED" && !item.waiver_reason && (
              <form className="mt-1 flex gap-2" onSubmit={async (event) => {
                event.preventDefault();
                const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
                try {
                  await api(`/apps/${appId}/gates/waive`, { method: "POST", body: { item_key: item.item_key, reason } });
                  toast.success("已例外放行");
                  await qc.invalidateQueries({ queryKey: ["app", appId, "gates"] });
                } catch (error) { toast.error(error instanceof Error ? error.message : "不能放行"); }
              }}>
                <input className="h-8 min-w-48 flex-1 rounded border px-2" name="reason" required minLength={2} placeholder="为什么这次可以例外" />
                <Button size="sm" type="submit">例外放行</Button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DocsPanel({ appId }: { appId: string }) {
  const docs = useQuery({ queryKey: ["app", appId, "docs"], queryFn: () => api<{ items: { id: string; type: string; title: string; version: number }[] }>(`/apps/${appId}/documents`) });
  return (
    <div className="space-y-3">
      {(docs.data?.items ?? []).map((doc) => (
        <div key={doc.id} className="flex items-center justify-between rounded-lg border bg-card p-4">
          <div><div className="font-medium">{doc.title}</div><div className="text-xs text-muted-foreground">第 {doc.version} 版</div></div>
          <Button size="sm" variant="outline" onClick={() => downloadFile(`/artifacts/${doc.id}/export.docx`, `${doc.type}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document").catch((e) => toast.error(e.message))}>下载 Word</Button>
        </div>
      ))}
      {!docs.data?.items.length && <p className="text-sm text-muted-foreground">文档由工作流里的文档步骤生成，表格在导出时写入 Word。</p>}
    </div>
  );
}
