import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowUpRight, Plus, Shield, Users } from "lucide-react";
import { appsQuery, createApp, meQuery } from "@/data/sdf";
import { CLASS_LABEL, PHASE_LABEL } from "@/data/types";
import { PageHeader } from "@/components/sdf/common";
import { AppForm } from "@/components/sdf/AppForm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/_wb/apps/")({
  head: () => ({ meta: [
    { title: "应用 · SDF 智能应用工厂" },
    { name: "description", content: "查看和创建我参与的应用" },
    { property: "og:title", content: "应用 · SDF 智能应用工厂" },
    { property: "og:description", content: "查看和创建我参与的应用" },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  loader: ({ context }) => context.queryClient.ensureQueryData(appsQuery()),
  component: AppsPage,
});

function AppsPage() {
  const { data: apps } = useSuspenseQuery(appsQuery());
  const { data: me } = useSuspenseQuery(meQuery());
  const canCreate = me.global_roles.some((r) => r === "admin" || r === "lead");
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();

  const devCount = apps.filter((a) => a.phase === "development").length;
  const maintCount = apps.filter((a) => a.phase === "maintenance").length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="APPLICATION PORTFOLIO"
        title="应用"
        desc="受治理的应用工作空间、生命周期阶段与安全密级总览"
        actions={canCreate && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="size-4" />
                <span>新建应用</span>
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-xl">
              <DialogHeader><DialogTitle>新建应用</DialogTitle></DialogHeader>
              <AppForm submitLabel="创建" onSubmit={async (v) => {
                const a = await createApp(v);
                await qc.invalidateQueries({ queryKey: ["apps"] });
                setOpen(false);
                nav({ to: "/apps/$appId", params: { appId: a.id } });
              }} />
            </DialogContent>
          </Dialog>
        )}
      />

      {apps.length > 0 && (
        <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-3">
          <div className="bg-panel px-5 py-3.5">
            <div className="stencil text-[10px] text-muted-foreground">TOTAL APPLICATIONS</div>
            <div className="mt-1 text-xl font-semibold text-foreground tabular-nums">{apps.length}</div>
          </div>
          <div className="bg-panel px-5 py-3.5">
            <div className="stencil text-[10px] text-muted-foreground">DEVELOPMENT · 开发期</div>
            <div className="mt-1 text-xl font-semibold text-foreground tabular-nums">{devCount}</div>
          </div>
          <div className="bg-panel px-5 py-3.5">
            <div className="stencil text-[10px] text-muted-foreground">MAINTENANCE · 维护期</div>
            <div className="mt-1 text-xl font-semibold text-foreground tabular-nums">{maintCount}</div>
          </div>
        </div>
      )}

      {apps.length === 0 ? (
        <div className="panel-surface rounded-md border-dashed p-12 text-center text-sm text-muted-foreground">
          还没有参与任何应用。{canCreate ? "点击右上角「新建应用」开始创建工作空间。" : "请联系交付负责人把您加入应用。"}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {apps.map((a) => (
            <Link
              key={a.id}
              to="/apps/$appId"
              params={{ appId: a.id }}
              className="panel-surface group relative flex flex-col justify-between overflow-hidden rounded-md p-5 transition-all hover:border-primary/50"
            >
              <span
                className="absolute inset-x-0 top-0 h-0.5 bg-transparent transition-colors group-hover:bg-primary"
                aria-hidden
              />
              <div>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-base font-semibold tracking-tight text-foreground transition-colors group-hover:text-primary">
                    {a.name}
                  </h3>
                  <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-primary" />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Badge variant={a.phase === "maintenance" ? "secondary" : "default"}>
                    {PHASE_LABEL[a.phase]}
                  </Badge>
                  {a.current_version && (
                    <span className="rounded-xs border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground tabular-nums">
                      {a.current_version}
                    </span>
                  )}
                  {a.source === "seed" && <Badge variant="outline">示例数据</Badge>}
                </div>
                <p className="mt-3 line-clamp-2 min-h-10 text-sm leading-relaxed text-muted-foreground">
                  {a.description || "暂无简介"}
                </p>
              </div>
              <div className="mt-5 flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Shield className="size-3.5 text-muted-foreground/80" />
                  <span>密级：{CLASS_LABEL[a.classification]}</span>
                </span>
                <span className="inline-flex items-center gap-1 tabular-nums">
                  <Users className="size-3.5 text-muted-foreground/80" />
                  <span>成员 {a.app_members?.[0]?.count ?? 0}</span>
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
