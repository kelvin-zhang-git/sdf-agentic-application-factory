// Engine persistence over server-only SECURITY DEFINER RPCs (service role). Narrow methods only.
import { AppError } from "@/core/errors";
import { resolveRoleKey } from "@/core/agents";
import { decryptSecret } from "@/core/secret-crypto";
import { OpenAICompatibleGateway } from "@/core/model-gateway";
import type { EngineStore, StepContextData, Requirement } from "@/core/engine/types";
import { stampRequirementMarkdown } from "@/core/report-link";
import type { ModelRoute, Classification } from "@/core/llm";
import { processEnv } from "./env";
import { pgSystemOps } from "./pg-system";
import { createServiceDb, serviceQuery } from "./pg-client";
import { commentOnPull, failedTests, flowMetrics, publishHandoff, repoSnapshot, reviewTargets, saveGate } from "./stage2-store";
import { createUat, loadChange, meetingAgenda, plainBusinessSummary, publishRelease, saveChangeSummary, triageFeedback } from "./stage3-store";

async function admin() { return createServiceDb(); }

export function rpcError(error: { message: string; code?: string } | null): void {
  if (!error) return;
  const m = error.message;
  if (m.includes("SDF_LEASE_LOST")) throw new AppError("LEASE_LOST", "步骤已被其他执行者接管");
  if (m.includes("SDF_BLOCKERS_OPEN")) throw new AppError("BLOCKERS_OPEN", "存在未处理的阻断级问题，不能通过");
  if (m.includes("SDF_CONFLICT")) throw new AppError("CONFLICT", "状态已变化，请刷新后重试");
  if (m.includes("SDF_NOT_FOUND")) throw new AppError("NOT_FOUND", "记录不存在");
  if (m.includes("SDF_VALIDATION")) throw new AppError("VALIDATION", "操作不符合规则", { rule: m.replace(/^.*SDF_VALIDATION:?\s*/, "").slice(0, 100) });
  if (m.includes("SDF_REF_CROSS_APP")) throw new AppError("VALIDATION", "引用了不属于本应用的数据");
  if (error.code === "23505") throw new AppError("CONFLICT", "同一运行已有正在执行的步骤");
  throw new AppError("DB_ERROR", "数据库操作失败", { db_code: error.code });
}
type Rpc = (fn: string, args: Record<string, unknown>) => Promise<unknown>;
const rpc: Rpc = async (fn, args) => { const db = await admin(); const { data, error } = await (db.rpc as unknown as Rpc2)(fn, args); rpcError(error); return data; };
type Rpc2 = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;

async function loadRequirements(appId: string): Promise<Requirement[]> {
  const db = await admin();
  const { data, error } = await db.from("requirements").select("id,code,title,story,priority,type,current_version,acceptance_criteria(code,format,text,requirement_version)").eq("app_id", appId).neq("status", "deprecated").order("code");
  rpcError(error);
  return (data ?? []).map((r): Requirement => ({ id: r.id, code: r.code, title: r.title, story: r.story, priority: r.priority, type: r.type,
    criteria: ((r.acceptance_criteria ?? []) as { requirement_version: number; code: string; format: Requirement["criteria"][number]["format"]; text: string }[]).filter((c) => c.requirement_version === r.current_version).map((c) => ({ code: c.code, format: c.format, text: c.text })) }));
}

