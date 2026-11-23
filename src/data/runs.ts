// Workflow, run, requirement and source data access. Components call only these.
import { queryOptions } from "@tanstack/react-query";
import { api, ApiError } from "./http";
import { getAccessToken } from "./auth";

export type Weight = "light" | "standard" | "full";
export interface PlanStep { key: string; name: string; block: string; skipped: boolean; checkpoint: string | null }
export interface Workflow { id: string; key: string; version: string; name: string; description: string; yaml: string; startable: boolean; is_builtin: boolean; issues: string[]; plans: Record<Weight, PlanStep[]> }
export interface StepRun {
  id: string; run_id: string; step_key: string; stage: string; block_key: string; seq: number; attempt: number; is_current: boolean; status: string;
  wait_reason: string | null; checkpoint: { role?: string; prompt?: string; feedback?: string } | null; decision: string | null; decision_comment: string | null; reject_goto: string | null;
  progress_text: string | null; summary: string | null; error: { code?: string; message?: string; error_id?: string } | null; retry_count: number; next_retry_at: string | null;
  model_calls: number; tokens: number; output_artifacts: string[]; skip_reason: string | null; created_at: string; started_at: string | null; finished_at: string | null; cursor_seq: number;
}
export interface RunRow { id: string; code: string; app_id: string; status: string; weight: Weight; current_step_key: string | null; started_at: string; finished_at: string | null; started_by: string; trace_id: string; workflow_snapshot: { steps: { key: string; name: string; block: string }[] }; workflows: { key: string; name: string; version: string } | null }
export interface RunEvent { id: number; step_run_id: string; ts: string; kind: string; message: string; data: Record<string, unknown> }
export interface RunArtifact { id: string; type: string; key: string; version: number; title: string; content: string; status: string; is_latest: boolean; possibly_stale: boolean; step_run_id: string | null; agent_role: string | null; model: string | null; reviewed_at: string | null; edit_ratio: number | null; confidence: number | null; created_at: string }
export interface RunDetail { run: RunRow; steps: StepRun[]; events: RunEvent[]; artifacts: RunArtifact[]; llm_calls: { id: string; model: string; status: string; duration_ms: number; total_tokens: number; attempt: number; error_code?: string | null; step_run_id: string | null; created_at: string }[] | null;
  blocks: Record<string, { name: string; agent_role: string; task_tier: string }>; access: { isAdmin: boolean; roles: string[]; user_id: string } }
export interface RunListItem { id: string; code: string; status: string; weight: Weight; current_step_key: string | null; started_at: string; finished_at: string | null; workflows: { name: string; version: string } | null; step_runs: { step_key: string; block_key: string; seq: number; status: string; attempt: number }[] }
export interface InboxItem { id: string; run_id: string; app_id: string; step_key: string; block_key: string; checkpoint: { role?: string; prompt?: string } | null; created_at: string; workflow_runs: { code: string; workflows: { name: string } | null } | null; apps: { name: string } | null }
export interface InboxBundle {
  items: InboxItem[];
  changes: { id: string; app_id: string; code: string; title: string; status: string; app_name: string }[];
  feedback: { id: string; app_id: string; code: string; title: string; status: string; app_name: string }[];
  uat: { id: string; app_id: string; ac_code: string; title: string; result: string; app_name: string }[];
  notices: { id: string; app_id: string | null; title: string; body: string; created_at: string }[];
  mentions: { id: string; app_id: string; body: string; app_name: string }[];
}
export interface Source { id: string; code: string; kind: string; title: string; meeting_date: string | null; participants: string[]; parse_status: string; parse_error: string | null; created_at: string; size_bytes: number | null; source_segments: { count: number }[] }
export interface SourceDetail extends Omit<Source, "source_segments" | "created_at" | "size_bytes"> { raw_text: string | null; segments: { id: string; seq: number; speaker: string | null; text: string; tags: { topic?: string; kind?: string } }[] }
export interface Requirement { id: string; code: string; title: string; story: string; type: string; priority: string; status: string; current_version: number; confidence: number | null; possibly_stale: boolean;
  citations: { segment_id: string; source_code?: string; seq?: number }[]; acceptance_criteria: { id: string; code: string; format: string; text: string }[]; external_ref?: string | null }
export interface ReqVersion { id: string; version: number; snapshot: { story?: string; priority?: string; criteria?: { code: string; format: string; text: string }[] }; change_reason: string; created_at: string }
export interface Finding { id: string; code: string; severity: "blocker" | "major" | "minor"; category: string; description: string; suggestion: string; status: string; rule_or_agent: string; target_refs: { type: string; id: string }[]; step_run_id: string | null }
export interface Question { id: string; code: string; stakeholder: string; question: string; answer: string | null; status: string; target_refs: { type: string; id: string }[]; contacts: { name: string; title: string } | null }
export interface ConstitutionVersion { id: string; version: number; content: string; content_json: Record<string, string> | null; created_at: string; source: string }

