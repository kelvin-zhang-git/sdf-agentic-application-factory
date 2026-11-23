import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { appQuery, meQuery, releasesQuery, updateApp } from "@/data/sdf";
import { CLASS_LABEL, PHASE_LABEL, ROLE_LABEL } from "@/data/types";
import { PageHeader } from "@/components/sdf/common";
import { AppForm } from "@/components/sdf/AppForm";
import { AppStageNav, type AppTabKey } from "@/components/sdf/AppStageNav";
import { AuditSection, ContactsSection, MembersSection } from "@/components/sdf/AppSettings";
import { Badge } from "@/components/ui/badge";
import { ArtifactViewer } from "@/components/sdf/ArtifactViewer";
import { AppRuns } from "@/components/sdf/AppRuns";
import { RequirementsTab } from "@/components/sdf/RequirementsTab";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { DesignPanel, DevPanel, DocsPanel, QualityPanel } from "@/components/sdf/Stage1Panels";
import { CollabPanel } from "@/components/sdf/Stage3Panels";
import { ConnectorDesk } from "@/components/sdf/ConnectorDesk";
import { FlowMetrics } from "@/components/sdf/FlowMetrics";
import { FeatureBoard } from "@/components/sdf/FeatureBoard";
import { getAccessToken } from "@/data/auth";

