import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { appsQuery, meQuery, releasesQuery } from "@/data/sdf";
import { api } from "@/data/http";
import { setViewMode } from "@/data/view";
import { signOut } from "@/data/auth";
import { KyndrylLogo, ThemeSwitcher } from "@/components/sdf/KyndrylBrand";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/portal")({
  head: () => ({ meta: [
    { title: "业务门户 · SDF 智能应用工厂" },
    { name: "description", content: "查看参与的应用、提交反馈、确认变更和验收" },
    { property: "og:title", content: "业务门户 · SDF 智能应用工厂" },
    { property: "og:description", content: "查看参与的应用、提交反馈、确认变更和验收" },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  loader: ({ context }) => context.queryClient.ensureQueryData(meQuery()),
  component: Portal,
});

const PAGES = ["我的应用", "看原型", "提反馈", "等我确认", "验收任务", "我的反馈", "决策记录"] as const;

function Portal() {
  const { data: me } = useSuspenseQuery(meQuery());
  const apps = useQuery(appsQuery());
  const nav = useNavigate();
  const [page, setPage] = useState<(typeof PAGES)[number]>("我的应用");
  const [appId, setAppId] = useState("");
  const current = appId || apps.data?.[0]?.id || "";
  return (
    <div className="min-h-[100dvh] bg-portal">
      <header className="border-b border-border bg-panel">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="flex items-center gap-3">
            <KyndrylLogo className="h-[20px] w-auto" />
            <span className="h-4 w-px bg-border" aria-hidden />
            <div className="font-semibold text-foreground">业务门户</div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{me.profile?.display_name}</span>
            <ThemeSwitcher compact />
            {!me.business_only && (
              <Button size="sm" variant="outline" onClick={() => { setViewMode("workbench"); nav({ to: "/apps" }); }}>返回工作台</Button>
            )}
            <Button size="sm" variant="ghost" onClick={async () => { await signOut(); nav({ to: "/auth" }); }}>退出</Button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-5xl flex-wrap gap-1 border-t border-border/60 px-6 py-2" aria-label="门户导航">
          {PAGES.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setPage(item)}
              className={
                page === item
                  ? "rounded-sm bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary transition-colors"
                  : "rounded-sm px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              }
            >
              {item}
            </button>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        {(apps.data ?? []).length > 1 && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">当前应用：</span>
            <select className="h-9 rounded-md border border-input bg-panel px-3 text-sm" value={current} onChange={(event) => setAppId(event.target.value)}>
              {(apps.data ?? []).map((app) => <option key={app.id} value={app.id}>{app.name}</option>)}
            </select>
          </div>
        )}
        {page === "我的应用" && <MyApps apps={apps.data ?? []} onOpen={(id) => { setAppId(id); setPage("看原型"); }} />}
        {page === "看原型" && current && <Prototype appId={current} />}
        {page === "提反馈" && current && <FeedbackForm appId={current} />}
        {page === "等我确认" && current && <ConfirmList appId={current} />}
        {page === "验收任务" && current && <UatList appId={current} />}
        {page === "我的反馈" && current && <MyFeedback appId={current} />}
        {page === "决策记录" && current && <Decisions appId={current} />}
        {!current && page !== "我的应用" && <p className="text-sm text-muted-foreground">您还没有被加入任何应用。</p>}
      </main>
    </div>
  );
}

function MyApps({ apps, onOpen }: { apps: { id: string; name: string; description?: string | null; current_version?: string | null }[]; onOpen: (id: string) => void }) {
  return (
    <div className="space-y-3">
      {apps.map((app) => <AppCard key={app.id} app={app} onOpen={() => onOpen(app.id)} />)}
      {!apps.length && <p className="text-sm text-muted-foreground">您还没有被加入任何应用。</p>}
    </div>
  );
}

function AppCard({ app, onOpen }: { app: { id: string; name: string; description?: string | null; current_version?: string | null }; onOpen: () => void }) {
  // 复用统一的 releasesQuery，确保与工作台共享 ["app", app.id, "releases"] 缓存时返回结构一致（均为数组）
  const notes = useQuery(releasesQuery(app.id));
  const latest = notes.data?.[0];
  return (
    <section className="panel-surface rounded-md p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-foreground">{app.name}</h3>
        <span className="rounded-xs border border-border bg-muted/60 px-2 py-0.5 font-mono text-xs text-muted-foreground">
          {app.current_version ?? "尚未上线"}
        </span>
      </div>
      <p className="mt-1.5 text-sm text-muted-foreground">{app.description}</p>
      {latest && <p className="mt-3 rounded-sm bg-muted/50 px-3 py-2 text-sm text-foreground">这一版改了什么：{latest.notes_business}</p>}
      <Button className="mt-4" size="sm" variant="outline" onClick={onOpen}>看原型</Button>
    </section>
  );
}

function Prototype({ appId }: { appId: string }) {
  const data = useQuery({ queryKey: ["app", appId, "prototype"], queryFn: () => api<{ item: { content: string } | null }>(`/apps/${appId}/prototype`) });
  const html = data.data?.item?.content ?? "";
  if (!html) return <p className="text-sm text-muted-foreground">还没有可以点的原型。</p>;
  return <iframe title="原型" sandbox="allow-scripts" className="panel-surface h-[34rem] w-full rounded-md bg-white" srcDoc={html} />;
}

function FeedbackForm({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  return (
    <form className="panel-surface space-y-3 rounded-md p-5" onSubmit={async (event) => {
      event.preventDefault();
      try {
        await api(`/apps/${appId}/feedback`, { method: "POST", body: { title, body } });
        setTitle(""); setBody("");
        toast.success("已经收到，我们会先帮你分一下类");
        await qc.invalidateQueries({ queryKey: ["app", appId, "feedback"] });
      } catch (error) { toast.error(error instanceof Error ? error.message : "提交失败"); }
    }}>
      <h2 className="font-semibold">提反馈</h2>
      <input className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" placeholder="一句话说明" value={title} onChange={(event) => setTitle(event.target.value)} />
      <textarea className="min-h-32 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" placeholder="可以直接粘贴聊天记录" value={body} onChange={(event) => setBody(event.target.value)} />
      <Button type="submit" size="sm">提交</Button>
    </form>
  );
}

function ConfirmList({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const changes = useQuery({ queryKey: ["app", appId, "changes"], queryFn: () => api<{ items: { id: string; code: string; title: string; status: string; business_summary: string }[] }>(`/apps/${appId}/changes`) });
  const pending = (changes.data?.items ?? []).filter((item) => item.status === "pending_confirm");
  return (
    <div className="space-y-3">
      {pending.map((item) => (
        <section key={item.id} className="panel-surface rounded-md p-5 text-sm">
          <h3 className="font-semibold">{item.title}</h3>
          <p className="mt-2 leading-relaxed">{item.business_summary || "说明还在写。"}</p>
          <div className="mt-4 flex gap-2">
            <Button size="sm" onClick={async () => { await api(`/apps/${appId}/changes/${item.id}/confirm`, { method: "POST", body: { decision: "approve", comment: "同意" } }); toast.success("已同意"); await qc.invalidateQueries({ queryKey: ["app", appId] }); }}>同意</Button>
            <Button size="sm" variant="outline" onClick={async () => {
              const comment = window.prompt("要改哪里？") ?? "";
              if (comment.trim().length < 2) return;
              await api(`/apps/${appId}/changes/${item.id}/confirm`, { method: "POST", body: { decision: "reject", comment } });
              toast.success("已退回");
              await qc.invalidateQueries({ queryKey: ["app", appId] });
            }}>提修改意见</Button>
          </div>
        </section>
      ))}
      {!pending.length && <p className="text-sm text-muted-foreground">现在没有等你确认的改动。</p>}
    </div>
  );
}

function UatList({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const items = useQuery({ queryKey: ["app", appId, "uat"], queryFn: () => api<{ items: { id: string; title: string; steps: string; expected: string; result: string }[] }>(`/apps/${appId}/uat`) });
  return (
    <div className="space-y-3">
      {(items.data?.items ?? []).map((item) => (
        <section key={item.id} className="panel-surface rounded-md p-5 text-sm">
          <h3 className="font-semibold">{item.title}</h3>
          <p className="mt-2">{item.steps}</p>
          <p className="mt-1 text-muted-foreground">做到这样就算通过：{item.expected}</p>
          <p className="mt-2 font-medium">当前：{item.result === "pending" ? "还没点" : item.result === "passed" ? "通过" : "不通过"}</p>
          {item.result === "pending" && (
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={async () => { await api(`/uat/${item.id}`, { method: "POST", body: { result: "passed" } }); await qc.invalidateQueries({ queryKey: ["app", appId, "uat"] }); }}>通过</Button>
              <Button size="sm" variant="outline" onClick={async () => {
                const reason = window.prompt("哪里没通过？") ?? "";
                if (reason.trim().length < 2) return;
                await api(`/uat/${item.id}`, { method: "POST", body: { result: "failed", fail_reason: reason } });
                toast.success("已记下，并生成一条新的反馈");
                await qc.invalidateQueries({ queryKey: ["app", appId] });
              }}>不通过</Button>
            </div>
          )}
        </section>
      ))}
      {!items.data?.items.length && <p className="text-sm text-muted-foreground">还没有分给你的验收。</p>}
    </div>
  );
}

function MyFeedback({ appId }: { appId: string }) {
  const rows = useQuery({ queryKey: ["app", appId, "feedback"], queryFn: () => api<{ items: { code: string; title: string; status: string; released_in: string | null }[] }>(`/apps/${appId}/feedback`) });
  const label: Record<string, string> = { open: "已收到", triaged: "已分类", accepted: "已采纳", released: "已上线", wontfix: "这次不做" };
  return (
    <ul className="space-y-2 text-sm">
      {(rows.data?.items ?? []).map((item) => <li key={item.code} className="panel-surface rounded-md p-4"><span className="font-mono text-xs text-muted-foreground">{item.code}</span> {item.title} · {label[item.status] ?? item.status}{item.released_in ? ` · ${item.released_in}` : ""}</li>)}
    </ul>
  );
}

function Decisions({ appId }: { appId: string }) {
  const rows = useQuery({ queryKey: ["app", appId, "decisions"], queryFn: () => api<{ items: { code: string; title: string; body: string; created_at: string }[] }>(`/apps/${appId}/decisions`) });
  return (
    <ul className="space-y-2 text-sm">
      {(rows.data?.items ?? []).map((item) => <li key={item.code} className="panel-surface rounded-md p-4"><div className="font-semibold">{item.title}</div><p className="mt-1 text-muted-foreground">{item.body}</p></li>)}
    </ul>
  );
}
