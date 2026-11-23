// Engine ports: pure interfaces implemented by runtime adapters.
import type { ModelGateway } from "../model-gateway";
import type { Classification } from "../llm";
import type { Weight } from "./builtin";

export interface StepContextData {
  step: { id: string; run_id: string; app_id: string; step_key: string; block_key: string; attempt: number; cursor_seq: number; cursor: unknown; checkpoint: Record<string, unknown> | null };
  run: { id: string; code: string; weight: Weight; inputs: Record<string, unknown>; trace_id: string; started_by: string; snapshot: { steps: { key: string; options?: Record<string, Record<string, unknown>> }[] } };
  app: { id: string; name: string; classification: Classification; redact_before_llm: boolean; redact_terms?: string[] };
}
export interface Segment { id: string; source_id: string; source_code: string; seq: number; speaker: string | null; text: string }
export interface Requirement { id: string; code: string; title: string; story: string; priority: string; type: string; criteria: { code?: string; format: string; text: string }[] }
export interface Finding { id: string; code: string; severity: string; description: string }
export interface Contact { id: string; name: string; title: string }
export interface ChunkRow { cursor_seq: number; payload: Record<string, unknown> }
export interface StepError { code: string; message: string; error_id?: string }

export interface EngineStore {
  claim(runId: string | null, leaseSeconds: number): Promise<{ stepId: string; lease: string } | null>;
  context(stepId: string): Promise<StepContextData>;
  saveChunk(stepId: string, lease: string, cursorSeq: number, cursor: unknown, payload: unknown, progress: string, tokens: number, calls: number, release: boolean): Promise<boolean>;
  heartbeat(stepId: string, lease: string, progress?: string): Promise<void>;
  chunks(stepId: string): Promise<ChunkRow[]>;
  merge(stepId: string, lease: string, result: Record<string, unknown>, summary: string): Promise<string>;
  /** 需求整理入库后，把正式编号写回需求清单正文。 */
  stampRequirementList(appId: string): Promise<void>;
  waitModel(stepId: string, lease: string, reason: "model_not_configured" | "model_unavailable" | "rate_limited", error: StepError): Promise<void>;
  fail(stepId: string, lease: string, error: StepError): Promise<void>;
  sweep(): Promise<unknown>;
  segments(appId: string, sourceIds: string[] | null): Promise<Segment[]>;
  requirements(appId: string): Promise<Requirement[]>;
  openFindings(appId: string): Promise<Finding[]>;
  contacts(appId: string): Promise<Contact[]>;
  tasks(appId: string): Promise<{ code: string; title: string; status: string; assignee_kind: string }[]>;
  testCases(appId: string): Promise<{ requirement_code: string; ac_code: string; kind: string; title: string; steps: string[]; expected: string }[]>;
  latestArtifact(appId: string, type: string, key?: string): Promise<{ content: string; content_json: unknown } | null>;
  reviewTargets(appId: string): Promise<{ constitution: string; criteria: string; pulls: { number: number; title: string; diff: string }[] }>;
  commentOnPull(appId: string, number: number, body: string): Promise<void>;
  flowMetrics(appId: string): Promise<{ cycle_hours: number | null; cycle_samples: number; stages: { stage: string; hours: number; samples: number }[]; requirements: number; covered_requirements: number; approved: number; decided: number }>;
  publishHandoff(appId: string, runId: string, runCode: string): Promise<{ branch: string; summary: string; url: string | null }>;
  repoSnapshot(appId: string): Promise<{ files: { path: string; content: string }[] }>;
  failedTests(appId: string): Promise<{ name: string; ac_code: string | null }[]>;
  saveGate(appId: string, runId: string | null): Promise<{ met: boolean; items: { item_key: string; status: string; numerator: number | null; denominator: number | null; evidence: string }[] }>;
  triageFeedback(appId: string, feedbackId: string): Promise<void>;
  loadChange(id: string): Promise<{ id: string; code: string; title: string; business_summary: string; requirement_codes: string[]; iteration_id: string | null } | null>;
  plainSummary(title: string, codes: string[]): { business: string; technical: string };
  saveChangeSummary(appId: string, changeId: string, business: string, technical: string): Promise<void>;
  meetingAgenda(appId: string): Promise<string>;
  createUat(appId: string, changeId: string | null, iterationId: string | null): Promise<number>;
  publishRelease(appId: string, version: string, userId: string | null, notes: { business: string; technical: string }, iterationId: string | null): Promise<void>;
  gateway(data: StepContextData, beforeCall: () => Promise<void>): Promise<ModelGateway>;
}
