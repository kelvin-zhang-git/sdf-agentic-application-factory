import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { meQuery } from "@/data/sdf";
import { PageHeader } from "@/components/sdf/common";
import { AdminDashboard } from "@/components/sdf/AdminDashboard";

export const Route = createFileRoute("/_authenticated/_wb/dashboard")({
  head: () => ({
    meta: [
      { title: "全局指挥大盘 · SDF 智能应用工厂" },
      { name: "description", content: "平台管理员专属：受管应用态势、流水线吞吐、人工拍板、质量门禁与模型网关遥测总览" },
      { property: "og:title", content: "全局指挥大盘 · SDF 智能应用工厂" },
      { property: "og:description", content: "平台管理员专属：受管应用态势、流水线吞吐、人工拍板、质量门禁与模型网关遥测总览" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: DashboardPage,
});

function DashboardPage() {
  const { data: me } = useSuspenseQuery(meQuery());
  if (!me.global_roles.includes("admin")) {
    return (
      <div>
        <PageHeader eyebrow="EXECUTIVE TELEMETRY" title="全局指挥大盘" />
        <p className="text-sm text-muted-foreground">仅平台管理员可访问全局指挥大盘。</p>
      </div>
    );
  }
  return <AdminDashboard />;
}
