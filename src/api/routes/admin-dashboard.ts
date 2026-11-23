// 管理员全局治理大盘聚合接口：按时间窗口与示例过滤维度只读汇总全厂应用、流水线、质量门禁、智能体与算力遥测。
import { Hono } from "hono";
import { z } from "zod";
import { API_VERSION } from "@/core/meta";
import { ROLE_OF_BLOCK } from "@/core/agents";
import { IMPLEMENTED_BLOCKS } from "@/core/blocks";
import { serviceQuery } from "@/adapters/pg-client";
import { requireAdmin } from "../middleware";
import type { AppEnv } from "../context";

export const adminDashboardRoutes = new Hono<AppEnv>();

adminDashboardRoutes.use("/admin/*", requireAdmin);

const querySchema = z.object({
  days: z.coerce.number().int().min(7).max(90).default(14),
  include_seed: z.enum(["0", "1", "true", "false"]).default("1"),
});

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export interface AdminDashboardResponse {
  generated_at: string;
  api_version: string;
  window_days: number;
  include_seed: boolean;
  kpis: {
    apps_total: number;
    apps_user: number;
    apps_seed: number;
    apps_dev: number;
    apps_maint: number;
    apps_released: number;
    apps_redacted: number;
    runs_total: number;
    runs_active: number;
    runs_running: number;
    runs_waiting_human: number;
    runs_waiting_event: number;
    runs_waiting_model: number;
    runs_completed: number;
    runs_failed: number;
    median_cycle_hours: number | null;
    checkpoints_waiting: number;
    changes_pending: number;
    approval_rate: number | null;
    approved_steps: number;
    decided_steps: number;
    open_blockers: number;
    open_questions: number;
    open_feedback: number;
    sources_total: number;
    reqs_total: number;
    acs_total: number;
    tcs_total: number;
    ac_coverage_pct: number;
    tasks_total: number;
    tasks_done: number;
    releases_total: number;
    gates_passed: number;
    gates_failed: number;
    gates_waived: number;
    gates_not_executed: number;
    llm_calls: number;
    llm_success_rate: number | null;
    llm_tokens: number;
    llm_prompt_tokens: number;
    llm_completion_tokens: number;
    llm_avg_latency_ms: number;
    llm_redacted_calls: number;
  };
  daily_trend: {
    date: string;
    label: string;
    llm_calls: number;
    llm_errors: number;
    tokens: number;
    step_executions: number;
    runs_started: number;
  }[];
  sdlc_funnel: {
    key: string;
    label: string;
    count: number;
  }[];
  stage_lead_time: {
    stage: string;
    samples: number;
    avg_minutes: number;
  }[];
  apps: {
    id: string;
    name: string;
    description: string;
    phase: "development" | "maintenance";
    classification: "public" | "internal" | "sensitive" | "confidential";
    redact_before_llm: boolean;
    current_version: string | null;
    source: "user" | "seed";
    created_at: string;
    updated_at: string;
    member_count: number;
    source_count: number;
    req_count: number;
    ac_count: number;
    tc_count: number;
    ac_covered_count: number;
    task_count: number;
    task_done_count: number;
    release_count: number;
    open_blockers: number;
    open_questions: number;
    open_feedback: number;
    waiting_steps: number;
    gates: { passed: number; failed: number; waived: number; not_executed: number };
    latest_run: {
      id: string;
      code: string;
      status: string;
      weight: string;
      started_at: string;
      finished_at: string | null;
      workflow_name: string;
      workflow_version: string;
      steps_total: number;
      steps_done: number;
    } | null;
    health: "healthy" | "attention" | "blocked";
  }[];
  alerts: {
    id: string;
    severity: "critical" | "warning" | "info";
    kind: string;
    title: string;
    subtitle: string;
    app_id: string | null;
    app_name: string | null;
    run_id: string | null;
    created_at: string;
  }[];
  agents: {
    key: string;
    name: string;
    version: number;
    calls: number;
    tokens: number;
    succeeded: number;
    approved: number;
    rejected: number;
  }[];
  infrastructure: {
    blocks_implemented: number;
    blocks_total: number;
    workflows_startable: number;
    users_total: number;
    providers: {
      id: string;
      name: string;
      enabled: boolean;
      allowed_for_sensitive: boolean;
      last_status: string;
    }[];
    routes: {
      task_tier: "fast" | "standard" | "deep";
      model: string;
      fallback_order: number;
      provider_name: string;
    }[];
    connectors: {
      total: number;
      healthy: number;
      error: number;
      untested: number;
    };
  };
  recent_audit: {
    id: string;
    action: string;
    actor_name: string;
    app_name: string | null;
    target_type: string | null;
    created_at: string;
  }[];
}