export const engineStore: EngineStore = {
  async claim(runId, leaseSeconds) {
    const rows = (await rpc("claim_step", { _run: runId, _lease_seconds: leaseSeconds })) as { step_run_id: string; lease_token: string }[] | null;
    const r = rows?.[0]; return r ? { stepId: r.step_run_id, lease: r.lease_token } : null;
  },
  async context(stepId) {
    const db = await admin();
    const s = await db.from("step_runs").select("id,run_id,app_id,step_key,block_key,attempt,cursor_seq,cursor,checkpoint").eq("id", stepId).single();
    if (s.error) rpcError(s.error);
    const [r, a] = await Promise.all([
      db.from("workflow_runs").select("id,code,weight,inputs,trace_id,started_by,workflow_snapshot").eq("id", s.data!.run_id).single(),
      db.from("apps").select("id,name,classification,redact_before_llm,redact_terms").eq("id", s.data!.app_id).single(),
    ]);
    if (r.error) rpcError(r.error); if (a.error) rpcError(a.error);
    return {
      step: s.data as StepContextData["step"],
      run: { ...r.data!, weight: r.data!.weight as StepContextData["run"]["weight"], inputs: (r.data!.inputs ?? {}) as Record<string, unknown>, snapshot: r.data!.workflow_snapshot as StepContextData["run"]["snapshot"] },
      app: { ...a.data!, classification: a.data!.classification as Classification },
    };
  },
  async saveChunk(stepId, lease, cursorSeq, cursor, payload, progress, tokens, calls, release) {
    return (await rpc("save_step_chunk", { _step: stepId, _lease: lease, _cursor_seq: cursorSeq, _cursor: cursor, _payload: payload, _progress: progress, _tokens: tokens, _calls: calls, _release: release })) === true;
  },
  async heartbeat(stepId, lease, progress) { await rpc("heartbeat_step", { _step: stepId, _lease: lease, _progress: progress ?? null }); },
  async chunks(stepId) { return ((await rpc("get_step_chunks", { _step: stepId })) ?? []) as { cursor_seq: number; payload: Record<string, unknown> }[]; },
  async merge(stepId, lease, result, summary) {
    const status = (await rpc("merge_step_results", { _step: stepId, _lease: lease, _result: result, _summary: summary })) as string;
    if (status === "waiting_human") {
      try { await notifyWaitingHuman(stepId); }
      catch (err) { console.error("[notify-waiting-human]", err instanceof Error ? err.message : err); }
    }
    return status;
  },
  async waitModel(stepId, lease, reason, error) { await rpc("wait_step_model", { _step: stepId, _lease: lease, _reason: reason, _error: error }); },
  async fail(stepId, lease, error) { await rpc("fail_step", { _step: stepId, _lease: lease, _error: error }); },
  async sweep() { return rpc("sdf_engine_sweep", {}); },
  async segments(appId, sourceIds) {
    const db = await admin();
    let q = db.from("source_segments").select("id,source_id,seq,speaker,text,sources!inner(code,parse_status,created_at)").eq("app_id", appId).eq("sources.parse_status", "parsed");
    if (sourceIds) q = q.in("source_id", sourceIds);
    const { data, error } = await q.order("source_id").order("seq").limit(2000);
    rpcError(error);
    return (data ?? []).map((x) => ({ id: x.id, source_id: x.source_id, seq: x.seq, speaker: x.speaker, text: x.text, source_code: (x.sources as unknown as { code: string }).code }));
  },
  async requirements(appId) { return loadRequirements(appId); },
  async stampRequirementList(appId) {
    const reqs = await loadRequirements(appId);
    const db = await admin();
    const art = await db.from("artifacts").select("id,content").eq("app_id", appId).eq("type", "requirements").eq("key", "main").eq("is_latest", true).maybeSingle();
    rpcError(art.error);
    if (!art.data) return;
    const content = stampRequirementMarkdown(art.data.content, reqs);
    if (content === art.data.content) return;
    const upd = await db.from("artifacts").update({ content }).eq("id", art.data.id);
    rpcError(upd.error);
  },
  async openFindings(appId) {
    const db = await admin();
    const { data, error } = await db.from("analysis_findings").select("id,code,severity,description").eq("app_id", appId).eq("status", "open").order("code");
    rpcError(error); return data ?? [];
  },
  async tasks(appId) {
    const db = await admin();
    const { data, error } = await db.from("tasks").select("code,title,status,assignee_kind").eq("app_id", appId).order("code");
    rpcError(error);
    return (data ?? []).map((row) => ({ code: row.code, title: row.title, status: row.status, assignee_kind: row.assignee_kind }));
  },
  async testCases(appId) {
    const rows = await serviceQuery()(
      `SELECT r.code AS requirement_code, t.ac_code, t.kind, t.title, t.steps, t.expected
       FROM public.test_cases t
       JOIN public.requirements r ON r.id = t.requirement_id
       WHERE t.app_id = $1
       ORDER BY r.code, t.ac_code, t.kind
       LIMIT 4000`,
      [appId],
    );
    return rows.map((row) => ({
      requirement_code: String(row["requirement_code"]),
      ac_code: String(row["ac_code"]),
      kind: String(row["kind"]),
      title: String(row["title"]),
      steps: Array.isArray(row["steps"]) ? row["steps"].map((step) => String(step)) : [],
      expected: String(row["expected"] ?? ""),
    }));
  },
  async contacts(appId) {
    const db = await admin();
    const { data, error } = await db.from("app_contacts").select("contacts(id,name,title)").eq("app_id", appId);
    rpcError(error);
    return (data ?? []).flatMap((x) => x.contacts ? [x.contacts as { id: string; name: string; title: string }] : []);
  },
  async latestArtifact(appId, type, key = "main") {
    const db = await admin();
    const { data, error } = await db.from("artifacts").select("content,content_json").eq("app_id", appId).eq("type", type).eq("key", key).eq("is_latest", true).maybeSingle();
    rpcError(error);
    return data ?? null;
  },
  reviewTargets,
  commentOnPull,
  flowMetrics,
  publishHandoff,
  repoSnapshot,
  failedTests,
  saveGate,
  triageFeedback,
  loadChange,
  plainSummary: plainBusinessSummary,
  saveChangeSummary,
  meetingAgenda,
  createUat,
  publishRelease,
  async gateway(data, beforeCall) { return gatewayFor(data.app, data.run.trace_id, data.run.started_by, beforeCall, data.step.block_key, data.step.id); },
};

