import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  Bar,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  Cpu,
  Filter,
  GitBranch,
  Layers,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Shield,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { adminDashboardQuery, type AdminDashboardResponse } from "@/data/dashboard";
import { CLASS_LABEL, PHASE_LABEL } from "@/data/types";
import { useLiveRun } from "@/hooks/use-live-run";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorBox } from "./common";
import { StatusBadge, since } from "./StepBar";

type WindowDays = 7 | 14 | 30;
type PortfolioFilter = "all" | "attention" | "development" | "maintenance";
type ChartMode = "activity" | "tokens";

function compactNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("zh-CN");
}

const HEALTH_META: Record<
  AdminDashboardResponse["apps"][number]["health"],
  { label: string; dot: string; badge: string }
> = {
  healthy: {
    label: "健康",
    dot: "bg-success",
    badge: "border-success/35 bg-success/10 text-success",
  },
  attention: {
    label: "待协同",
    dot: "bg-warning animate-pulse",
    badge: "border-warning/40 bg-warning/15 text-foreground",
  },
  blocked: {
    label: "阻断",
    dot: "bg-destructive animate-pulse",
    badge: "border-destructive/45 bg-destructive/12 text-destructive",
  },
};

const TIER_LABEL: Record<string, string> = {
  fast: "FAST · 轻量实时",
  standard: "STANDARD · 标准主力",
  deep: "DEEP · 深度推理",
};

