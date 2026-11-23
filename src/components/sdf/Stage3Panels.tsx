import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/data/http";
import { Button } from "@/components/ui/button";

type Feedback = { id: string; code: string; title: string; status: string; category: string | null; triage_reason: string | null; requirement_code: string | null; released_in: string | null };
type Change = { id: string; code: string; title: string; status: string; business_summary: string };
type Uat = { id: string; ac_code: string; title: string; steps: string; result: string };

export function CollabPanel({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const feedback = useQuery({ queryKey: ["app", appId, "feedback"], queryFn: () => api<{ items: Feedback[] }>(`/apps/${appId}/feedback`) });
  const changes = useQuery({ queryKey: ["app", appId, "changes"], queryFn: () => api<{ items: Change[] }>(`/apps/${appId}/changes`) });
  const uat = useQuery({ queryKey: ["app", appId, "uat"], queryFn: () => api<{ items: Uat[] }>(`/apps/${appId}/uat`) });
  const decisions = useQuery({ queryKey: ["app", appId, "decisions"], queryFn: () => api<{ items: { code: string; title: string; body: string }[] }>(`/apps/${appId}/decisions`) });
  const [picked, setPicked] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const compare = useQuery({
    queryKey: ["app", appId, "baseline", from, to],
    enabled: Boolean(from && to),
    queryFn: () => api<{ explanation: string }>(`/apps/${appId}/baselines/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["app", appId] });
  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-card p-4">
        <h3 className="font-semibold">反馈池</h3>
        <ul className="mt-3 space-y-2 text-sm">
          {(feedback.data?.items ?? []).map((item) => (
            <li key={item.id} className="flex items-start gap-2">
              <input type="checkbox" checked={picked.includes(item.id)} onChange={(event) => setPicked(event.target.checked ? [...picked, item.id] : picked.filter((id) => id !== item.id))} />
              <div>
                <div className="font-medium">{item.code} {item.title}</div>
                <div className="text-muted-foreground">{item.category ?? "未分类"} · {item.triage_reason ?? item.status}{item.requirement_code ? ` · ${item.requirement_code}` : ""}{item.released_in ? ` · 已在 ${item.released_in} 上线` : ""}</div>
              </div>
            </li>
          ))}
        </ul>
        <Button className="mt-3" size="sm" disabled={!picked.length} onClick={async () => {
          const title = window.prompt("变更标题", "按反馈调整") ?? "";
          if (title.trim().length < 2) return;
          try { await api(`/apps/${appId}/changes`, { method: "POST", body: { title, feedback_ids: picked } }); setPicked([]); toast.success("已合并成变更"); await refresh(); }
          catch (error) { toast.error(error instanceof Error ? error.message : "不能合并"); }
        }}>合并为变更</Button>
      </section>
      <section className="rounded-lg border bg-card p-4 text-sm">
        <h3 className="font-semibold">变更</h3>
        {(changes.data?.items ?? []).map((item) => <p key={item.id} className="mt-2">{item.code} {item.title} · {item.status}</p>)}
      </section>
      <section className="rounded-lg border bg-card p-4 text-sm">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">验收</h3>
          <Button size="sm" variant="outline" onClick={async () => {
            try { const agenda = await api<{ markdown: string }>(`/apps/${appId}/agenda`); toast.message("会议议程已生成", { description: agenda.markdown.slice(0, 180) }); }
            catch (error) { toast.error(error instanceof Error ? error.message : "不能生成"); }
          }}>生成会议议程</Button>
        </div>
        {(uat.data?.items ?? []).map((item) => <p key={item.id} className="mt-2">{item.ac_code} {item.title} · {item.result}</p>)}
      </section>
      <section className="rounded-lg border bg-card p-4 text-sm">
        <h3 className="font-semibold">决策记录</h3>
        {(decisions.data?.items ?? []).map((item) => <p key={item.code} className="mt-2">{item.code} {item.title}：{item.body}</p>)}
      </section>
      <section className="rounded-lg border bg-card p-4 text-sm">
        <h3 className="font-semibold">版本对比</h3>
        <div className="mt-2 flex gap-2">
          <input className="rounded border px-2 py-1" placeholder="上一版，如 v1.0" value={from} onChange={(event) => setFrom(event.target.value)} />
          <input className="rounded border px-2 py-1" placeholder="这一版，如 v1.2" value={to} onChange={(event) => setTo(event.target.value)} />
        </div>
        {compare.data && <p className="mt-3">{compare.data.explanation}</p>}
      </section>
      <section className="rounded-lg border bg-card p-4 text-sm">
        <h3 className="font-semibold">评论里 @同事</h3>
        <form className="mt-2 space-y-2" onSubmit={async (event) => {
          event.preventDefault();
          const body = String(new FormData(event.currentTarget).get("body") ?? "");
          try {
            await api(`/apps/${appId}/comments`, { method: "POST", body: { body, target_kind: "app" } });
            event.currentTarget.reset();
            toast.success("已记下。被 @ 的同事会在待办里看到");
            await qc.invalidateQueries({ queryKey: ["inbox"] });
          } catch (error) { toast.error(error instanceof Error ? error.message : "不能保存评论"); }
        }}>
          <textarea className="min-h-20 w-full rounded border px-2 py-1" name="body" required placeholder="写一句说明，用 @邮箱 提到同事" />
          <Button size="sm" type="submit">发送</Button>
        </form>
      </section>
    </div>
  );
}

export function HookSwitches() {
  const qc = useQueryClient();
  const hooks = useQuery({ queryKey: ["hooks"], queryFn: () => api<{ items: { event_key: string; enabled: boolean; description: string }[] }>("/admin/hooks") });
  return (
    <ul className="space-y-3">
      {(hooks.data?.items ?? []).map((item) => (
        <li key={item.event_key} className="flex items-center justify-between rounded-lg border bg-card p-4 text-sm">
          <div><div className="font-medium">{item.description}</div><div className="text-muted-foreground">{item.event_key}</div></div>
          <Button size="sm" variant="outline" onClick={async () => {
            await api(`/admin/hooks/${item.event_key}`, { method: "PATCH", body: { enabled: !item.enabled } });
            await qc.invalidateQueries({ queryKey: ["hooks"] });
          }}>{item.enabled ? "已开启" : "已关闭"}</Button>
        </li>
      ))}
    </ul>
  );
}
