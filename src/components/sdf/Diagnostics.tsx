import { Component, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Download, RefreshCw } from "lucide-react";
import { exportDiagnostics, healthQuery, logsQuery, reportClientError } from "@/data/diagnostics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorBox, errorText, Mono, PageHeader } from "./common";

export function Diagnostics() {
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const q = useQuery(logsQuery(search));
  const rows = [...(q.data?.app_logs ?? []), ...(q.data?.client_errors ?? [])].sort((a,b) => b.created_at.localeCompare(a.created_at));
  return <div className="min-w-0 space-y-5">
    <div className="flex flex-wrap gap-3">
      <Input className="max-w-xs" aria-label="错误编号" placeholder="错误编号" value={input} onChange={(e) => setInput(e.target.value)} />
      <Button onClick={() => setSearch(input.trim())}>查找</Button>
      <Button variant="outline" aria-label="刷新日志" onClick={() => q.refetch()}><RefreshCw className="size-4" /></Button>
      <Button variant="outline" onClick={async () => { try {
        const result = await exportDiagnostics(); const url = URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:"application/json"}));
        const a = document.createElement("a"); a.href = url; a.download = "sdf-diagnostics.json"; a.click(); URL.revokeObjectURL(url);
      } catch (e) { toast.error(errorText(e)); } }}><Download className="mr-2 size-4" />导出诊断包</Button>
      <Link to="/admin/health" className="self-center text-sm text-primary underline">自检</Link>
    </div>
    <ErrorBox error={q.error} />
    <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>时间</TableHead><TableHead>代码</TableHead><TableHead>请求</TableHead><TableHead>错误编号</TableHead><TableHead>追踪编号</TableHead></TableRow></TableHeader><TableBody>
      {rows.map((row) => <TableRow key={row.id}><TableCell className="whitespace-nowrap">{new Date(row.created_at).toLocaleString()}</TableCell><TableCell>{row.code}</TableCell><TableCell>{row.path}</TableCell><TableCell><Mono>{row.error_id ?? "—"}</Mono></TableCell><TableCell><Mono>{row.trace_id}</Mono></TableCell></TableRow>)}
    </TableBody></Table></div>
    {!rows.length && <p className="text-sm text-muted-foreground">暂无匹配记录</p>}
    <h3 className="font-semibold">关联模型调用</h3>
    {q.data?.llm_calls.map((call) => <div key={call.id} className="flex flex-wrap gap-3 border-b py-2 text-sm"><span>{call.model}</span><span>{call.status}</span><span>{call.total_tokens} Token</span><Mono>{call.trace_id}</Mono></div>)}
  </div>;
}

class SelfCheckBoundary extends Component<{ children: ReactNode; onReset: () => void }, { failed: boolean; errorId: string }> {
  override state = { failed: false, errorId: "" };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch() { void reportClientError("RENDER_ERROR").then((r) => this.setState({ errorId: r.error_id })).catch(() => this.setState({ errorId: "错误报告暂未送达" })); }
  override render() { return this.state.failed ? <div role="alert" className="space-y-3 border border-destructive p-4"><p>页面出错，其他页面仍可使用。</p><Mono>{this.state.errorId || "正在记录错误…"}</Mono><Button variant="outline" onClick={this.props.onReset}>恢复</Button></div> : this.props.children; }
}
function IntentionalError(): ReactNode { throw new Error("SDF controlled self-check"); }
export function HealthCheck() {
  const q = useQuery(healthQuery()); const [crash,setCrash] = useState(false); const [generation,setGeneration] = useState(0);
  return <div className="space-y-5"><PageHeader title="系统自检" /><ErrorBox error={q.error} />
    <Button variant="outline" onClick={() => q.refetch()}><RefreshCw className="mr-2 size-4" />重新检查</Button>
    {q.data?.checks.map((check) => <div key={check.name} className="flex justify-between gap-4 border-b py-3 text-sm"><span>{check.name}</span><span className={check.status === "failed" ? "text-destructive" : "text-muted-foreground"}>{check.status === "passed" ? "通过" : check.status === "failed" ? "失败" : "尚未实施"}</span></div>)}
    <SelfCheckBoundary key={generation} onReset={() => {setCrash(false);setGeneration((v) => v+1);}}>{crash ? <IntentionalError /> : <Button variant="destructive" onClick={() => setCrash(true)}>制造渲染错误</Button>}</SelfCheckBoundary>
    <Link to="/admin" className="block text-sm text-primary underline">返回管理</Link>
  </div>;
}