/** 平台管理员专属全局指挥大盘：汇聚项目资产、流水线健康度、人机协同、质量门禁与模型网关算力。 */
export function AdminDashboard() {
  const [days, setDays] = useState<WindowDays>(14);
  const [includeSeed, setIncludeSeed] = useState(true);
  const [portfolioFilter, setPortfolioFilter] = useState<PortfolioFilter>("all");
  const [search, setSearch] = useState("");
  const [chartMode, setChartMode] = useState<ChartMode>("activity");

  useLiveRun(["admin", "dashboard", days, includeSeed]);
  const q = useQuery(adminDashboardQuery(days, includeSeed));
  const data = q.data;

  const filteredApps = useMemo(() => {
    if (!data) return [];
    const kw = search.trim().toLowerCase();
    return data.apps.filter((app) => {
      if (portfolioFilter === "attention" && app.health === "healthy") return false;
      if (portfolioFilter === "development" && app.phase !== "development") return false;
      if (portfolioFilter === "maintenance" && app.phase !== "maintenance") return false;
      if (kw && !app.name.toLowerCase().includes(kw) && !app.description.toLowerCase().includes(kw)) {
        return false;
      }
      return true;
    });
  }, [data, portfolioFilter, search]);

  const attentionCount = useMemo(
    () => (data?.apps ?? []).filter((a) => a.health !== "healthy").length,
    [data],
  );

  const maxFunnel = useMemo(
    () => Math.max(1, ...(data?.sdlc_funnel.map((x) => x.count) ?? [1])),
    [data],
  );

  const maxAgentTokens = useMemo(
    () => Math.max(1, ...(data?.agents.map((x) => x.tokens) ?? [1])),
    [data],
  );

  return (
    <div className="space-y-6">
      {/* 顶部工业蓝图指挥横幅 */}
      <header className="panel-surface overflow-hidden rounded-md">
        <div className="hazard-stripe h-1 opacity-75" aria-hidden />
        <div className="blueprint-grid">
          <div className="flex flex-col justify-between gap-4 bg-panel/88 px-5 py-5 lg:flex-row lg:items-end sm:px-6">
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="inline-flex items-center gap-1.5 rounded-xs border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-primary">
                  <span className="size-1.5 rounded-full bg-primary animate-pulse" aria-hidden />
                  EXECUTIVE TELEMETRY · LIVE
                </span>
                {data && (
                  <span className="stencil text-[10px] text-muted-foreground">
                    SDF ENGINE v{data.api_version} · 刷新于{" "}
                    {new Date(data.generated_at).toLocaleTimeString("zh-CN")}
                  </span>
                )}
              </div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-[26px]">
                全局指挥大盘
              </h1>
              <p className="max-w-2xl text-sm text-muted-foreground">
                跨项目全生命周期治理视图：实时追踪应用组合态势、流水线吞吐、人工拍板积压、质量门禁覆盖率与大模型算力水位
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div
                className="inline-flex rounded-sm border border-border bg-background p-0.5"
                role="group"
                aria-label="统计周期"
              >
                {([7, 14, 30] as WindowDays[]).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDays(d)}
                    className={cn(
                      "rounded-xs px-2.5 py-1 font-mono text-xs font-medium tabular-nums transition-colors",
                      days === d
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    近 {d} 天
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setIncludeSeed((v) => !v)}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-sm border px-2.5 text-xs font-medium transition-colors",
                  includeSeed
                    ? "border-border bg-panel text-foreground hover:bg-muted"
                    : "border-primary/40 bg-primary/10 text-primary",
                )}
                title="切换是否统计平台内置的示例演示项目（如澄远零售）"
              >
                <Filter className="size-3.5" />
                <span>{includeSeed ? "含示例项目" : "仅真实项目"}</span>
              </button>

              <Button
                size="sm"
                variant="outline"
                onClick={() => void q.refetch()}
                disabled={q.isFetching}
                aria-label="刷新大盘"
              >
                <RefreshCw className={cn("size-3.5", q.isFetching && "animate-spin")} />
                <span>刷新</span>
              </Button>

              <Button asChild size="sm" variant="outline">
                <Link to="/admin/health">
                  <ShieldCheck className="size-3.5" />
                  <span>系统自检</span>
                </Link>
              </Button>

              <Button asChild size="sm">
                <Link to="/admin">
                  <Settings2 className="size-3.5" />
                  <span>平台治理</span>
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </header>

      <ErrorBox error={q.error} />

      {!data ? (
        <DashboardSkeleton />
      ) : (
        <>
          {/* 第一层：5 大核心 SMART KPI 指标带 */}
          <section aria-label="核心治理指标" className="panel-surface overflow-hidden rounded-md">
            <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-5">
              {/* KPI 1: 受管应用资产 */}
              <article className="relative flex flex-col justify-between bg-panel p-4 sm:p-5">
                <span className="absolute inset-x-0 top-0 h-0.5 bg-primary" aria-hidden />
                <div>
                  <div className="flex items-center justify-between">
                    <span className="stencil text-[10px] text-muted-foreground">01 · PORTFOLIO</span>
                    <Layers className="size-4 text-primary/80" />
                  </div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-3xl font-semibold tracking-tight text-foreground tabular-nums">
                      {data.kpis.apps_total}
                    </span>
                    <span className="text-xs text-muted-foreground">个受管应用</span>
                  </div>
                </div>
                <div className="mt-4 space-y-2">
                  <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="bg-primary transition-all"
                      style={{
                        width: `${data.kpis.apps_total ? (data.kpis.apps_dev / data.kpis.apps_total) * 100 : 0}%`,
                      }}
                    />
                    <div
                      className="bg-info transition-all"
                      style={{
                        width: `${data.kpis.apps_total ? (data.kpis.apps_maint / data.kpis.apps_total) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <div className="flex items-center justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
                    <span>开发 {data.kpis.apps_dev} · 维护 {data.kpis.apps_maint}</span>
                    <span>
                      脱敏{" "}
                      {data.kpis.apps_total
                        ? Math.round((data.kpis.apps_redacted / data.kpis.apps_total) * 100)
                        : 0}
                      %
                    </span>
                  </div>
                </div>
              </article>

              {/* KPI 2: 流水线执行态势 */}
              <article className="relative flex flex-col justify-between bg-panel p-4 sm:p-5">
                <span className="absolute inset-x-0 top-0 h-0.5 bg-info" aria-hidden />
                <div>
                  <div className="flex items-center justify-between">
                    <span className="stencil text-[10px] text-muted-foreground">02 · PIPELINE RUNS</span>
                    <GitBranch className="size-4 text-info" />
                  </div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-3xl font-semibold tracking-tight text-foreground tabular-nums">
                      {data.kpis.runs_total}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      活跃 {data.kpis.runs_active} · 完成 {data.kpis.runs_completed}
                    </span>
                  </div>
                </div>
                <div className="mt-4 space-y-2">
                  <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="bg-success"
                      style={{
                        width: `${data.kpis.runs_total ? (data.kpis.runs_completed / data.kpis.runs_total) * 100 : 0}%`,
                      }}
                    />
                    <div
                      className="bg-warning"
                      style={{
                        width: `${data.kpis.runs_total ? (data.kpis.runs_active / data.kpis.runs_total) * 100 : 0}%`,
                      }}
                    />
                    <div
                      className="bg-destructive"
                      style={{
                        width: `${data.kpis.runs_total ? (data.kpis.runs_failed / data.kpis.runs_total) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <div className="flex items-center justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
                    <span>
                      中位周期{" "}
                      {data.kpis.median_cycle_hours !== null ? `${data.kpis.median_cycle_hours}h` : "—"}
                    </span>
                    <span className={cn(data.kpis.runs_failed > 0 && "font-semibold text-destructive")}>
                      失败 {data.kpis.runs_failed}
                    </span>
                  </div>
                </div>
              </article>

              {/* KPI 3: 人机协同拍板 */}
              <article className="relative flex flex-col justify-between bg-panel p-4 sm:p-5">
                <span className="absolute inset-x-0 top-0 h-0.5 bg-warning" aria-hidden />
                <div>
                  <div className="flex items-center justify-between">
                    <span className="stencil text-[10px] text-muted-foreground">03 · HUMAN CHECKPOINTS</span>
                    <Sparkles className="size-4 text-warning" />
                  </div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-3xl font-semibold tracking-tight text-foreground tabular-nums">
                      {data.kpis.approval_rate !== null ? `${data.kpis.approval_rate}%` : "—"}
                    </span>
                    <span className="text-xs text-muted-foreground">人工确认采纳率</span>
                  </div>
                </div>
                <div className="mt-4 space-y-2">
                  <div className="flex flex-wrap gap-1.5">
                    <span
                      className={cn(
                        "rounded-xs border px-1.5 py-0.5 font-mono text-[10px] tabular-nums",
                        data.kpis.checkpoints_waiting > 0
                          ? "border-warning/50 bg-warning/15 font-semibold text-foreground"
                          : "border-border bg-muted/60 text-muted-foreground",
                      )}
                    >
                      待拍板 {data.kpis.checkpoints_waiting}
                    </span>
                    <span className="rounded-xs border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
                      待业务确认 {data.kpis.changes_pending}
                    </span>
                  </div>
                  <div className="flex items-center justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
                    <span>
                      已决 {data.kpis.approved_steps}/{data.kpis.decided_steps}
                    </span>
                    <span className={cn(data.kpis.open_blockers > 0 && "font-semibold text-destructive")}>
                      阻断问题 {data.kpis.open_blockers}
                    </span>
                  </div>
                </div>
              </article>

              {/* KPI 4: 质量门禁与验收覆盖 */}
              <article className="relative flex flex-col justify-between bg-panel p-4 sm:p-5">
                <span className="absolute inset-x-0 top-0 h-0.5 bg-success" aria-hidden />
                <div>
                  <div className="flex items-center justify-between">
                    <span className="stencil text-[10px] text-muted-foreground">04 · QUALITY & GATES</span>
                    <CheckCircle2 className="size-4 text-success" />
                  </div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-3xl font-semibold tracking-tight text-foreground tabular-nums">
                      {data.kpis.ac_coverage_pct}%
                    </span>
                    <span className="text-xs text-muted-foreground">AC 用例覆盖率</span>
                  </div>
                </div>
                <div className="mt-4 space-y-2">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-success transition-all"
                      style={{ width: `${Math.min(100, data.kpis.ac_coverage_pct)}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
                    <span>
                      {data.kpis.reqs_total} REQ · {data.kpis.tcs_total} TC
                    </span>
                    <span>
                      门禁 {data.kpis.gates_passed} 过 / {data.kpis.gates_failed} 阻
                    </span>
                  </div>
                </div>
              </article>

              {/* KPI 5: AI 算力与模型网关遥测 */}
              <article className="relative flex flex-col justify-between bg-panel p-4 sm:p-5 sm:col-span-2 lg:col-span-1">
                <span className="absolute inset-x-0 top-0 h-0.5 bg-foreground/60" aria-hidden />
                <div>
                  <div className="flex items-center justify-between">
                    <span className="stencil text-[10px] text-muted-foreground">
                      05 · LLM GATEWAY ({days}D)
                    </span>
                    <Cpu className="size-4 text-foreground/80" />
                  </div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-3xl font-semibold tracking-tight text-foreground tabular-nums">
                      {compactNum(data.kpis.llm_tokens)}
                    </span>
                    <span className="text-xs text-muted-foreground">Tokens</span>
                  </div>
                </div>
                <div className="mt-4 space-y-2">
                  <div className="flex flex-wrap gap-1.5">
                    <span className="rounded-xs border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground tabular-nums">
                      调用 {data.kpis.llm_calls} 次
                    </span>
                    <span className="rounded-xs border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
                      成功率 {data.kpis.llm_success_rate !== null ? `${data.kpis.llm_success_rate}%` : "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
                    <span>均耗 {data.kpis.llm_avg_latency_ms}ms</span>
                    <span>PII 脱敏 {data.kpis.llm_redacted_calls} 次</span>
                  </div>
                </div>
              </article>
            </div>
          </section>

          {/* 第二层：趋势图表 + SDLC 工程资产转化漏斗 */}
          <div className="grid gap-5 lg:grid-cols-12">
            {/* 左：近 N 天活跃度与算力消耗曲线 */}
            <section className="panel-surface flex flex-col justify-between rounded-md p-5 lg:col-span-7">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="stencil text-[10px] text-primary">FACTORY THROUGHPUT & TELEMETRY</p>
                  <h2 className="mt-0.5 text-base font-semibold text-foreground">
                    近 {days} 天工厂执行活跃度与模型算力趋势
                  </h2>
                </div>
                <div className="inline-flex rounded-sm border border-border bg-background p-0.5">
                  <button
                    type="button"
                    onClick={() => setChartMode("activity")}
                    className={cn(
                      "rounded-xs px-2.5 py-1 text-xs font-medium transition-colors",
                      chartMode === "activity"
                        ? "bg-panel text-foreground shadow-2xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    步骤与模型调用
                  </button>
                  <button
                    type="button"
                    onClick={() => setChartMode("tokens")}
                    className={cn(
                      "rounded-xs px-2.5 py-1 text-xs font-medium transition-colors",
                      chartMode === "tokens"
                        ? "bg-panel text-foreground shadow-2xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    Token 消耗量
                  </button>
                </div>
              </div>

              <div className="h-64 w-full">
                {chartMode === "activity" ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={data.daily_trend}
                      margin={{ top: 8, right: 8, left: -18, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="sdfCallsGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--color-primary)" stopOpacity={0.28} />
                          <stop offset="95%" stopColor="var(--color-primary)" stopOpacity={0.0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                      <XAxis
                        dataKey="label"
                        tickLine={false}
                        axisLine={false}
                        tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                      />
                      <YAxis
                        allowDecimals={false}
                        tickLine={false}
                        axisLine={false}
                        tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                      />
                      <RechartsTooltip
                        contentStyle={{
                          backgroundColor: "var(--color-panel)",
                          borderColor: "var(--color-border)",
                          borderRadius: "6px",
                          fontSize: "12px",
                        }}
                        formatter={(value: number, name: string) => {
                          const map: Record<string, string> = {
                            step_executions: "步骤执行数",
                            llm_calls: "模型调用次数",
                            runs_started: "新启动流水线",
                          };
                          return [value.toLocaleString("zh-CN"), map[name] ?? name];
                        }}
                      />
                      <Bar
                        dataKey="step_executions"
                        name="step_executions"
                        fill="var(--color-info)"
                        radius={[2, 2, 0, 0]}
                        maxBarSize={22}
                        fillOpacity={0.82}
                      />
                      <Area
                        type="monotone"
                        dataKey="llm_calls"
                        name="llm_calls"
                        stroke="var(--color-primary)"
                        strokeWidth={2}
                        fill="url(#sdfCallsGrad)"
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={data.daily_trend}
                      margin={{ top: 8, right: 8, left: -8, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="sdfTokensGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--color-primary)" stopOpacity={0.32} />
                          <stop offset="95%" stopColor="var(--color-primary)" stopOpacity={0.0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                      <XAxis
                        dataKey="label"
                        tickLine={false}
                        axisLine={false}
                        tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                      />
                      <YAxis
                        tickFormatter={(v: number) => compactNum(v)}
                        tickLine={false}
                        axisLine={false}
                        tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                      />
                      <RechartsTooltip
                        contentStyle={{
                          backgroundColor: "var(--color-panel)",
                          borderColor: "var(--color-border)",
                          borderRadius: "6px",
                          fontSize: "12px",
                        }}
                        formatter={(value: number) => [`${value.toLocaleString("zh-CN")} Tokens`, "算力消耗"]}
                      />
                      <Area
                        type="monotone"
                        dataKey="tokens"
                        stroke="var(--color-primary)"
                        strokeWidth={2.2}
                        fill="url(#sdfTokensGrad)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
                <div className="flex items-center gap-4">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2.5 rounded-[2px] bg-primary" aria-hidden />
                    <span>{chartMode === "activity" ? "模型调用次数" : "每日 Token 消耗"}</span>
                  </span>
                  {chartMode === "activity" && (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2.5 rounded-[2px] bg-info" aria-hidden />
                      <span>流水线步骤执行</span>
                    </span>
                  )}
                </div>
                <span className="font-mono text-[11px] tabular-nums">
                  提示词 {compactNum(data.kpis.llm_prompt_tokens)} · 生成{" "}
                  {compactNum(data.kpis.llm_completion_tokens)}
                </span>
              </div>
            </section>

            {/* 右：SDLC 全链路工程资产漏斗 + 阶段平均耗时 */}
            <section className="panel-surface flex flex-col justify-between rounded-md p-5 lg:col-span-5">
              <div>
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <p className="stencil text-[10px] text-primary">SDLC ASSET PIPELINE</p>
                    <h2 className="mt-0.5 text-base font-semibold text-foreground">
                      工程资产沉淀与各阶段耗时
                    </h2>
                  </div>
                  <span className="rounded-xs border border-border bg-muted/50 px-2 py-0.5 font-mono text-[11px] text-muted-foreground tabular-nums">
                    完成任务 {data.kpis.tasks_done}/{data.kpis.tasks_total}
                  </span>
                </div>

                <div className="space-y-2.5">
                  {data.sdlc_funnel.map((item, idx) => {
                    const pct = Math.max(4, Math.round((item.count / maxFunnel) * 100));
                    return (
                      <div key={item.key} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-foreground">
                            <span className="mr-1.5 font-mono text-[10px] text-muted-foreground">
                              0{idx + 1}
                            </span>
                            {item.label}
                          </span>
                          <span className="font-mono font-semibold text-foreground tabular-nums">
                            {item.count.toLocaleString("zh-CN")}
                          </span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-xs bg-muted">
                          <div
                            className="h-full rounded-xs bg-primary/85 transition-all"
                            style={{ width: `${item.count === 0 ? 0 : pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="mt-4 border-t border-border pt-3">
                <div className="stencil mb-2 text-[10px] text-muted-foreground">
                  STAGE AVG STEP DURATION · 阶段单步均耗
                </div>
                <div className="grid grid-cols-3 gap-px overflow-hidden rounded-sm border border-border bg-border sm:grid-cols-6 lg:grid-cols-3">
                  {data.stage_lead_time.map((st) => (
                    <div key={st.stage} className="bg-panel px-2.5 py-2">
                      <div className="text-[11px] text-muted-foreground">{st.stage}</div>
                      <div className="mt-0.5 font-mono text-xs font-semibold text-foreground tabular-nums">
                        {st.samples > 0 ? `${st.avg_minutes}m` : "—"}
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground tabular-nums">
                        {st.samples} 步
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>

          {/* 第三层：受管项目全景健康度矩阵 */}
          <section className="panel-surface overflow-hidden rounded-md" aria-label="项目健康度矩阵">
            <div className="flex flex-col justify-between gap-3 border-b border-border px-5 py-4 lg:flex-row lg:items-center">
              <div>
                <p className="stencil text-[10px] text-primary">PORTFOLIO HEALTH MATRIX</p>
                <h2 className="mt-0.5 text-base font-semibold text-foreground">
                  项目全景健康度矩阵（{filteredApps.length}/{data.apps.length}）
                </h2>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-sm border border-border bg-background p-0.5 text-xs">
                  {(
                    [
                      ["all", `全部 (${data.apps.length})`],
                      ["attention", `需关注 (${attentionCount})`],
                      ["development", `开发期 (${data.kpis.apps_dev})`],
                      ["maintenance", `维护期 (${data.kpis.apps_maint})`],
                    ] as [PortfolioFilter, string][]
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setPortfolioFilter(key)}
                      className={cn(
                        "rounded-xs px-2.5 py-1 font-medium transition-colors",
                        portfolioFilter === key
                          ? "bg-panel text-foreground shadow-2xs"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="检索项目名称…"
                    className="h-8 w-44 pl-8 text-xs"
                  />
                </div>

                <Button asChild size="sm" variant="outline">
                  <Link to="/apps">
                    <Plus className="size-3.5" />
                    <span>管理应用</span>
                  </Link>
                </Button>
              </div>
            </div>

            {filteredApps.length === 0 ? (
              <div className="p-10 text-center text-sm text-muted-foreground">
                当前筛选条件下没有匹配的应用项目。
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/45 text-xs text-muted-foreground">
                      <th className="px-5 py-2.5 font-medium">态势</th>
                      <th className="px-4 py-2.5 font-medium">应用项目 / 安全策略</th>
                      <th className="px-4 py-2.5 font-medium">最近流水线进度</th>
                      <th className="px-4 py-2.5 font-medium">工程资产沉淀</th>
                      <th className="px-4 py-2.5 font-medium">治理积压与门禁</th>
                      <th className="px-5 py-2.5 text-right font-medium">钻取</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredApps.map((app) => {
                      const hm = HEALTH_META[app.health];
                      const lr = app.latest_run;
                      const stepPct =
                        lr && lr.steps_total > 0
                          ? Math.round((lr.steps_done / lr.steps_total) * 100)
                          : 0;
                      return (
                        <tr
                          key={app.id}
                          className="transition-colors hover:bg-muted/30"
                        >
                          <td className="whitespace-nowrap px-5 py-3.5">
                            <span
                              className={cn(
                                "inline-flex items-center gap-1.5 rounded-xs border px-2 py-0.5 text-xs font-medium",
                                hm.badge,
                              )}
                            >
                              <span className={cn("size-1.5 rounded-full", hm.dot)} aria-hidden />
                              {hm.label}
                            </span>
                          </td>

                          <td className="min-w-60 px-4 py-3.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Link
                                to="/apps/$appId"
                                params={{ appId: app.id }}
                                className="font-semibold text-foreground transition-colors hover:text-primary"
                              >
                                {app.name}
                              </Link>
                              {app.source === "seed" && (
                                <Badge variant="outline" className="text-[10px]">
                                  示例
                                </Badge>
                              )}
                              <Badge variant={app.phase === "maintenance" ? "secondary" : "default"}>
                                {PHASE_LABEL[app.phase]}
                              </Badge>
                              <span className="rounded-xs border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
                                {app.current_version ?? "未发布"}
                              </span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                              <span className="inline-flex items-center gap-1">
                                <Shield className="size-3" />
                                密级：{CLASS_LABEL[app.classification]}
                              </span>
                              <span>{app.redact_before_llm ? "PII 脱敏开启" : "未开脱敏"}</span>
                              <span>成员 {app.member_count}</span>
                            </div>
                          </td>

                          <td className="min-w-56 px-4 py-3.5">
                            {lr ? (
                              <Link
                                to="/apps/$appId/runs/$runId"
                                params={{ appId: app.id, runId: lr.id }}
                                className="group block space-y-1.5"
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="rounded-xs bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-primary">
                                    {lr.code}
                                  </span>
                                  <span className="text-xs font-medium text-foreground group-hover:text-primary">
                                    {lr.workflow_name}
                                  </span>
                                  <StatusBadge status={lr.status} />
                                </div>
                                <div className="flex items-center gap-2">
                                  <div className="h-1.5 w-28 overflow-hidden rounded-full bg-muted">
                                    <div
                                      className="h-full bg-primary transition-all"
                                      style={{ width: `${stepPct}%` }}
                                    />
                                  </div>
                                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                                    {lr.steps_done}/{lr.steps_total} 步
                                  </span>
                                </div>
                              </Link>
                            ) : (
                              <span className="text-xs text-muted-foreground">尚未启动工作流</span>
                            )}
                          </td>

                          <td className="whitespace-nowrap px-4 py-3.5 font-mono text-xs tabular-nums">
                            <div className="text-foreground">
                              {app.req_count} REQ · {app.ac_count} AC · {app.tc_count} TC
                            </div>
                            <div className="mt-0.5 text-[11px] text-muted-foreground">
                              资料 {app.source_count} · 任务 {app.task_done_count}/{app.task_count}
                            </div>
                          </td>

                          <td className="min-w-52 px-4 py-3.5">
                            <div className="flex flex-wrap gap-1.5">
                              {app.waiting_steps > 0 && (
                                <span className="rounded-xs border border-warning/50 bg-warning/15 px-1.5 py-0.5 font-mono text-[11px] font-medium text-foreground tabular-nums">
                                  待拍板 {app.waiting_steps}
                                </span>
                              )}
                              {app.open_blockers > 0 && (
                                <span className="rounded-xs border border-destructive/45 bg-destructive/12 px-1.5 py-0.5 font-mono text-[11px] font-medium text-destructive tabular-nums">
                                  阻断 {app.open_blockers}
                                </span>
                              )}
                              {app.open_questions > 0 && (
                                <span className="rounded-xs border border-border bg-muted/70 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground tabular-nums">
                                  待澄清 {app.open_questions}
                                </span>
                              )}
                              {app.gates.failed > 0 && (
                                <span className="rounded-xs border border-destructive/45 bg-destructive/12 px-1.5 py-0.5 font-mono text-[11px] font-medium text-destructive tabular-nums">
                                  门禁未过 {app.gates.failed}
                                </span>
                              )}
                              {app.open_feedback > 0 && (
                                <span className="rounded-xs border border-info/40 bg-info/10 px-1.5 py-0.5 font-mono text-[11px] text-info tabular-nums">
                                  反馈 {app.open_feedback}
                                </span>
                              )}
                              {app.waiting_steps === 0 &&
                                app.open_blockers === 0 &&
                                app.open_questions === 0 &&
                                app.gates.failed === 0 &&
                                app.open_feedback === 0 && (
                                  <span className="text-xs text-muted-foreground">无积压阻塞</span>
                                )}
                            </div>
                          </td>

                          <td className="whitespace-nowrap px-5 py-3.5 text-right">
                            <Button asChild size="sm" variant="ghost">
                              <Link to="/apps/$appId" params={{ appId: app.id }}>
                                <span>进入</span>
                                <ArrowUpRight className="size-3.5" />
                              </Link>
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* 第四层：三栏战术治理台（风险雷达 / 智能体军团 / 基础设施与审计流） */}
          <div className="grid gap-5 lg:grid-cols-12">
            {/* 左：待拍板与风险雷达 */}
            <section className="panel-surface flex flex-col justify-between rounded-md p-5 lg:col-span-4">
              <div>
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <p className="stencil text-[10px] text-primary">GOVERNANCE RADAR</p>
                    <h2 className="mt-0.5 text-base font-semibold text-foreground">
                      待拍板与异常雷达
                    </h2>
                  </div>
                  <AlertTriangle className="size-4 text-primary/80" />
                </div>

                {data.alerts.length === 0 ? (
                  <div className="rounded-sm border border-dashed border-border bg-muted/25 p-6 text-center">
                    <CheckCircle2 className="mx-auto size-6 text-success" />
                    <p className="mt-2 text-sm font-medium text-foreground">全厂运行平稳</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      当前没有失败运行、未决阻断问题或待拍板积压
                    </p>
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {data.alerts.slice(0, 7).map((item) => {
                      const stripe =
                        item.severity === "critical"
                          ? "border-l-destructive bg-destructive/5"
                          : item.severity === "warning"
                            ? "border-l-warning bg-warning/5"
                            : "border-l-info bg-info/5";
                      const inner = (
                        <div
                          className={cn(
                            "rounded-sm border border-border border-l-2 p-2.5 transition-colors hover:border-primary/50",
                            stripe,
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="stencil text-[10px] font-semibold text-foreground">
                              {item.kind}
                            </span>
                            <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                              {since(item.created_at)}前
                            </span>
                          </div>
                          <div className="mt-1 truncate text-xs font-medium text-foreground">
                            {item.title}
                          </div>
                          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                            {item.subtitle}
                          </div>
                        </div>
                      );
                      if (item.app_id && item.run_id) {
                        return (
                          <li key={item.id}>
                            <Link
                              to="/apps/$appId/runs/$runId"
                              params={{ appId: item.app_id, runId: item.run_id }}
                            >
                              {inner}
                            </Link>
                          </li>
                        );
                      }
                      if (item.app_id) {
                        return (
                          <li key={item.id}>
                            <Link to="/apps/$appId" params={{ appId: item.app_id }}>
                              {inner}
                            </Link>
                          </li>
                        );
                      }
                      return (
                        <li key={item.id}>
                          <Link to="/connectors">{inner}</Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <div className="mt-4 border-t border-border pt-3 text-right">
                <Link
                  to="/inbox"
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  <span>打开治理待办中心</span>
                  <ArrowUpRight className="size-3.5" />
                </Link>
              </div>
            </section>

            {/* 中：10 个智能体角色效能榜 */}
            <section className="panel-surface flex flex-col justify-between rounded-md p-5 lg:col-span-4">
              <div>
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <p className="stencil text-[10px] text-primary">AGENT FLEET TELEMETRY</p>
                    <h2 className="mt-0.5 text-base font-semibold text-foreground">
                      十角色智能体效能榜
                    </h2>
                  </div>
                  <Bot className="size-4 text-primary/80" />
                </div>

                <ul className="space-y-2.5">
                  {data.agents.slice(0, 8).map((ag) => {
                    const widthPct = ag.tokens > 0 ? Math.max(6, Math.round((ag.tokens / maxAgentTokens) * 100)) : 0;
                    return (
                      <li key={ag.key} className="space-y-1">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate font-medium text-foreground">{ag.name}</span>
                            <span className="rounded-xs border border-border bg-muted/60 px-1 py-0 font-mono text-[10px] text-muted-foreground">
                              v{ag.version}
                            </span>
                          </div>
                          <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                            {ag.calls} 次 · {compactNum(ag.tokens)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-primary/80 transition-all"
                              style={{ width: `${widthPct}%` }}
                            />
                          </div>
                          <span className="w-14 text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                            {ag.approved + ag.rejected > 0
                              ? `${ag.approved}过/${ag.rejected}退`
                              : `成 ${ag.succeeded}`}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>

              <div className="mt-4 border-t border-border pt-3 text-right">
                <Link
                  to="/agents"
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  <span>配置角色系统提示词</span>
                  <ArrowUpRight className="size-3.5" />
                </Link>
              </div>
            </section>

            {/* 右：工厂底座就绪度 + 模型路由 + 实时审计流 */}
            <section className="panel-surface flex flex-col justify-between rounded-md p-5 lg:col-span-4">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="stencil text-[10px] text-primary">INFRASTRUCTURE & AUDIT</p>
                    <h2 className="mt-0.5 text-base font-semibold text-foreground">
                      底座路由与实时审计流
                    </h2>
                  </div>
                  <Activity className="size-4 text-primary/80" />
                </div>

                <div className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-border bg-border">
                  <div className="bg-panel p-2.5">
                    <div className="stencil text-[10px] text-muted-foreground">BLOCKS · 积木就绪</div>
                    <div className="mt-0.5 font-mono text-sm font-semibold text-foreground tabular-nums">
                      {data.infrastructure.blocks_implemented}/{data.infrastructure.blocks_total}
                    </div>
                  </div>
                  <div className="bg-panel p-2.5">
                    <div className="stencil text-[10px] text-muted-foreground">WORKFLOWS · 可启动</div>
                    <div className="mt-0.5 font-mono text-sm font-semibold text-foreground tabular-nums">
                      {data.infrastructure.workflows_startable} 条
                    </div>
                  </div>
                  <div className="bg-panel p-2.5">
                    <div className="stencil text-[10px] text-muted-foreground">CONNECTORS · 连接器</div>
                    <div className="mt-0.5 font-mono text-sm font-semibold text-foreground tabular-nums">
                      {data.infrastructure.connectors.healthy}/{data.infrastructure.connectors.total} 正常
                    </div>
                  </div>
                  <div className="bg-panel p-2.5">
                    <div className="stencil text-[10px] text-muted-foreground">USERS · 平台成员</div>
                    <div className="mt-0.5 font-mono text-sm font-semibold text-foreground tabular-nums">
                      {data.infrastructure.users_total} 人
                    </div>
                  </div>
                </div>

                {/* 三档模型路由状态 */}
                <div className="space-y-1.5">
                  <div className="stencil text-[10px] text-muted-foreground">MODEL ROUTING TIERS</div>
                  {(["fast", "standard", "deep"] as const).map((tier) => {
                    const primary = data.infrastructure.routes.find((r) => r.task_tier === tier);
                    return (
                      <div
                        key={tier}
                        className="flex items-center justify-between gap-2 rounded-xs border border-border bg-background/60 px-2.5 py-1.5 text-xs"
                      >
                        <span className="font-mono text-[10px] font-medium text-muted-foreground">
                          {TIER_LABEL[tier]}
                        </span>
                        <span className="truncate font-mono text-[11px] font-medium text-foreground">
                          {primary ? primary.model : "未配置"}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {/* 最近审计事件 */}
                <div className="space-y-1.5">
                  <div className="stencil text-[10px] text-muted-foreground">RECENT GOVERNANCE AUDIT</div>
                  <ul className="space-y-1.5">
                    {data.recent_audit.slice(0, 5).map((ev) => (
                      <li
                        key={ev.id}
                        className="flex items-center justify-between gap-2 border-b border-border/60 pb-1.5 text-xs last:border-b-0 last:pb-0"
                      >
                        <div className="min-w-0 truncate">
                          <span className="font-medium text-foreground">{ev.actor_name}</span>
                          <span className="mx-1 text-muted-foreground">·</span>
                          <span className="font-mono text-[11px] text-primary">{ev.action}</span>
                          {ev.app_name && (
                            <span className="ml-1 text-[11px] text-muted-foreground">
                              ({ev.app_name})
                            </span>
                          )}
                        </div>
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                          {since(ev.created_at)}前
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="mt-4 border-t border-border pt-3 text-right">
                <Link
                  to="/admin"
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  <span>查看全部审计与模型设置</span>
                  <ArrowUpRight className="size-3.5" />
                </Link>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="正在加载全局指挥大盘">
      <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-32 animate-pulse bg-panel p-5" />
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-12">
        <div className="panel-surface h-80 animate-pulse rounded-md lg:col-span-7" />
        <div className="panel-surface h-80 animate-pulse rounded-md lg:col-span-5" />
      </div>
      <div className="panel-surface h-64 animate-pulse rounded-md" />
    </div>
  );
}
