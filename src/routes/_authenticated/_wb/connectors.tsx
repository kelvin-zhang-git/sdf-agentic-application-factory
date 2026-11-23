import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/sdf/common";
import { ConnectorDesk } from "@/components/sdf/ConnectorDesk";

export const Route = createFileRoute("/_authenticated/_wb/connectors")({
  head: () => ({ meta: [
    { title: "连接器 · SDF 智能应用工厂" },
    { name: "description", content: "把代码仓、工作项和通知接到应用上" },
    { property: "og:title", content: "连接器 · SDF 智能应用工厂" },
    { property: "og:description", content: "把代码仓、工作项和通知接到应用上" },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: () => (
    <div className="space-y-6">
      <PageHeader eyebrow="EXTERNAL INTEGRATIONS" title="连接器" desc="统一管理外部代码仓、工作项与通知 Webhook 凭据并绑定至应用。令牌经加密存储，保存后不再回显。" />
      <ConnectorDesk />
    </div>
  ),
});
