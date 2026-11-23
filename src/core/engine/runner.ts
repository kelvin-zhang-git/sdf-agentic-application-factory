// Chunked, lease-guarded step execution. Each chunk is idempotent by (step, attempt, cursor_seq).
import { AppError, newErrorId } from "../errors";
import { BLOCKS, type BlockContext } from "../blocks";
import type { EngineStore, StepError } from "./types";

export const LEASE_SECONDS = 120;

export function classifyModelError(e: unknown): { wait?: "model_not_configured" | "model_unavailable" | "rate_limited"; lost?: boolean; error: StepError } {
  const err = e instanceof AppError ? e : null;
  const msg = e instanceof Error ? e.message : "";
  if (/SDF_LEASE_LOST/.test(msg) || err?.code === "LEASE_LOST") return { lost: true, error: { code: "LEASE_LOST", message: "租约已失效" } };
  const error: StepError = { code: err?.code ?? "INTERNAL", message: err?.message ?? "积木执行失败", error_id: newErrorId() };
  if (!err) return { error };
  if (err.code === "LLM_NOT_CONFIGURED") return { wait: "model_not_configured", error };
  const status = (err.details as { http_status?: number } | undefined)?.http_status;
  if (err.code === "LLM_HTTP" && status === 429) return { wait: "rate_limited", error };
  if (err.code === "LLM_UNAVAILABLE" || err.code === "LLM_TIMEOUT" || (err.code === "LLM_HTTP" && (status ?? 0) >= 500)) return { wait: "model_unavailable", error };
  return { error };
}

/** Runs claimable steps until the time budget is spent. Returns whether work may remain. */
export async function runEngine(store: EngineStore, opts: { runId?: string | null; budgetMs: number; now?: () => number }): Promise<{ steps: number; more: boolean }> {
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.budgetMs;
  let steps = 0;
  while (now() < deadline) {
    const claim = await store.claim(opts.runId ?? null, LEASE_SECONDS);
    if (!claim) return { steps, more: false };
    steps += 1;
    await runStep(store, claim.stepId, claim.lease, deadline, now);
  }
  return { steps, more: true };
}

export async function runStep(store: EngineStore, stepId: string, lease: string, deadline: number, now: () => number = Date.now): Promise<void> {
  try {
    const data = await store.context(stepId);
    const block = BLOCKS[data.step.block_key];
    if (!block) throw new AppError("VALIDATION", `积木 ${data.step.block_key} 尚未实施`);
    const llm = await store.gateway(data, () => store.heartbeat(stepId, lease));
    const options = data.run.snapshot.steps.find((s) => s.key === data.step.step_key)?.options?.[data.run.weight] ?? {};
    const ctx: BlockContext = { data, store, llm, options, feedback: typeof data.step.checkpoint?.["feedback"] === "string" ? data.step.checkpoint["feedback"] as string : null };
    let seq = data.step.cursor_seq;
    for (;;) {
      const out = await block.chunk(ctx, seq);
      const stop = out.more && now() >= deadline;
      await store.saveChunk(stepId, lease, seq, { next: seq + 1 }, out.payload, out.progress, out.tokens ?? 0, out.calls ?? 0, stop);
      seq += 1;
      if (!out.more) break;
      if (stop) return; // lease released; next tick resumes from saved cursor
    }
    const chunks = await store.chunks(stepId);
    const { result, summary } = block.finalize(ctx, chunks.map((c) => c.payload));
    await store.merge(stepId, lease, result, summary);
    // 编号在入库时才生成，合并成功后再回写清单标题。回写失败不推翻已经成功的步骤。
    if (data.step.block_key === "B02") {
      try { await store.stampRequirementList(data.app.id); }
      catch (stampError) { console.error("[stamp-req]", stampError instanceof Error ? stampError.message : stampError); }
    }
  } catch (e) {
    if (!(e instanceof AppError)) console.error("[step]", e instanceof Error ? e.stack?.split("\n").slice(0, 8).join("\n") : e);
    const c = classifyModelError(e);
    if (c.lost) return;
    try {
      if (c.wait) await store.waitModel(stepId, lease, c.wait, c.error);
      else await store.fail(stepId, lease, c.error);
    } catch { /* lease lost: another worker owns the step */ }
  }
}
