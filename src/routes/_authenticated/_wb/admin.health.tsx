import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { HealthCheck } from "@/components/sdf/Diagnostics";
import { meQuery } from "@/data/sdf";
export const Route = createFileRoute("/_authenticated/_wb/admin/health")({
  head: () => ({ meta: [
    { title: "系统自检 · SDF 智能应用工厂" },
    { name: "description", content: "SDF 管理员系统检查与错误恢复验收" },
    { property: "og:title", content: "系统自检 · SDF 智能应用工厂" },
    { property: "og:description", content: "SDF 管理员系统检查与错误恢复验收" },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }), component: Page,
});
function Page() { const {data} = useSuspenseQuery(meQuery()); return data.global_roles.includes("admin") ? <HealthCheck /> : <p>仅管理员可访问。</p>; }