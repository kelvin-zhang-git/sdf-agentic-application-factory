import { useState } from "react";
import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { toast } from "sonner";
import { adminUsersQuery, appsQuery, meQuery, metaQuery, setAccountExpiry, setUserRoles } from "@/data/sdf";
import { ROLE_LABEL, type GlobalRole } from "@/data/types";
import { ErrorBox, errorText, Mono, PageHeader } from "@/components/sdf/common";
import { HookSwitches } from "@/components/sdf/Stage3Panels";
import { AuditSection, MembersSection } from "@/components/sdf/AppSettings";
import { ModelSettings } from "@/components/sdf/ModelSettings";
import { Diagnostics } from "@/components/sdf/Diagnostics";
import { DocumentTemplates } from "@/components/sdf/DocumentTemplates";
import { TokenPanel } from "@/components/sdf/TokenPanel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/_wb/admin")({
  head: () => ({ meta: [
    { title: "管理 · SDF 智能应用工厂" },
    { name: "description", content: "管理 LiteLLM 模型服务、三档模型路由、用户角色和审计日志" },
    { property: "og:title", content: "管理 · SDF 智能应用工厂" },
    { property: "og:description", content: "管理 LiteLLM 模型服务、三档模型路由、用户角色和审计日志" },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: AdminPage,
});

const ROLES: GlobalRole[] = ["admin", "lead", "ba", "architect", "security", "dev", "qa", "business"];

function AdminPage() {
  const { data: me } = useSuspenseQuery(meQuery());
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  if (!me.global_roles.includes("admin")) return <div><PageHeader eyebrow="PLATFORM GOVERNANCE" title="管理" /><p className="text-sm text-muted-foreground">仅平台管理员可访问。</p></div>;
  if (pathname !== "/admin") return <Outlet />;
  return (
    <div>
      <PageHeader
        eyebrow="PLATFORM GOVERNANCE"
        title="管理"
        desc="平台管理员专用：统一配置用户角色、访问令牌、模型路由、自动规则与安全审计"
        actions={
          <Button asChild size="sm" variant="outline">
            <Link to="/dashboard">
              <Gauge className="size-4" />
              <span>打开全局指挥大盘</span>
            </Link>
          </Button>
        }
      />
      <Tabs defaultValue="users">
        <TabsList className="mb-6 h-auto max-w-full flex-wrap justify-start">
          <TabsTrigger value="users">用户和角色</TabsTrigger>
          <TabsTrigger value="tokens">访问令牌</TabsTrigger>
          <TabsTrigger value="models">模型</TabsTrigger>
          <TabsTrigger value="hooks">自动规则</TabsTrigger>
          <TabsTrigger value="audit">审计日志</TabsTrigger>
          <TabsTrigger value="logs">系统日志</TabsTrigger>
          <TabsTrigger value="templates">报告模板</TabsTrigger>
          <TabsTrigger value="meta">系统信息</TabsTrigger>
        </TabsList>
        <TabsContent value="users"><Users selfId={me.user_id} /></TabsContent>
        <TabsContent value="tokens"><div className="panel-surface rounded-md p-5"><TokenPanel /></div></TabsContent>
        <TabsContent value="models"><ModelSettings /></TabsContent>
        <TabsContent value="hooks"><div className="panel-surface rounded-md p-5"><HookSwitches /></div></TabsContent>
        <TabsContent value="audit"><AuditSection /></TabsContent>
        <TabsContent value="logs"><Diagnostics /></TabsContent>
        <TabsContent value="templates"><div className="panel-surface rounded-md p-5"><DocumentTemplates /></div></TabsContent>
        <TabsContent value="meta"><Meta /></TabsContent>
      </Tabs>
      <Outlet />
    </div>
  );
}

function Users({ selfId }: { selfId: string }) {
  const q = useQuery(adminUsersQuery());
  const apps = useQuery(appsQuery());
  const qc = useQueryClient();
  const [selectedAppId, setSelectedAppId] = useState<string>("");
  const currentAppId = selectedAppId || apps.data?.[0]?.id || "";
  return (
    <div className="space-y-6">
      {/* 1. 按项目组建虚拟团队（Virtual Team） */}
      <section className="panel-surface space-y-4 rounded-md p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
          <div>
            <h3 className="font-semibold text-foreground">按项目组建虚拟团队（Virtual Team）</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              选择任意应用/项目，直接拉入不同成员并按项目需求分配各自角色；同一成员在多个项目中可担任不同角色。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">目标项目：</span>
            <Select value={currentAppId} onValueChange={setSelectedAppId}>
              <SelectTrigger className="w-72" aria-label="选择要管理虚拟团队的项目">
                <SelectValue placeholder="选择一个项目" />
              </SelectTrigger>
              <SelectContent>
                {(apps.data ?? []).map((app) => (
                  <SelectItem key={app.id} value={app.id}>{app.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {currentAppId ? (
          <MembersSection appId={currentAppId} canManage />
        ) : (
          <p className="text-sm text-muted-foreground">还没有应用项目，请先在「应用」菜单创建一个项目。</p>
        )}
      </section>

      {/* 2. 平台账号与全局角色（附跨项目任职总览） */}
      <section className="panel-surface space-y-3 overflow-hidden rounded-md p-5">
        <div>
          <h3 className="font-semibold text-foreground">平台账号、跨项目任职与全局角色</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            下方表格展示每位注册用户的跨项目虚拟团队任职情况与平台级全局角色（例如「平台管理员」）。具体项目的确认点审批与访问权限以上方「按项目组建虚拟团队」为准。
          </p>
        </div>
        <ErrorBox error={q.error} />
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead>用户</TableHead>
                <TableHead>已参与项目与角色</TableHead>
                <TableHead>账号有效期</TableHead>
                {ROLES.map((r) => <TableHead key={r} className="text-center text-xs">{ROLE_LABEL[r]}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(q.data ?? []).map((u) => (
                <TableRow key={u.id}>
                  <TableCell><div className="font-medium text-foreground">{u.display_name}</div><Mono>{u.email}</Mono></TableCell>
                  <TableCell className="max-w-xs">
                    {u.memberships?.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {u.memberships.map((m) => (
                          <button
                            key={m.app_id}
                            type="button"
                            onClick={() => setSelectedAppId(m.app_id)}
                            className="cursor-pointer rounded border border-border bg-muted/40 px-2 py-0.5 text-left text-[11px] hover:border-primary/50"
                            title="点击在上方切换到该项目的虚拟团队"
                          >
                            <span className="font-medium text-foreground">{m.app_name}</span>
                            <span className="mx-1 text-muted-foreground">·</span>
                            <span className="text-primary">{m.roles.map((r) => ROLE_LABEL[r]).join("/")}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">暂未加入项目</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <input className="h-8 rounded border px-2 text-xs" type="date" aria-label={`${u.display_name}有效期`} value={u.expires_at ? String(u.expires_at).slice(0, 10) : ""} onChange={async (event) => {
                      const value = event.target.value;
                      try { await setAccountExpiry(u.id, value ? new Date(`${value}T23:59:59`).toISOString() : null); qc.invalidateQueries({ queryKey: ["admin", "users"] }); toast.success(value ? "已设置账号有效期" : "已取消账号有效期"); }
                      catch (x) { toast.error(errorText(x)); }
                    }} />
                  </TableCell>
                  {ROLES.map((r) => (
                    <TableCell key={r} className="text-center">
                      <Checkbox aria-label={`${u.display_name} ${ROLE_LABEL[r]}`} checked={u.roles.includes(r)} disabled={u.id === selfId && r === "admin"}
                        onCheckedChange={async (c) => {
                          const next = c ? [...u.roles, r] : u.roles.filter((x) => x !== r);
                          try { await setUserRoles(u.id, next); qc.invalidateQueries({ queryKey: ["admin", "users"] }); qc.invalidateQueries({ queryKey: ["audit"] }); }
                          catch (x) { toast.error(errorText(x)); }
                        }} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}

function Meta() {
  const q = useQuery(metaQuery());
  return (
    <div className="space-y-3">
      <ErrorBox error={q.error} />
      <pre className="panel-surface overflow-auto rounded-md p-4 font-mono text-xs leading-relaxed">{q.data ? JSON.stringify(q.data, null, 2) : "加载中…"}</pre>
    </div>
  );
}
