// 直连 vm-9 的原生 PostgreSQL。没有服务账号口令时跳过。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBuiltinWorkflows } from "@/adapters/ensure-builtins";
import { createServiceDb, serviceQuery } from "@/adapters/pg-client";
import type { UserDb } from "@/adapters/pg-query";

const run = process.env["SDF_PG_SERVICE_PASSWORD"] ? describe : describe.skip;
let db: UserDb; let appId = ""; let otherApp = ""; let wfId = ""; let segIds: string[] = []; let otherSeg = "";
const rpc = async (fn: string, args: Record<string, unknown>) => { const r = await db.rpc(fn, args); return r; };
async function ensureActor() {
  const existing = await db.from("user_roles").select("user_id").eq("role", "admin").limit(1).maybeSingle();
  const found = (existing.data as { user_id?: string } | null)?.user_id;
  if (found) return found;
  const rows = await serviceQuery()(
    `INSERT INTO auth.users (email, password_hash, raw_user_meta_data, disabled)
     VALUES ('engine-test@sdf.internal', '!locked!', '{"display_name":"引擎测试"}'::jsonb, true)
     ON CONFLICT (email) DO UPDATE SET disabled = true RETURNING id`, []);
  const id = String(rows[0]?.["id"] ?? "");
  await serviceQuery()("INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING", [id]);
  return id;
}
const trace = "t-integration-2b";
let actor = "";

async function makeApp(name: string) {
  const a = await db.from("apps").insert({ name, description: "引擎集成测试（自动清理）", created_by: actor }).select("id").single();
  if (a.error) throw a.error;
  const id = a.data.id as string; const sid = crypto.randomUUID();
  const s = await db.from("sources").insert({ id: sid, app_id: id, code: "SRC-T", kind: "minutes", title: "测试纪要", created_by: actor });
  if (s.error) throw s.error;
  const w = await rpc("write_source_segments", { _source: sid, _raw: "x", _segments: [{ speaker: "店长", text: "需要每天自动生成补货建议" }, { speaker: "区域经理", text: "补货建议要能人工调整" }] });
  if (w.error) throw w.error;
  const segs = await db.from("source_segments").select("id").eq("source_id", sid).order("seq");
  return { id, segs: (segs.data ?? []).map((x) => x.id as string) };
}
async function start(weight = "light") {
  const r = await rpc("start_run", { _app: appId, _workflow: wfId, _weight: weight, _inputs: {}, _actor: actor, _trace: trace });
  if (r.error) throw r.error; return r.data as string;
}
const steps = async (runId: string) => (await db.from("step_runs").select("*").eq("run_id", runId).order("seq").order("attempt")).data ?? [];
const claim = async (runId: string) => ((await rpc("claim_step", { _run: runId, _lease_seconds: 60 })).data as { step_run_id: string; lease_token: string }[])[0];
// 开发机时钟比 vm-9 快数秒，客户端的 now()-1s 在库里仍是未来。过期时间一律用数据库时钟。
const age = (id: string, sql: string) => serviceQuery()(`UPDATE public.step_runs SET ${sql} WHERE id = $1`, [id]);

