import { useQuery } from "@tanstack/react-query";
import { api } from "@/data/http";

interface Metrics {
  cycle_hours: number | null;
  cycle_samples: number;
  stages: { stage: string; hours: number; samples: number }[];
  requirements: number;
  covered_requirements: number;
  approved: number;
  decided: number;
}

export function FlowMetrics({ appId }: { appId: string }) {
  const metrics = useQuery({ queryKey: ["app", appId, "flow-metrics"], queryFn: () => api<Metrics>(`/apps/${appId}/flow-metrics`) });
  const data = metrics.data;
  if (!data) return <p className="text-sm text-muted-foreground">{metrics.isError ? "交付流指标暂时读不到。" : "正在计算交付流指标…"}</p>;
  const coverage = data.requirements ? Math.round((data.covered_requirements / data.requirements) * 1000) / 10 : 0;
  const adoption = data.decided ? Math.round((data.approved / data.decided) * 1000) / 10 : 0;
  const cards = [
    ["周期时间", data.cycle_hours === null ? "无" : `${data.cycle_hours} 小时`, `样本量 ${data.cycle_samples}`],
    ["需求覆盖", `${coverage}%`, `${data.covered_requirements}/${data.requirements}`],
    ["确认采纳", `${adoption}%`, `${data.approved}/${data.decided}`],
    ["阶段", String(data.stages.length), data.stages.map((item) => `${item.stage} ${item.hours}h`).join("、") || "还没有已完成步骤"],
  ];
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-foreground">交付流</h3>
        <span className="stencil text-[10px] text-muted-foreground">DELIVERY FLOW METRICS</span>
      </div>
      <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4">
        {cards.map(([title, value, note]) => (
          <article key={title} className="bg-panel p-4">
            <div className="text-xs font-medium text-muted-foreground">{title}</div>
            <div className="mt-1.5 text-xl font-semibold tracking-tight text-foreground tabular-nums">{value}</div>
            <div className="mt-1 font-mono text-xs text-muted-foreground tabular-nums">{note}</div>
          </article>
        ))}
      </div>
    </section>
  );
}