adminDashboardRoutes.get("/admin/dashboard", async (c) => {
  const parsed = querySchema.parse({
    days: c.req.query("days"),
    include_seed: c.req.query("include_seed"),
  });
  const days = parsed.days;
  const includeSeed = parsed.include_seed === "1" || parsed.include_seed === "true";
  const sql = serviceQuery();

  // 并行拉取全厂各域统计，避免串行数据库往返
  const [
    appRows,
    gateRows,
    runSummaryRows,
    decisionRows,
    llmRows,
    trendRows,
    stageRows,
    roleRows,
    stepAgentRows,
    waitingRows,
    pendingCrRows,
    blockerRows,
    failedRunRows,
    providerRows,
    routeRows,
    connectorRows,
    metaCountsRows,
    auditRows,
  ] = await Promise.all([
    sql(
      `SELECT a.id, a.name, a.description, a.phase, a.classification, a.redact_before_llm,
              a.current_version, a.source, a.created_at, a.updated_at,
              (SELECT count(*)::int FROM public.app_members m WHERE m.app_id = a.id) AS member_count,
              (SELECT count(*)::int FROM public.sources s WHERE s.app_id = a.id AND s.parse_status = 'parsed') AS source_count,
              (SELECT count(*)::int FROM public.requirements r WHERE r.app_id = a.id AND r.status <> 'deprecated') AS req_count,
              (SELECT count(*)::int FROM public.acceptance_criteria ac WHERE ac.app_id = a.id) AS ac_count,
              (SELECT count(*)::int FROM public.test_cases tc WHERE tc.app_id = a.id) AS tc_count,
              (SELECT count(DISTINCT tc.ac_code)::int FROM public.test_cases tc WHERE tc.app_id = a.id) AS ac_covered_count,
              (SELECT count(*)::int FROM public.tasks t WHERE t.app_id = a.id) AS task_count,
              (SELECT count(*)::int FROM public.tasks t WHERE t.app_id = a.id AND t.status = 'done') AS task_done_count,
              (SELECT count(*)::int FROM public.releases rel WHERE rel.app_id = a.id) AS release_count,
              (SELECT count(*)::int FROM public.analysis_findings f WHERE f.app_id = a.id AND f.severity = 'blocker' AND f.status = 'open') AS open_blockers,
              (SELECT count(*)::int FROM public.clarification_questions q WHERE q.app_id = a.id AND q.status = 'open') AS open_questions,
              (SELECT count(*)::int FROM public.feedback_items fb WHERE fb.app_id = a.id AND fb.status IN ('open','triaged')) AS open_feedback,
              (SELECT count(*)::int FROM public.step_runs sr WHERE sr.app_id = a.id AND sr.is_current AND sr.status = 'waiting_human') AS waiting_steps,
              lr.run_id, lr.run_code, lr.run_status, lr.run_weight, lr.run_started_at, lr.run_finished_at,
              lr.workflow_name, lr.workflow_version, lr.steps_total, lr.steps_done
       FROM public.apps a
       LEFT JOIN LATERAL (
         SELECT r.id AS run_id, r.code AS run_code, r.status AS run_status, r.weight AS run_weight,
                r.started_at AS run_started_at, r.finished_at AS run_finished_at,
                w.name AS workflow_name, w.version AS workflow_version,
                (SELECT count(*)::int FROM public.step_runs sr WHERE sr.run_id = r.id AND sr.is_current AND sr.status <> 'skipped') AS steps_total,
                (SELECT count(*)::int FROM public.step_runs sr WHERE sr.run_id = r.id AND sr.is_current AND sr.status = 'succeeded') AS steps_done
         FROM public.workflow_runs r
         JOIN public.workflows w ON w.id = r.workflow_id
         WHERE r.app_id = a.id
         ORDER BY r.started_at DESC
         LIMIT 1
       ) lr ON true
       WHERE ($1::boolean OR a.source = 'user')
       ORDER BY a.updated_at DESC, a.created_at DESC`,
      [includeSeed],
    ),
    sql(
      `SELECT DISTINCT ON (g.app_id, g.item_key)
              g.app_id, g.item_key, g.status, g.waiver_reason
       FROM public.gate_results g
       JOIN public.apps a ON a.id = g.app_id
       WHERE ($1::boolean OR a.source = 'user')
       ORDER BY g.app_id, g.item_key, g.created_at DESC`,
      [includeSeed],
    ),
    sql(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE r.status IN ('running','waiting_human','waiting_event','waiting_model'))::int AS active,
              count(*) FILTER (WHERE r.status = 'running')::int AS running,
              count(*) FILTER (WHERE r.status = 'waiting_human')::int AS waiting_human,
              count(*) FILTER (WHERE r.status = 'waiting_event')::int AS waiting_event,
              count(*) FILTER (WHERE r.status = 'waiting_model')::int AS waiting_model,
              count(*) FILTER (WHERE r.status = 'completed')::int AS completed,
              count(*) FILTER (WHERE r.status = 'failed')::int AS failed,
              ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (r.finished_at - r.started_at)) / 3600.0)
                FILTER (WHERE r.status = 'completed' AND r.finished_at IS NOT NULL))::numeric, 2) AS median_cycle_hours
       FROM public.workflow_runs r
       JOIN public.apps a ON a.id = r.app_id
       WHERE ($1::boolean OR a.source = 'user')`,
      [includeSeed],
    ),
    sql(
      `SELECT count(*) FILTER (WHERE s.decision = 'approve')::int AS approved,
              count(*) FILTER (WHERE s.decision = 'reject')::int AS rejected,
              count(*) FILTER (WHERE s.decision IS NOT NULL)::int AS decided,
              (SELECT count(*)::int FROM public.change_requests cr JOIN public.apps a2 ON a2.id = cr.app_id
               WHERE cr.status = 'pending_confirm' AND ($1::boolean OR a2.source = 'user')) AS changes_pending
       FROM public.step_runs s
       JOIN public.apps a ON a.id = s.app_id
       WHERE ($1::boolean OR a.source = 'user')`,
      [includeSeed],
    ),
    sql(
      `SELECT count(*)::int AS total_calls,
              count(*) FILTER (WHERE c.status = 'success')::int AS success_calls,
              count(*) FILTER (WHERE c.redacted)::int AS redacted_calls,
              COALESCE(sum(c.total_tokens), 0)::bigint AS total_tokens,
              COALESCE(sum(c.prompt_tokens), 0)::bigint AS prompt_tokens,
              COALESCE(sum(c.completion_tokens), 0)::bigint AS completion_tokens,
              COALESCE(ROUND(avg(c.duration_ms) FILTER (WHERE c.status = 'success')), 0)::int AS avg_latency_ms
       FROM public.llm_calls c
       LEFT JOIN public.apps a ON a.id = c.app_id
       WHERE c.created_at >= now() - ($1::int * interval '1 day')
         AND ($2::boolean OR c.app_id IS NULL OR a.source = 'user')`,
      [days, includeSeed],
    ),
    sql(
      `WITH days AS (
         SELECT generate_series(
           (current_date - ($1::int - 1) * interval '1 day')::date,
           current_date,
           interval '1 day'
         )::date AS day
       ),
       llm AS (
         SELECT (c.created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
                count(*)::int AS llm_calls,
                count(*) FILTER (WHERE c.status = 'error')::int AS llm_errors,
                COALESCE(sum(c.total_tokens), 0)::bigint AS tokens
         FROM public.llm_calls c
         LEFT JOIN public.apps a ON a.id = c.app_id
         WHERE c.created_at >= current_date - ($1::int + 1) * interval '1 day'
           AND ($2::boolean OR c.app_id IS NULL OR a.source = 'user')
         GROUP BY 1
       ),
       steps AS (
         SELECT (COALESCE(s.finished_at, s.started_at, s.created_at) AT TIME ZONE 'Asia/Shanghai')::date AS day,
                count(*)::int AS step_executions
         FROM public.step_runs s
         JOIN public.apps a ON a.id = s.app_id
         WHERE COALESCE(s.finished_at, s.started_at, s.created_at) >= current_date - ($1::int + 1) * interval '1 day'
           AND s.status NOT IN ('pending', 'skipped')
           AND ($2::boolean OR a.source = 'user')
         GROUP BY 1
       ),
       runs AS (
         SELECT (r.started_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
                count(*)::int AS runs_started
         FROM public.workflow_runs r
         JOIN public.apps a ON a.id = r.app_id
         WHERE r.started_at >= current_date - ($1::int + 1) * interval '1 day'
           AND ($2::boolean OR a.source = 'user')
         GROUP BY 1
       )
       SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
              to_char(d.day, 'MM-DD') AS label,
              COALESCE(l.llm_calls, 0)::int AS llm_calls,
              COALESCE(l.llm_errors, 0)::int AS llm_errors,
              COALESCE(l.tokens, 0)::bigint AS tokens,
              COALESCE(s.step_executions, 0)::int AS step_executions,
              COALESCE(rn.runs_started, 0)::int AS runs_started
       FROM days d
       LEFT JOIN llm l ON l.day = d.day
       LEFT JOIN steps s ON s.day = d.day
       LEFT JOIN runs rn ON rn.day = d.day
       ORDER BY d.day ASC`,
      [days, includeSeed],
    ),
    sql(
      `SELECT s.stage,
              count(*)::int AS samples,
              ROUND(avg(EXTRACT(EPOCH FROM (s.finished_at - s.started_at)) / 60.0)::numeric, 1) AS avg_minutes
       FROM public.step_runs s
       JOIN public.apps a ON a.id = s.app_id
       WHERE s.status = 'succeeded' AND s.started_at IS NOT NULL AND s.finished_at IS NOT NULL
         AND ($1::boolean OR a.source = 'user')
       GROUP BY s.stage`,
      [includeSeed],
    ),
    sql(
      `SELECT ar.key, ar.name,
              COALESCE((SELECT max(v.version) FROM public.agent_prompt_versions v WHERE v.role_key = ar.key), 1)::int AS version
       FROM public.agent_roles ar
       ORDER BY ar.key`,
      [],
    ),
    sql(
      `SELECT s.block_key,
              count(*) FILTER (WHERE s.status = 'succeeded')::int AS succeeded,
              count(*) FILTER (WHERE s.decision = 'approve')::int AS approved,
              count(*) FILTER (WHERE s.decision = 'reject' OR s.status = 'rejected')::int AS rejected,
              COALESCE(sum(s.model_calls), 0)::int AS calls,
              COALESCE(sum(s.tokens), 0)::bigint AS tokens
       FROM public.step_runs s
       JOIN public.apps a ON a.id = s.app_id
       WHERE ($1::boolean OR a.source = 'user')
       GROUP BY s.block_key`,
      [includeSeed],
    ),
    sql(
      `SELECT sr.id, sr.step_key, sr.block_key, sr.checkpoint, sr.created_at,
              r.id AS run_id, r.code AS run_code, a.id AS app_id, a.name AS app_name,
              w.name AS workflow_name
       FROM public.step_runs sr
       JOIN public.workflow_runs r ON r.id = sr.run_id
       JOIN public.apps a ON a.id = sr.app_id
       JOIN public.workflows w ON w.id = r.workflow_id
       WHERE sr.is_current AND sr.status = 'waiting_human'
         AND ($1::boolean OR a.source = 'user')
       ORDER BY sr.created_at ASC
       LIMIT 8`,
      [includeSeed],
    ),
    sql(
      `SELECT cr.id, cr.code, cr.title, cr.created_at, a.id AS app_id, a.name AS app_name
       FROM public.change_requests cr
       JOIN public.apps a ON a.id = cr.app_id
       WHERE cr.status = 'pending_confirm'
         AND ($1::boolean OR a.source = 'user')
       ORDER BY cr.created_at ASC
       LIMIT 6`,
      [includeSeed],
    ),
    sql(
      `SELECT f.id, f.code, f.category, f.description, f.created_at, a.id AS app_id, a.name AS app_name, f.run_id
       FROM public.analysis_findings f
       JOIN public.apps a ON a.id = f.app_id
       WHERE f.severity = 'blocker' AND f.status = 'open'
         AND ($1::boolean OR a.source = 'user')
       ORDER BY f.created_at DESC
       LIMIT 6`,
      [includeSeed],
    ),
    sql(
      `SELECT r.id, r.code, r.current_step_key, r.started_at, a.id AS app_id, a.name AS app_name, w.name AS workflow_name
       FROM public.workflow_runs r
       JOIN public.apps a ON a.id = r.app_id
       JOIN public.workflows w ON w.id = r.workflow_id
       WHERE r.status = 'failed'
         AND ($1::boolean OR a.source = 'user')
       ORDER BY r.started_at DESC
       LIMIT 5`,
      [includeSeed],
    ),
    sql(
      `SELECT id, name, enabled, allowed_for_sensitive, last_status
       FROM public.llm_providers
       ORDER BY priority ASC, created_at ASC`,
      [],
    ),
    sql(
      `SELECT mr.task_tier, mr.model, mr.fallback_order, lp.name AS provider_name
       FROM public.model_routes mr
       JOIN public.llm_providers lp ON lp.id = mr.provider_id
       ORDER BY mr.task_tier ASC, mr.fallback_order ASC`,
      [],
    ),
    sql(
      `SELECT id, name, vendor, capability, status, last_error, created_at
       FROM public.connectors
       ORDER BY created_at DESC`,
      [],
    ),
    sql(
      `SELECT (SELECT count(*)::int FROM public.apps) AS all_apps,
              (SELECT count(*)::int FROM public.apps WHERE source = 'user') AS user_apps,
              (SELECT count(*)::int FROM public.apps WHERE source = 'seed') AS seed_apps,
              (SELECT count(*)::int FROM public.example_catalog WHERE kind = 'block') AS blocks_total,
              (SELECT count(*)::int FROM public.workflows WHERE startable = true) AS workflows_startable,
              (SELECT count(*)::int FROM public.profiles) AS users_total`,
      [],
    ),
    sql(
      `SELECT al.id::text AS id, al.action, al.target_type, al.created_at,
              COALESCE(p.display_name, p.email, '系统任务') AS actor_name,
              a.name AS app_name
       FROM public.audit_logs al
       LEFT JOIN public.profiles p ON p.id = al.actor_id
       LEFT JOIN public.apps a ON a.id = al.app_id
       ORDER BY al.created_at DESC
       LIMIT 10`,
      [],
    ),
  ]);

  // 按应用聚合门禁最新状态
  const gateByApp = new Map<string, { passed: number; failed: number; waived: number; not_executed: number }>();
  let gatesPassed = 0;
  let gatesFailed = 0;
  let gatesWaived = 0;
  let gatesNotExecuted = 0;
  for (const row of gateRows) {
    const appId = String(row["app_id"]);
    const g = gateByApp.get(appId) ?? { passed: 0, failed: 0, waived: 0, not_executed: 0 };
    const waived = Boolean(row["waiver_reason"]);
    const st = String(row["status"] ?? "NOT_EXECUTED");
    if (waived) {
      g.waived += 1;
      gatesWaived += 1;
    } else if (st === "PASSED") {
      g.passed += 1;
      gatesPassed += 1;
    } else if (st === "FAILED") {
      g.failed += 1;
      gatesFailed += 1;
    } else {
      g.not_executed += 1;
      gatesNotExecuted += 1;
    }
    gateByApp.set(appId, g);
  }

  let sourcesTotal = 0;
  let reqsTotal = 0;
  let acsTotal = 0;
  let tcsTotal = 0;
  let acCoveredTotal = 0;
  let tasksTotal = 0;
  let tasksDone = 0;
  let releasesTotal = 0;
  let openBlockersTotal = 0;
  let openQuestionsTotal = 0;
  let openFeedbackTotal = 0;
  let checkpointsWaiting = 0;
  let appsDev = 0;
  let appsMaint = 0;
  let appsReleased = 0;
  let appsRedacted = 0;

  const apps: AdminDashboardResponse["apps"] = appRows.map((row) => {
    const id = String(row["id"]);
    const phase = row["phase"] === "maintenance" ? "maintenance" : "development";
    const redact = Boolean(row["redact_before_llm"]);
    const currentVersion = typeof row["current_version"] === "string" && row["current_version"] ? row["current_version"] : null;
    if (phase === "maintenance") appsMaint += 1;
    else appsDev += 1;
    if (currentVersion) appsReleased += 1;
    if (redact) appsRedacted += 1;

    const sourceCount = num(row["source_count"]);
    const reqCount = num(row["req_count"]);
    const acCount = num(row["ac_count"]);
    const tcCount = num(row["tc_count"]);
    const acCoveredCount = num(row["ac_covered_count"]);
    const taskCount = num(row["task_count"]);
    const taskDoneCount = num(row["task_done_count"]);
    const releaseCount = num(row["release_count"]);
    const openBlockers = num(row["open_blockers"]);
    const openQuestions = num(row["open_questions"]);
    const openFeedback = num(row["open_feedback"]);
    const waitingSteps = num(row["waiting_steps"]);

    sourcesTotal += sourceCount;
    reqsTotal += reqCount;
    acsTotal += acCount;
    tcsTotal += tcCount;
    acCoveredTotal += acCoveredCount;
    tasksTotal += taskCount;
    tasksDone += taskDoneCount;
    releasesTotal += releaseCount;
    openBlockersTotal += openBlockers;
    openQuestionsTotal += openQuestions;
    openFeedbackTotal += openFeedback;
    checkpointsWaiting += waitingSteps;

    const gates = gateByApp.get(id) ?? { passed: 0, failed: 0, waived: 0, not_executed: 0 };
    const latestRun = row["run_id"]
      ? {
          id: String(row["run_id"]),
          code: String(row["run_code"] ?? ""),
          status: String(row["run_status"] ?? ""),
          weight: String(row["run_weight"] ?? "standard"),
          started_at: new Date(String(row["run_started_at"])).toISOString(),
          finished_at: row["run_finished_at"] ? new Date(String(row["run_finished_at"])).toISOString() : null,
          workflow_name: String(row["workflow_name"] ?? ""),
          workflow_version: String(row["workflow_version"] ?? ""),
          steps_total: num(row["steps_total"]),
          steps_done: num(row["steps_done"]),
        }
      : null;

    let health: "healthy" | "attention" | "blocked" = "healthy";
    if (latestRun?.status === "failed" || openBlockers > 0 || gates.failed > 0) {
      health = "blocked";
    } else if (
      waitingSteps > 0 ||
      openQuestions > 0 ||
      (latestRun && ["waiting_human", "waiting_model", "waiting_event"].includes(latestRun.status))
    ) {
      health = "attention";
    }

    return {
      id,
      name: String(row["name"] ?? ""),
      description: String(row["description"] ?? ""),
      phase,
      classification: (row["classification"] as AdminDashboardResponse["apps"][number]["classification"]) ?? "internal",
      redact_before_llm: redact,
      current_version: currentVersion,
      source: row["source"] === "seed" ? "seed" : "user",
      created_at: new Date(String(row["created_at"])).toISOString(),
      updated_at: new Date(String(row["updated_at"])).toISOString(),
      member_count: num(row["member_count"]),
      source_count: sourceCount,
      req_count: reqCount,
      ac_count: acCount,
      tc_count: tcCount,
      ac_covered_count: acCoveredCount,
      task_count: taskCount,
      task_done_count: taskDoneCount,
      release_count: releaseCount,
      open_blockers: openBlockers,
      open_questions: openQuestions,
      open_feedback: openFeedback,
      waiting_steps: waitingSteps,
      gates,
      latest_run: latestRun,
      health,
    };
  });

  // 按智能体角色汇总模型调用与人工复核通过情况
  const agentStats = new Map<string, { calls: number; tokens: number; succeeded: number; approved: number; rejected: number }>();
  for (const row of stepAgentRows) {
    const roleKey = ROLE_OF_BLOCK[String(row["block_key"] ?? "")];
    if (!roleKey) continue;
    const prev = agentStats.get(roleKey) ?? { calls: 0, tokens: 0, succeeded: 0, approved: 0, rejected: 0 };
    prev.calls += num(row["calls"]);
    prev.tokens += num(row["tokens"]);
    prev.succeeded += num(row["succeeded"]);
    prev.approved += num(row["approved"]);
    prev.rejected += num(row["rejected"]);
    agentStats.set(roleKey, prev);
  }

  const agents: AdminDashboardResponse["agents"] = roleRows
    .map((r) => {
      const key = String(r["key"]);
      const st = agentStats.get(key) ?? { calls: 0, tokens: 0, succeeded: 0, approved: 0, rejected: 0 };
      return {
        key,
        name: String(r["name"] ?? key),
        version: num(r["version"]) || 1,
        ...st,
      };
    })
    .sort((a, b) => b.tokens - a.tokens || b.succeeded - a.succeeded || a.key.localeCompare(b.key));

  // 组装治理与风险雷达（按优先级排序：失败运行 / 阻断问题 / 连接器异常 / 待人工确认 / 待业务确认）
  const alerts: AdminDashboardResponse["alerts"] = [];
  for (const r of failedRunRows) {
    alerts.push({
      id: `failed-run-${String(r["id"])}`,
      severity: "critical",
      kind: "运行失败",
      title: `${String(r["app_name"])} · ${String(r["code"])}（${String(r["workflow_name"])}）`,
      subtitle: r["current_step_key"] ? `停在步骤 ${String(r["current_step_key"])}` : "流水线执行异常中断",
      app_id: String(r["app_id"]),
      app_name: String(r["app_name"]),
      run_id: String(r["id"]),
      created_at: new Date(String(r["started_at"])).toISOString(),
    });
  }
  for (const b of blockerRows) {
    alerts.push({
      id: `blocker-${String(b["id"])}`,
      severity: "critical",
      kind: "阻断问题",
      title: `${String(b["app_name"])} · ${String(b["code"])}（${String(b["category"])}）`,
      subtitle: String(b["description"] ?? "").slice(0, 96),
      app_id: String(b["app_id"]),
      app_name: String(b["app_name"]),
      run_id: b["run_id"] ? String(b["run_id"]) : null,
      created_at: new Date(String(b["created_at"])).toISOString(),
    });
  }
  for (const cn of connectorRows) {
    if (String(cn["status"]) === "error") {
      alerts.push({
        id: `conn-${String(cn["id"])}`,
        severity: "critical",
        kind: "连接器异常",
        title: `${String(cn["name"])}（${String(cn["vendor"])}）连接失败`,
        subtitle: String(cn["last_error"] ?? "凭据失效或目标服务不可达").slice(0, 96),
        app_id: null,
        app_name: null,
        run_id: null,
        created_at: new Date(String(cn["created_at"])).toISOString(),
      });
    }
  }
  for (const w of waitingRows) {
    const cp = (w["checkpoint"] ?? {}) as { role?: string; prompt?: string };
    alerts.push({
      id: `wait-${String(w["id"])}`,
      severity: "warning",
      kind: "待拍板确认",
      title: `${String(w["app_name"])} · ${String(w["run_code"])} · 步骤 ${String(w["step_key"])}（${String(w["block_key"])}）`,
      subtitle: `等待角色「${cp.role ?? "lead"}」复核确认`,
      app_id: String(w["app_id"]),
      app_name: String(w["app_name"]),
      run_id: String(w["run_id"]),
      created_at: new Date(String(w["created_at"])).toISOString(),
    });
  }
  for (const cr of pendingCrRows) {
    alerts.push({
      id: `cr-${String(cr["id"])}`,
      severity: "info",
      kind: "待业务确认",
      title: `${String(cr["app_name"])} · ${String(cr["code"])} ${String(cr["title"])}`,
      subtitle: "变更方案已推送至业务门户等待确认",
      app_id: String(cr["app_id"]),
      app_name: String(cr["app_name"]),
      run_id: null,
      created_at: new Date(String(cr["created_at"])).toISOString(),
    });
  }

  const rs = runSummaryRows[0] ?? {};
  const ds = decisionRows[0] ?? {};
  const ls = llmRows[0] ?? {};
  const mc = metaCountsRows[0] ?? {};

  const decidedSteps = num(ds["decided"]);
  const approvedSteps = num(ds["approved"]);
  const llmCalls = num(ls["total_calls"]);
  const llmSuccess = num(ls["success_calls"]);

  const stageOrder = ["需求", "设计", "质量", "开发", "交付", "文档"];
  const stageMap = new Map<string, { samples: number; avg_minutes: number }>();
  for (const s of stageRows) {
    stageMap.set(String(s["stage"]), {
      samples: num(s["samples"]),
      avg_minutes: num(s["avg_minutes"]),
    });
  }
  const stageLeadTime = stageOrder.map((stage) => ({
    stage,
    samples: stageMap.get(stage)?.samples ?? 0,
    avg_minutes: stageMap.get(stage)?.avg_minutes ?? 0,
  }));

  const body: AdminDashboardResponse = {
    generated_at: new Date().toISOString(),
    api_version: API_VERSION,
    window_days: days,
    include_seed: includeSeed,
    kpis: {
      apps_total: apps.length,
      apps_user: num(mc["user_apps"]),
      apps_seed: num(mc["seed_apps"]),
      apps_dev: appsDev,
      apps_maint: appsMaint,
      apps_released: appsReleased,
      apps_redacted: appsRedacted,
      runs_total: num(rs["total"]),
      runs_active: num(rs["active"]),
      runs_running: num(rs["running"]),
      runs_waiting_human: num(rs["waiting_human"]),
      runs_waiting_event: num(rs["waiting_event"]),
      runs_waiting_model: num(rs["waiting_model"]),
      runs_completed: num(rs["completed"]),
      runs_failed: num(rs["failed"]),
      median_cycle_hours: rs["median_cycle_hours"] != null ? num(rs["median_cycle_hours"]) : null,
      checkpoints_waiting: checkpointsWaiting,
      changes_pending: num(ds["changes_pending"]),
      approval_rate: decidedSteps > 0 ? Math.round((approvedSteps / decidedSteps) * 1000) / 10 : null,
      approved_steps: approvedSteps,
      decided_steps: decidedSteps,
      open_blockers: openBlockersTotal,
      open_questions: openQuestionsTotal,
      open_feedback: openFeedbackTotal,
      sources_total: sourcesTotal,
      reqs_total: reqsTotal,
      acs_total: acsTotal,
      tcs_total: tcsTotal,
      ac_coverage_pct: acsTotal > 0 ? Math.round((acCoveredTotal / acsTotal) * 1000) / 10 : 0,
      tasks_total: tasksTotal,
      tasks_done: tasksDone,
      releases_total: releasesTotal,
      gates_passed: gatesPassed,
      gates_failed: gatesFailed,
      gates_waived: gatesWaived,
      gates_not_executed: gatesNotExecuted,
      llm_calls: llmCalls,
      llm_success_rate: llmCalls > 0 ? Math.round((llmSuccess / llmCalls) * 1000) / 10 : null,
      llm_tokens: num(ls["total_tokens"]),
      llm_prompt_tokens: num(ls["prompt_tokens"]),
      llm_completion_tokens: num(ls["completion_tokens"]),
      llm_avg_latency_ms: num(ls["avg_latency_ms"]),
      llm_redacted_calls: num(ls["redacted_calls"]),
    },
    daily_trend: trendRows.map((t) => ({
      date: String(t["date"]),
      label: String(t["label"]),
      llm_calls: num(t["llm_calls"]),
      llm_errors: num(t["llm_errors"]),
      tokens: num(t["tokens"]),
      step_executions: num(t["step_executions"]),
      runs_started: num(t["runs_started"]),
    })),
    sdlc_funnel: [
      { key: "sources", label: "原始资料 (SRC)", count: sourcesTotal },
      { key: "requirements", label: "需求规格 (REQ)", count: reqsTotal },
      { key: "acceptance_criteria", label: "验收标准 (AC)", count: acsTotal },
      { key: "test_cases", label: "测试用例 (TC)", count: tcsTotal },
      { key: "tasks", label: "开发任务 (TASK)", count: tasksTotal },
      { key: "releases", label: "发布版本 (REL)", count: releasesTotal },
    ],
    stage_lead_time: stageLeadTime,
    apps,
    alerts: alerts.slice(0, 12),
    agents,
    infrastructure: {
      blocks_implemented: IMPLEMENTED_BLOCKS.length,
      blocks_total: num(mc["blocks_total"]) || 33,
      workflows_startable: num(mc["workflows_startable"]),
      users_total: num(mc["users_total"]),
      providers: providerRows.map((p) => ({
        id: String(p["id"]),
        name: String(p["name"]),
        enabled: Boolean(p["enabled"]),
        allowed_for_sensitive: Boolean(p["allowed_for_sensitive"]),
        last_status: String(p["last_status"] ?? "untested"),
      })),
      routes: routeRows.map((rt) => ({
        task_tier: (rt["task_tier"] as "fast" | "standard" | "deep") ?? "standard",
        model: String(rt["model"]),
        fallback_order: num(rt["fallback_order"]),
        provider_name: String(rt["provider_name"]),
      })),
      connectors: {
        total: connectorRows.length,
        healthy: connectorRows.filter((x) => x["status"] === "success").length,
        error: connectorRows.filter((x) => x["status"] === "error").length,
        untested: connectorRows.filter((x) => x["status"] === "untested").length,
      },
    },
    recent_audit: auditRows.map((al) => ({
      id: String(al["id"]),
      action: String(al["action"]),
      actor_name: String(al["actor_name"] ?? "系统").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) => {
        const [local] = email.split("@");
        return local || "成员";
      }),
      app_name: al["app_name"] ? String(al["app_name"]) : null,
      target_type: al["target_type"] ? String(al["target_type"]) : null,
      created_at: new Date(String(al["created_at"])).toISOString(),
    })),
  };

  return c.json(body);
});