export const Route = createFileRoute("/_authenticated/_wb/apps/$appId")({
  head: () => ({ meta: [
    { title: "应用详情 · SDF 智能应用工厂" },
    { name: "description", content: "查看应用概览、成员、联系人和设置" },
    { property: "og:title", content: "应用详情 · SDF 智能应用工厂" },
    { property: "og:description", content: "查看应用概览、成员、联系人和设置" },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  loader: ({ context, params }) => Promise.all([
    context.queryClient.ensureQueryData(appQuery(params.appId)),
    context.queryClient.ensureQueryData(releasesQuery(params.appId)),
  ]),
  component: AppDetail,
});

function VersionTimeline({ appId }: { appId: string }) {
  const { data } = useSuspenseQuery(releasesQuery(appId));
  return (
    <section className="panel-surface space-y-3 rounded-md p-5">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-foreground">版本</h3>
        <span className="stencil text-[10px] text-muted-foreground">RELEASE TIMELINE</span>
      </div>
      {data.length === 0 ? <p className="text-sm text-muted-foreground">还没有发布记录。</p> : (
        <ol className="space-y-3 border-l-2 border-primary/30 pl-4">
          {data.map((item) => (
            <li key={item.id} className="relative">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-sm font-semibold text-foreground">{item.version}</span>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {item.published_at ? new Date(item.published_at).toLocaleString("zh-CN") : ""}
                </span>
              </div>
              {item.notes_business ? <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{item.notes_business}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function AppDetail() {
  const { appId } = Route.useParams();
  const { data: app } = useSuspenseQuery(appQuery(appId));
  const { data: me } = useSuspenseQuery(meQuery());
  const qc = useQueryClient();
  const [tab, setTab] = useState<AppTabKey>("overview");
  const canManage = me.global_roles.includes("admin") || (app.my_roles ?? []).includes("lead");
  const canWork = canManage || (app.my_roles ?? []).includes("ba");
  return (
    <div>
      <PageHeader
        eyebrow="APPLICATION WORKSPACE"
        title={app.name}
        desc={app.description || undefined}
        actions={
          <div className="flex flex-wrap gap-2">
            {app.source === "seed" && <Badge variant="outline">示例数据</Badge>}
            <Badge>{PHASE_LABEL[app.phase]}</Badge>
            <Badge variant="outline">密级：{CLASS_LABEL[app.classification]}</Badge>
          </div>
        }
      />
      <AppStageNav active={tab} onChange={setTab} app={app} />
      <Tabs value={tab} onValueChange={(v) => setTab(v as AppTabKey)}>
        <TabsContent value="overview" className="space-y-6">
          <dl className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4">
            <div className="bg-panel p-4">
              <dt className="stencil text-[10px] text-muted-foreground">LIFECYCLE · 阶段</dt>
              <dd className="mt-1 text-sm font-semibold text-foreground">{PHASE_LABEL[app.phase]}</dd>
            </div>
            <div className="bg-panel p-4">
              <dt className="stencil text-[10px] text-muted-foreground">RELEASE · 当前版本</dt>
              <dd className="mt-1 font-mono text-sm font-semibold text-foreground tabular-nums">{app.current_version ?? "未发布"}</dd>
            </div>
            <div className="bg-panel p-4">
              <dt className="stencil text-[10px] text-muted-foreground">MY ROLES · 我的角色</dt>
              <dd className="mt-1 text-sm font-semibold text-foreground">{(app.my_roles ?? []).map((r) => ROLE_LABEL[r]).join("、") || "管理员（非成员）"}</dd>
            </div>
            <div className="bg-panel p-4">
              <dt className="stencil text-[10px] text-muted-foreground">PII REDACTION · 发送前脱敏</dt>
              <dd className="mt-1 text-sm font-semibold text-foreground">{app.redact_before_llm ? "开启" : "关闭"}</dd>
            </div>
          </dl>
          <VersionTimeline appId={appId} />
          <FlowMetrics appId={appId} />
          <div className="panel-surface rounded-md p-5">
            <ArtifactViewer appId={appId} />
          </div>
        </TabsContent>
        <TabsContent value="runs"><AppRuns appId={appId} canStart={canWork} /></TabsContent>
        <TabsContent value="req"><RequirementsTab appId={appId} canEdit={canWork} canSpec={canWork || (app.my_roles ?? []).includes("architect")} /></TabsContent>
        <TabsContent value="features"><FeatureBoard appId={appId} canEdit={canWork} /></TabsContent>
        <TabsContent value="design"><DesignPanel appId={appId} /></TabsContent>
        <TabsContent value="dev"><DevPanel appId={appId} /></TabsContent>
        <TabsContent value="quality"><QualityPanel appId={appId} /></TabsContent>
        <TabsContent value="collab"><CollabPanel appId={appId} /></TabsContent>
        <TabsContent value="docs"><DocsPanel appId={appId} /></TabsContent>
        <TabsContent value="settings" className="space-y-8">
          <section className="panel-surface space-y-4 rounded-md p-5">
            <h3 className="font-semibold">基本信息</h3>
            <div className="max-w-2xl">
              <AppForm initial={app} disabled={!canManage} submitLabel="保存" onSubmit={async (v) => {
                await updateApp(appId, v); await qc.invalidateQueries({ queryKey: ["app", appId] }); qc.invalidateQueries({ queryKey: ["apps"] }); toast.success("已保存");
              }} />
            </div>
          </section>
          <MembersSection appId={appId} canManage={canManage} />
          <ContactsSection appId={appId} canManage={canManage || (app.my_roles ?? []).includes("ba")} myUserId={me.user_id} />
          <AuditSection appId={appId} />
          <section className="panel-surface space-y-3 rounded-md p-5">
            <h3 className="font-semibold">连接器</h3>
            <ConnectorDesk appId={appId} />
          </section>
          <section className="panel-surface space-y-3 rounded-md p-5">
            <h3 className="font-semibold">导出</h3>
            <p className="text-sm text-muted-foreground">下载这个应用的数据包。令牌、密钥、邮箱和手机号会去掉。</p>
            <Button variant="outline" onClick={async () => {
              try {
                const token = await getAccessToken();
                const res = await fetch(`/api/apps/${appId}/export-bundle`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
                if (!res.ok) throw new Error("导出失败");
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url; a.download = "sdf-app.zip"; a.click();
                URL.revokeObjectURL(url);
              } catch (error) { toast.error(error instanceof Error ? error.message : "导出失败"); }
            }}>下载脱敏数据包</Button>
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}