export const workflowsQuery = () => queryOptions({ queryKey: ["workflows"], queryFn: () => api<{ items: Workflow[] }>("/workflows").then((r) => r.items) });
export const appRunsQuery = (appId: string) => queryOptions({ queryKey: ["app", appId, "runs"], queryFn: () => api<{ items: RunListItem[] }>(`/apps/${appId}/runs`).then((r) => r.items) });
export const runQuery = (runId: string) => queryOptions({ queryKey: ["run", runId], queryFn: () => api<RunDetail>(`/runs/${runId}`) });
export const inboxQuery = () => queryOptions({ queryKey: ["inbox"], queryFn: () => api<InboxBundle>("/inbox") });
export const sourcesQuery = (appId: string) => queryOptions({ queryKey: ["app", appId, "sources"], queryFn: () => api<{ items: Source[] }>(`/apps/${appId}/sources`).then((r) => r.items) });
export const sourceQuery = (id: string) => queryOptions({ queryKey: ["source", id], queryFn: () => api<SourceDetail>(`/sources/${id}`) });
export const requirementsQuery = (appId: string) => queryOptions({ queryKey: ["app", appId, "requirements"], queryFn: () => api<{ items: Requirement[] }>(`/apps/${appId}/requirements`).then((r) => r.items) });
export const reqVersionsQuery = (id: string) => queryOptions({ queryKey: ["requirement", id, "versions"], queryFn: () => api<{ items: ReqVersion[] }>(`/requirements/${id}/versions`).then((r) => r.items) });
export const findingsQuery = (appId: string) => queryOptions({ queryKey: ["app", appId, "findings"], queryFn: () => api<{ items: Finding[] }>(`/apps/${appId}/findings`).then((r) => r.items) });
export const questionsQuery = (appId: string) => queryOptions({ queryKey: ["app", appId, "questions"], queryFn: () => api<{ items: Question[] }>(`/apps/${appId}/questions`).then((r) => r.items) });
export const constitutionQuery = (appId: string) => queryOptions({ queryKey: ["app", appId, "constitution"], queryFn: () => api<{ items: ConstitutionVersion[] }>(`/apps/${appId}/constitution`).then((r) => r.items) });

export const startRun = (appId: string, body: { workflow_id: string; weight: Weight; source_ids: string[] }) => api<{ id: string }>(`/apps/${appId}/runs`, { method: "POST", body });
export const cancelRun = (runId: string) => api(`/runs/${runId}/cancel`, { method: "POST", body: {} });
export const rerunFrom = (runId: string, step_key: string) => api(`/runs/${runId}/rerun`, { method: "POST", body: { step_key } });
export const decideStep = (stepId: string, body: { decision: "approve" | "reject"; comment: string | null; goto: string | null }) => api(`/steps/${stepId}/decide`, { method: "POST", body });
export const retryStep = (stepId: string) => api(`/steps/${stepId}/retry`, { method: "POST", body: {} });
export const skipStep = (stepId: string, reason: string) => api(`/steps/${stepId}/skip`, { method: "POST", body: { reason } });
export const editRequirement = (id: string, body: { story?: string; priority?: string; criteria?: { format: string; text: string }[]; reason: string }) => api<{ version: number }>(`/requirements/${id}/edit`, { method: "POST", body });
export const confirmRequirements = (appId: string, ids: string[]) => api<{ confirmed: number }>(`/apps/${appId}/requirements/confirm`, { method: "POST", body: { ids } });
export const returnRequirements = (appId: string, ids: string[], note: string) => api<{ returned: number }>(`/apps/${appId}/requirements/return`, { method: "POST", body: { ids, note } });
export const sealBaseline = (appId: string) => api<{ version: string }>(`/apps/${appId}/baselines/seal`, { method: "POST", body: {} });
export const runAcceptance = (appId: string) => api<{ tests: number; findings: number }>(`/apps/${appId}/acceptance/run`, { method: "POST", body: {} });
export const setFindingStatus = (id: string, status: string) => api(`/findings/${id}`, { method: "PATCH", body: { status } });
export const answerQuestion = (id: string, answer: string) => api(`/questions/${id}`, { method: "PATCH", body: { answer } });
export const applyAnswers = (appId: string) => api<{ updated: number; applied: number }>(`/apps/${appId}/questions/apply`, { method: "POST", body: {} });
export const saveConstitution = (appId: string, body: Record<string, string>) => api(`/apps/${appId}/constitution`, { method: "PUT", body });
export const draftConstitution = (appId: string) => api<{ draft: Record<string, string> }>(`/apps/${appId}/constitution/draft`, { method: "POST", body: {} });

/** Multipart upload goes through the API (server validates, stores, parses). */
export async function uploadSource(appId: string, form: FormData): Promise<{ id: string; code: string; segments: number }> {
  const token = await getAccessToken();
  let res: Response;
  try { res = await fetch(`/api/apps/${appId}/sources`, { method: "POST", body: form, headers: token ? { Authorization: `Bearer ${token}` } : {} }); }
  catch { throw new ApiError(0, "NETWORK", "网络连接失败，请检查网络后重试"); }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? "HTTP", json?.error?.message ?? `上传失败（${res.status}）`, json?.error?.error_id, json?.error?.trace_id);
  return json;
}

export const STATUS_LABEL: Record<string, string> = {
  pending: "排队中", running: "执行中", waiting_human: "待确认", waiting_event: "等待事件", waiting_model: "等待模型", succeeded: "已完成", rejected: "已退回",
  failed: "失败", skipped: "已跳过", superseded: "已被替代", cancelled: "已取消", completed: "已完成",
};
export const WAIT_LABEL: Record<string, string> = { model_not_configured: "需要配置模型", model_unavailable: "模型暂不可用，5 分钟后自动重试", rate_limited: "模型限流，5 分钟后自动重试" };
export const WEIGHT_LABEL: Record<Weight, string> = { light: "简化", standard: "标准", full: "完整" };
