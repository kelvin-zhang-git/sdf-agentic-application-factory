import { createFileRoute, Link } from "@tanstack/react-router";
import { runQuery } from "@/data/runs";
import { RunDetailView } from "@/components/sdf/RunDetail";

export const Route = createFileRoute("/_authenticated/_wb/apps/$appId_/runs/$runId")({
  head: () => ({ meta: [
    { title: "运行详情 · SDF 智能应用工厂" },
    { name: "description", content: "查看工作流运行的步骤进度、执行记录、产出制品和确认点" },
    { property: "og:title", content: "运行详情 · SDF 智能应用工厂" },
    { property: "og:description", content: "查看工作流运行的步骤进度、执行记录、产出制品和确认点" },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  loader: ({ context, params }) => context.queryClient.ensureQueryData(runQuery(params.runId)),
  component: RunPage,
});

function RunPage() {
  const { appId, runId } = Route.useParams();
  return (
    <div>
      <Link to="/apps/$appId" params={{ appId }} className="mb-3 inline-block text-sm text-muted-foreground hover:underline">← 返回应用</Link>
      <RunDetailView runId={runId} />
    </div>
  );
}
