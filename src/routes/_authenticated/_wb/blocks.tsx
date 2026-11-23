import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/sdf/common";
import { ExampleCatalog } from "@/components/sdf/ExampleCatalog";
import { catalogQuery } from "@/data/examples";
import { appsQuery, meQuery } from "@/data/sdf";
import { workflowsQuery } from "@/data/runs";
import { api } from "@/data/http";
import { Button } from "@/components/ui/button";
import { PHASE_LABEL } from "@/data/types";

export const Route = createFileRoute("/_authenticated/_wb/blocks")({
  head: () => ({ meta: [
    { title: "积木 · SDF 智能应用工厂" },
    { name: "description", content: "管理只做一件事的功能单元" },
    { property: "og:title", content: "积木 · SDF 智能应用工厂" },
    { property: "og:description", content: "管理只做一件事的功能单元" },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  loader: ({ context }) => Promise.all([
    context.queryClient.ensureQueryData(catalogQuery("block")),
    context.queryClient.ensureQueryData(workflowsQuery()),
    context.queryClient.ensureQueryData(appsQuery()),
    context.queryClient.ensureQueryData(meQuery()),
  ]),
  component: BlocksPage,
});

function redact(text: string): string {
  return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[已去除]").replace(/sk-[A-Za-z0-9_-]{8,}/g, "[已去除]");
}

function BlocksPage() {
  const { data: workflows } = useSuspenseQuery(workflowsQuery());
  const { data: apps } = useSuspenseQuery(appsQuery());
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<{ items: { key: string; name: string; version: number; prompt: string }[] }>("/agents") });
  return (
    <div className="space-y-8">
      <PageHeader eyebrow="MODULAR BLOCK REGISTRY" title="积木" desc="只做一件事、通过标准制品与事件交互的功能单元。管理员可按需独立启停已实施积木。" />
      <div className="panel-surface overflow-hidden rounded-md">
        <ExampleCatalog kind="block" />
      </div>
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold text-foreground">资产目录</h2>
            <p className="text-sm text-muted-foreground">工作流、智能体提示词和应用登记。下载的资产包会自动去除邮箱和密钥。</p>
          </div>
          <Button variant="outline" onClick={() => {
            const pack = {
              kind: "sdfpack",
              version: 1,
              workflows: workflows.map((item) => ({ key: item.key, version: item.version, name: item.name, startable: item.startable })),
              agents: (agents.data?.items ?? []).map((item) => ({ key: item.key, name: item.name, version: item.version, prompt: redact(item.prompt) })),
              apps: apps.map((app) => ({ name: app.name, phase: app.phase, version: app.current_version })),
            };
            const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = "assets.sdfpack.json"; a.click();
            URL.revokeObjectURL(url);
          }}>下载资产包</Button>
        </div>
        <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border lg:grid-cols-3">
          <article className="bg-panel p-5 text-sm">
            <div className="stencil text-[10px] text-muted-foreground">WORKFLOWS</div>
            <h3 className="mt-1 font-semibold text-foreground">工作流</h3>
            <p className="mt-2 text-muted-foreground tabular-nums">{workflows.filter((item) => item.startable).length} 个可启动，共 {workflows.length} 个</p>
          </article>
          <article className="bg-panel p-5 text-sm">
            <div className="stencil text-[10px] text-muted-foreground">AGENT ROLES</div>
            <h3 className="mt-1 font-semibold text-foreground">智能体</h3>
            <p className="mt-2 text-muted-foreground tabular-nums">{agents.data?.items.length ?? 0} 个角色</p>
          </article>
          <article className="bg-panel p-5 text-sm">
            <div className="stencil text-[10px] text-muted-foreground">APPLICATIONS</div>
            <h3 className="mt-1 font-semibold text-foreground">应用</h3>
            <ul className="mt-2 space-y-1 text-muted-foreground">{apps.map((app) => <li key={app.id}>{app.name} · {PHASE_LABEL[app.phase]} · {app.current_version ?? "未发布"}</li>)}</ul>
          </article>
        </div>
      </section>
    </div>
  );
}