export async function gatewayFor(
  app: { id: string; classification: Classification; redact_before_llm: boolean; redact_terms?: string[] | undefined },
  traceId: string,
  actorId: string,
  beforeCall?: () => Promise<void>,
  blockOrRole?: string,
  stepRunId?: string,
) {
  const db = await admin();
  const roleKey = resolveRoleKey(blockOrRole);
  const [p, r, rp] = await Promise.all([
    db.from("llm_providers").select("*"),
    db.from("model_routes").select("*"),
    roleKey
      ? db.from("agent_prompt_versions").select("prompt").eq("role_key", roleKey).order("version", { ascending: false }).limit(1).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  rpcError(p.error); rpcError(r.error);
  const rolePrompt = typeof rp.data?.prompt === "string" && rp.data.prompt.trim() ? rp.data.prompt : undefined;
  return new OpenAICompatibleGateway({
    classification: app.classification,
    redact: app.redact_before_llm,
    ...(app.redact_terms?.length ? { redactTerms: app.redact_terms } : {}),
    providers: p.data ?? [],
    routes: (r.data ?? []) as ModelRoute[],
    ...(rolePrompt ? { rolePrompt } : {}),
    async apiKey(provider) {
      if (beforeCall) await beforeCall();
      const stored = await pgSystemOps.readSecret(provider.secret_id);
      const key = processEnv.get("SDF_SECRET_KEY");
      if (!stored || !key) throw new AppError("SECRET_DECRYPT_FAILED", "模型密钥无法读取，请管理员重新填写");
      return decryptSecret(stored.ciphertext, key, provider.secret_id, "llm_provider");
    },
    async record(e) {
      await pgSystemOps.writeLlmCall({ trace_id: traceId, actor_id: actorId, app_id: app.id, provider_id: e.provider_id, task_tier: e.tier, model: e.model,
        status: e.ok ? "success" : "error", duration_ms: e.ms, ...(e.usage ?? {}), attempt: e.attempt, redacted: app.redact_before_llm,
        ...(e.code ? { error_code: e.code } : {}), ...(e.message ? { error_message: e.message } : {}),
        ...(stepRunId ? { step_run_id: stepRunId } : {}) });
    },
  });
}

/** User-initiated engine commands. Callers verify permission with the user's RLS client first; actor is the verified token user. */
export const engineCommands = {
  startRun: (a: { app: string; workflow: string; weight: string; inputs: unknown; actor: string; trace: string }) =>
    rpc("start_run", { _app: a.app, _workflow: a.workflow, _weight: a.weight, _inputs: a.inputs, _actor: a.actor, _trace: a.trace }) as Promise<string>,
  decide: (step: string, actor: string, decision: string, comment: string | null, goto: string | null, trace: string) =>
    rpc("decide_step", { _step: step, _actor: actor, _decision: decision, _comment: comment, _goto: goto, _trace: trace }) as Promise<string>,
  retry: (step: string, actor: string, trace: string) => rpc("retry_step", { _step: step, _actor: actor, _trace: trace }),
  skip: (step: string, actor: string, reason: string, trace: string) => rpc("skip_step", { _step: step, _actor: actor, _reason: reason, _trace: trace }),
  cancel: (run: string, actor: string, trace: string) => rpc("cancel_run", { _run: run, _actor: actor, _trace: trace }),
  rerun: (run: string, stepKey: string, actor: string, trace: string) => rpc("rerun_from", { _run: run, _step_key: stepKey, _actor: actor, _trace: trace }),
  editRequirement: (req: string, actor: string, patch: unknown, reason: string, trace: string) => rpc("edit_requirement", { _req: req, _actor: actor, _patch: patch, _reason: reason, _trace: trace }) as Promise<number>,
  editArtifact: (app: string, actor: string, artifact: unknown, trace: string) => rpc("edit_artifact", { _app: app, _actor: actor, _a: artifact, _trace: trace }) as Promise<string>,
  writeSegments: (source: string, raw: string, segments: unknown) => rpc("write_source_segments", { _source: source, _raw: raw, _segments: segments }) as Promise<number>,
  markSourceFailed: (source: string, error: string) => rpc("mark_source_failed", { _source: source, _error: error }),
};
export type EngineCommands = typeof engineCommands;

const CHECKPOINT_ROLE_LABEL: Record<string, string> = {
  lead: "交付负责人",
  ba: "业务分析师",
  architect: "架构师",
  security: "信息安全",
  dev: "开发",
  qa: "测试",
  business: "业务方",
};

/** 构造步骤进入待确认状态时的站内通知标题与正文。 */
export function formatWaitingHumanNotice(input: {
  appName: string;
  runCode: string;
  stepName: string;
  role: string;
  prompt?: string | null;
}): { title: string; body: string } {
  const roleLabel = CHECKPOINT_ROLE_LABEL[input.role] ?? input.role;
  const prompt = (input.prompt ?? "").trim();
  return {
    title: `【待确认】${input.appName} · ${input.stepName}（${input.runCode}）`,
    body: `需要「${roleLabel}」人工确认${prompt ? `：${prompt.slice(0, 140)}` : ""}。请前往「我的待办」或应用运行详情处置。`,
  };
}

/** 步骤停在 waiting_human 时，向该应用下对应角色与交付负责人成员写入站内未读通知。 */
async function notifyWaitingHuman(stepId: string): Promise<void> {
  const rows = await serviceQuery()(
    `SELECT sr.app_id, sr.step_key, sr.block_key, sr.checkpoint,
            wr.code AS run_code, wr.started_by, wr.workflow_snapshot,
            a.name AS app_name
     FROM public.step_runs sr
     JOIN public.workflow_runs wr ON wr.id = sr.run_id
     JOIN public.apps a ON a.id = sr.app_id
     WHERE sr.id = $1`,
    [stepId],
  );
  const row = rows[0];
  if (!row) return;
  const appId = String(row["app_id"]);
  const appName = String(row["app_name"] ?? "应用");
  const runCode = String(row["run_code"] ?? "");
  const stepKey = String(row["step_key"] ?? "");
  const checkpoint = (row["checkpoint"] && typeof row["checkpoint"] === "object"
    ? row["checkpoint"] as { role?: string; prompt?: string }
    : null);
  const snapshot = (row["workflow_snapshot"] && typeof row["workflow_snapshot"] === "object"
    ? row["workflow_snapshot"] as { steps?: { key?: string; name?: string }[] }
    : null);
  const stepName = snapshot?.steps?.find((s) => s.key === stepKey)?.name || stepKey;
  const targetRole = checkpoint?.role?.trim() || "lead";
  const roles = Array.from(new Set([targetRole, "lead"]));
  const notice = formatWaitingHumanNotice({
    appName,
    runCode,
    stepName,
    role: targetRole,
    prompt: checkpoint?.prompt ?? null,
  });

  const recipients = await serviceQuery()(
    `SELECT DISTINCT user_id
     FROM public.app_members
     WHERE app_id = $1
       AND role::text = ANY($2::text[])
       AND (expires_at IS NULL OR expires_at > now())`,
    [appId, roles],
  );
  const userIds = new Set(recipients.map((r) => String(r["user_id"])).filter(Boolean));
  if (userIds.size === 0 && row["started_by"]) {
    userIds.add(String(row["started_by"]));
  }
  if (!userIds.size) return;

  await serviceQuery()(
    `INSERT INTO public.notifications(app_id, user_id, title, body)
     SELECT $1, uid, $3, $4
     FROM unnest($2::uuid[]) AS uid
     WHERE NOT EXISTS (
       SELECT 1 FROM public.notifications n
       WHERE n.app_id = $1 AND n.user_id = uid AND n.title = $3
         AND n.read_at IS NULL AND n.created_at > now() - interval '2 minutes'
     )`,
    [appId, Array.from(userIds), notice.title, notice.body],
  );
}
