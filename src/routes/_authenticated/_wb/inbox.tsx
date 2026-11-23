import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { inboxQuery } from "@/data/runs";
import { api } from "@/data/http";
import { useLiveRun } from "@/hooks/use-live-run";
import { PageHeader } from "@/components/sdf/common";
import { since } from "@/components/sdf/StepBar";
import { LiveNote } from "@/components/sdf/LiveNote";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/_wb/inbox")({
  head: () => ({ meta: [
    { title: "我的待办 · SDF 智能应用工厂" },
    { name: "description", content: "待确认步骤、反馈、变更、验收和未读通知" },
    { property: "og:title", content: "我的待办 · SDF 智能应用工厂" },
    { property: "og:description", content: "待确认步骤、反馈、变更、验收和未读通知" },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  loader: ({ context }) => context.queryClient.ensureQueryData(inboxQuery()),
  component: Inbox,
});

const INBOX_KEY = ["inbox"];
function Inbox() {
  useLiveRun(INBOX_KEY);
  const qc = useQueryClient();
  const { data } = useSuspenseQuery(inboxQuery());
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="GOVERNANCE INBOX" title="我的待办" desc="需要人工拍板的确认点步骤、变更请求、业务反馈、验收项与未读通知" actions={<LiveNote />} />

      <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border grid-cols-2 sm:grid-cols-5">
        {[
          ["待确认步骤", data.items.length],
          ["待确认变更", data.changes.length],
          ["待处理反馈", data.feedback.length],
          ["待验收项", data.uat.length],
          ["未读通知", data.notices.length],
        ].map(([label, count]) => (
          <div key={String(label)} className="bg-panel px-4 py-3">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-1 text-lg font-semibold text-foreground tabular-nums">{count}</div>
          </div>
        ))}
      </div>

      <section className="space-y-2.5">
        <h2 className="text-sm font-semibold text-foreground">待确认步骤（{data.items.length}）</h2>
        <ul className="space-y-2">
          {data.items.map((step) => (
            <li key={step.id}>
              <Link to="/apps/$appId/runs/$runId" params={{ appId: step.app_id, runId: step.run_id }} className="panel-surface flex flex-wrap items-center justify-between gap-2 rounded-md p-3.5 text-sm transition-colors hover:border-primary/50">
                <span><strong>{step.apps?.name}</strong> · <span className="font-mono text-xs">{step.workflow_runs?.code}</span> · {step.workflow_runs?.workflows?.name} · 步骤 {step.step_key}（{step.block_key}）</span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground"><Badge variant="outline">确认·{step.checkpoint?.role ?? "lead"}</Badge>已等待 {since(step.created_at)}</span>
              </Link>
            </li>
          ))}
          {!data.items.length && <li className="panel-surface rounded-md border-dashed p-6 text-center text-sm text-muted-foreground">暂时没有需要您确认的步骤</li>}
        </ul>
      </section>
      <WorkList title="待确认变更" empty="没有等您确认的变更" rows={data.changes.map((row) => ({ id: row.id, appId: row.app_id, text: `${row.app_name} · ${row.code} · ${row.title}` }))} />
      <WorkList title="待处理反馈" empty="没有待分类或待处理的反馈" rows={data.feedback.map((row) => ({ id: row.id, appId: row.app_id, text: `${row.app_name} · ${row.code} · ${row.title}` }))} />
      <WorkList title="待验收" empty="没有未完成的验收项" rows={data.uat.map((row) => ({ id: row.id, appId: row.app_id, text: `${row.app_name} · ${row.ac_code} · ${row.title}` }))} />
      <WorkList title="@我的评论" empty="没有人在评论里 @ 你" rows={data.mentions.map((row) => ({ id: row.id, appId: row.app_id, text: `${row.app_name} · ${row.body}` }))} />
      <section className="space-y-2.5">
        <h2 className="text-sm font-semibold text-foreground">未读通知（{data.notices.length}）</h2>
        <ul className="space-y-2">
          {data.notices.map((notice) => (
            <li key={notice.id} className="panel-surface flex flex-wrap items-center justify-between gap-2 rounded-md p-3.5 text-sm">
              <span><strong>{notice.title}</strong> {notice.body}</span>
              <div className="flex items-center gap-2">
                {notice.app_id && (
                  <Button asChild size="sm" variant="outline">
                    <Link to="/apps/$appId" params={{ appId: notice.app_id }}>前往应用</Link>
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={async () => {
                  try { await api(`/notifications/${notice.id}/read`, { method: "POST" }); await qc.invalidateQueries({ queryKey: INBOX_KEY }); }
                  catch (error) { toast.error(error instanceof Error ? error.message : "不能标成已读"); }
                }}>标为已读</Button>
              </div>
            </li>
          ))}
          {!data.notices.length && <li className="panel-surface rounded-md border-dashed p-6 text-center text-sm text-muted-foreground">没有未读通知</li>}
        </ul>
      </section>
    </div>
  );
}

function WorkList({ title, empty, rows }: { title: string; empty: string; rows: { id: string; appId: string; text: string }[] }) {
  return (
    <section className="space-y-2.5">
      <h2 className="text-sm font-semibold text-foreground">{title}（{rows.length}）</h2>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.id}>
            <Link to="/apps/$appId" params={{ appId: row.appId }} className="panel-surface block rounded-md p-3.5 text-sm transition-colors hover:border-primary/50">{row.text}</Link>
          </li>
        ))}
        {!rows.length && <li className="panel-surface rounded-md border-dashed p-6 text-center text-sm text-muted-foreground">{empty}</li>}
      </ul>
    </section>
  );
}