run("engine integration", () => {
  beforeAll(async () => {
    db = createServiceDb();
    await ensureBuiltinWorkflows();
    actor = await ensureActor();
    const wf = await db.from("workflows").select("id").eq("key", "requirement_only").eq("startable", true).order("version", { ascending: false }).limit(1);
    wfId = (wf.data as { id: string }[])[0]!.id;
    const a = await makeApp("集成测试应用 A"); appId = a.id; segIds = a.segs;
    const b = await makeApp("集成测试应用 B"); otherApp = b.id; otherSeg = b.segs[0]!;
  }, 30_000);
  afterAll(async () => {
    if (!db) return;
    const del = await db.from("apps").delete().in("id", [appId, otherApp].filter(Boolean));
    expect(del.error).toBeNull(); // deleting an app must cascade past immutable requirement versions
  });

  it("20 concurrent claims: exactly one wins; a second running step is rejected by the unique index", async () => {
    const runId = await start();
    const res = await Promise.all(Array.from({ length: 20 }, () => rpc("claim_step", { _run: runId, _lease_seconds: 60 })));
    expect(res.filter((r) => (r.data as unknown[] | null)?.length).length).toBe(1);
    const s = await steps(runId);
    const second = await db.from("step_runs").update({ status: "running" }).eq("id", s.find((x) => x.step_key === "organize")!.id);
    expect(second.error?.code).toBe("23505");
    await rpc("cancel_run", { _run: runId, _actor: actor, _trace: trace });
    expect((await steps(runId)).filter((x) => x.is_current && x.status !== "skipped").every((x) => ["cancelled", "succeeded"].includes(x.status))).toBe(true);
  }, 30_000);

  it("chunk idempotency, lease checks, resume from cursor and merge", async () => {
    const runId = await start();
    const c = (await claim(runId))!;
    const first = await rpc("save_step_chunk", { _step: c.step_run_id, _lease: c.lease_token, _cursor_seq: 0, _cursor: { next: 1 }, _payload: { tags: [{ segment_id: segIds[0], tags: { topic: "补货" } }] }, _progress: "p", _tokens: 5, _calls: 1, _release: true });
    const dup = await rpc("save_step_chunk", { _step: c.step_run_id, _lease: c.lease_token, _cursor_seq: 0, _cursor: { next: 1 }, _payload: { tags: [] }, _progress: "p", _tokens: 5, _calls: 1, _release: true });
    expect([first.data, dup.data]).toEqual([true, false]);
    const wrong = await rpc("save_step_chunk", { _step: c.step_run_id, _lease: crypto.randomUUID(), _cursor_seq: 1, _cursor: {}, _payload: {}, _progress: "p", _tokens: 0, _calls: 0, _release: false });
    expect(wrong.error?.message).toContain("SDF_LEASE_LOST");
    const resumed = (await claim(runId))!; // lease was released: same step, saved cursor kept
    expect(resumed.step_run_id).toBe(c.step_run_id);
    const row = (await db.from("step_runs").select("cursor_seq,tokens").eq("id", c.step_run_id).single()).data!;
    expect(row).toEqual({ cursor_seq: 1, tokens: 5 });
    const chunks = (await rpc("get_step_chunks", { _step: c.step_run_id })).data as unknown[];
    expect(chunks.length).toBe(1);
    expect((await rpc("merge_step_results", { _step: c.step_run_id, _lease: c.lease_token, _result: {}, _summary: "x" })).error?.message).toContain("SDF_LEASE_LOST");
    expect((await rpc("merge_step_results", { _step: c.step_run_id, _lease: resumed.lease_token, _result: { tags: [] }, _summary: "ok" })).data).toBe("succeeded");
    // B02: cross-app citation rejected, valid one creates v1 with criteria
    const b2 = (await claim(runId))!;
    const bad = await rpc("merge_step_results", { _step: b2.step_run_id, _lease: b2.lease_token, _result: { requirements: [{ title: "跨应用", story: "x", confidence: 0.5, citations: [{ segment_id: otherSeg }], criteria: [{ format: "gwt", text: "Given x When y Then z" }] }] }, _summary: "x" });
    expect(bad.error?.message).toContain("SDF_REF_CROSS_APP");
    const good = await rpc("merge_step_results", { _step: b2.step_run_id, _lease: b2.lease_token, _result: { requirements: [{ title: "自动补货建议", story: "店长每天看到补货建议", confidence: 0.8, citations: [{ segment_id: segIds[0] }], criteria: [{ format: "gwt", text: "Given 每天 When 08:00 Then 生成建议" }] }] }, _summary: "1 条" });
    expect(good.data).toBe("succeeded");
    // B03 with a blocker -> waiting_human; approve blocked; after resolving, two concurrent approvals -> one wins
    const b3 = (await claim(runId))!;
    const reqId = ((await db.from("requirements").select("id").eq("app_id", appId).single()).data as { id: string }).id;
    const m3 = (await rpc("merge_step_results", { _step: b3.step_run_id, _lease: b3.lease_token, _result: { findings: [{ severity: "blocker", category: "conflict", target_refs: [{ type: "requirement", id: reqId }], description: "冲突", suggestion: "澄清", rule_or_agent: "agent" }] }, _summary: "1 阻断" })); expect(m3.error?.message ?? m3.data).toBe("waiting_human");
    expect((await rpc("decide_step", { _step: b3.step_run_id, _actor: actor, _decision: "approve", _comment: null, _goto: null, _trace: trace })).error?.message).toContain("SDF_BLOCKERS_OPEN");
    // reject back to organize: attempts 2 queued, history kept, old outputs stale
    expect((await rpc("decide_step", { _step: b3.step_run_id, _actor: actor, _decision: "reject", _comment: "请补充", _goto: "organize", _trace: trace })).error).toBeNull();
    const after = await steps(runId);
    const org = after.filter((x) => x.step_key === "organize");
    expect(org.map((x) => [x.attempt, x.status, x.is_current])).toEqual([[1, "superseded", false], [2, "pending", true]]);
    expect(org[1]!.checkpoint).toMatchObject({ feedback: "请补充" });
    expect(after.filter((x) => x.step_key === "analyze").map((x) => [x.attempt, x.status])).toEqual([[1, "rejected"], [2, "pending"]]);
    expect(((await db.from("analysis_findings").select("status").eq("step_run_id", b3.step_run_id).single()).data as { status: string }).status).toBe("stale");
    // rerun organize again -> requirement gets v2, v1 kept
    const o2 = (await claim(runId))!;
    await rpc("merge_step_results", { _step: o2.step_run_id, _lease: o2.lease_token, _result: { requirements: [{ title: "自动补货建议", story: "店长每天 8 点看到补货建议", confidence: 0.9, citations: [{ segment_id: segIds[0] }], criteria: [{ format: "ears", text: "When 08:00, the system shall 生成建议" }] }] }, _summary: "v2" });
    expect(((await db.from("requirement_versions").select("version").eq("requirement_id", reqId).order("version")).data ?? []).map((x) => x.version)).toEqual([1, 2]);
    const a2 = (await claim(runId))!;
    await rpc("merge_step_results", { _step: a2.step_run_id, _lease: a2.lease_token, _result: { findings: [] }, _summary: "0" });
    const both = await Promise.all([1, 2].map(() => rpc("decide_step", { _step: a2.step_run_id, _actor: actor, _decision: "approve", _comment: null, _goto: null, _trace: trace })));
    expect(both.filter((r) => !r.error).length).toBe(1);
    expect(both.find((r) => r.error)?.error?.message).toContain("SDF_CONFLICT");
  }, 60_000);

  it("stall detection, model wait retries and retry history", async () => {
    const runId = await start();
    const c = (await claim(runId))!;
    await age(c.step_run_id, "heartbeat_at = now() - interval '6 minutes'");
    await rpc("sdf_engine_sweep", {});
    const stalled = (await db.from("step_runs").select("status,error").eq("id", c.step_run_id).single()).data!;
    expect(stalled.status).toBe("failed"); expect((stalled.error as { code: string }).code).toBe("STEP_STALLED");
    await rpc("retry_step", { _step: c.step_run_id, _actor: actor, _trace: trace });
    const c2 = (await claim(runId))!;
    expect(((await db.from("step_runs").select("attempt").eq("id", c2.step_run_id).single()).data as { attempt: number }).attempt).toBe(2);
    await rpc("wait_step_model", { _step: c2.step_run_id, _lease: c2.lease_token, _reason: "model_not_configured", _error: { code: "LLM_NOT_CONFIGURED" } });
    await age(c2.step_run_id, "next_retry_at = now() - interval '1 minute'");
    await rpc("sdf_engine_sweep", {});
    expect(((await db.from("step_runs").select("status").eq("id", c2.step_run_id).single()).data as { status: string }).status).toBe("waiting_model");
    await age(c2.step_run_id, "wait_reason = 'rate_limited', next_retry_at = now() - interval '1 minute'");
    await rpc("sdf_engine_sweep", {});
    expect((await db.from("step_runs").select("status,retry_count").eq("id", c2.step_run_id).single()).data).toEqual({ status: "pending", retry_count: 1 });
    const c3 = (await claim(runId))!;
    await rpc("wait_step_model", { _step: c3.step_run_id, _lease: c3.lease_token, _reason: "model_unavailable", _error: {} });
    await age(c3.step_run_id, "retry_count = 12, next_retry_at = now() - interval '1 minute'");
    await rpc("sdf_engine_sweep", {});
    expect(((await db.from("step_runs").select("status").eq("id", c3.step_run_id).single()).data as { status: string }).status).toBe("failed");
  }, 60_000);

  it("an expired lease is reclaimed at most 3 times, then the step fails", async () => {
    // claims stay scoped to this test's run so the live scheduler's real runs are never touched
    const stuck = await start();
    const c = (await claim(stuck))!;
    for (let i = 0; i < 3; i++) {
      await age(c.step_run_id, "lease_expires_at = now() - interval '1 minute'");
      expect((await claim(stuck))?.step_run_id).toBe(c.step_run_id);
    }
    await age(c.step_run_id, "lease_expires_at = now() - interval '1 minute'");
    expect(await claim(stuck)).toBeUndefined();
    const s = (await db.from("step_runs").select("status,error").eq("id", c.step_run_id).single()).data!;
    expect(s.status).toBe("failed"); expect((s.error as { code: string }).code).toBe("STEP_STALLED");
    expect(((await db.from("workflow_runs").select("status").eq("id", stuck).single()).data as { status: string }).status).toBe("failed");
  }, 60_000);
});
