// @vitest-environment node
// 阶段 3：吴姐账号留在澄远。先退回一次变更，再确认、交接、验收不通过并发布 v1.2。
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { serviceQuery } from "@/adapters/pg-client";
import { engineStore } from "@/adapters/engine-store";
import { syncPullRequests } from "@/adapters/stage2-store";
import { getApi } from "@/adapters/runtime";
import { runEngine } from "@/core/engine/runner";

const live = process.env["SDF_PG_SERVICE_PASSWORD"] && process.env["GITEA_TOKEN"] ? describe : describe.skip;
const WUJIE = "wujie@chengyuan.local";
const DRIVER = "s3-driver@sdf.internal";
const APP = "澄远零售门店智能补货";
const driverPassword = `Sdf-${crypto.randomUUID()}`;
const wujieFile = new URL("../../../wujie-demo.local", import.meta.url);

function wujiePassword(): string {
  try {
    const saved = /password=(.+)/.exec(readFileSync(wujieFile, "utf8"))?.[1]?.trim();
    if (saved) return saved;
  } catch {
    // 第一次创建账号时再写入。
  }
  const password = `Wujie-${crypto.randomUUID().slice(0, 8)}`;
  writeFileSync(wujieFile, `email=${WUJIE}\npassword=${password}\n`, "utf8");
  return password;
}

function giteaToken(): string {
  const token = process.env["GITEA_TOKEN"] ?? "";
  if (!token) throw new Error("缺少 Gitea 令牌");
  return token;
}

async function gitea(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(`http://git.example.com:3002/api/v1${path}`, {
    ...init,
    headers: { Authorization: `token ${giteaToken()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!response.ok && response.status !== 409 && response.status !== 422) throw new Error(`${response.status} ${path}`);
  const text = await response.text();
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

type StepRow = { id: string; status: string; step_key: string; block_key: string; error: unknown; checkpoint: { role?: string } | null };

async function snapshot(runId: string): Promise<{ run: string; steps: StepRow[] }> {
  const run = await serviceQuery()("SELECT status FROM public.workflow_runs WHERE id = $1", [runId]);
  const steps = await serviceQuery()("SELECT id, status, step_key, block_key, error, checkpoint FROM public.step_runs WHERE run_id = $1 AND is_current ORDER BY seq", [runId]);
  return { run: String(run[0]?.["status"] ?? ""), steps: steps as unknown as StepRow[] };
}

/** 负责人和需求分析师的确认点由验收驱动通过。业务确认点停下来，交给吴姐。 */
async function drive(runId: string, adminAuth: Record<string, string>) {
  const deadline = Date.now() + 12 * 60 * 1000;
  let state = await snapshot(runId);
  while (Date.now() < deadline) {
    await runEngine(engineStore, { runId, budgetMs: 150_000 });
    state = await snapshot(runId);
    const failed = state.steps.find((step) => step.status === "failed");
    if (failed) throw new Error(`${failed.step_key} ${JSON.stringify(failed.error).slice(0, 240)}`);
    const human = state.steps.find((step) => step.status === "waiting_human");
    if (human) {
      const role = human.checkpoint?.role;
      if (role === "business" || human.block_key === "B32" || human.block_key === "B33") return state;
      const decided = await getApi().request(`/api/steps/${human.id}/decide`, {
        method: "POST", headers: adminAuth, body: JSON.stringify({ decision: "approve", comment: "负责人确认", goto: null }),
      });
      if (!decided.ok) throw new Error(`确认失败 ${decided.status}`);
      continue;
    }
    if (state.run === "completed" || state.steps.some((step) => step.status === "waiting_event")) return state;
    if (state.steps.some((step) => step.status === "running" || step.status === "waiting_model")) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
  }
  throw new Error(`运行没有停在确认点：${state.run} ${state.steps.map((step) => `${step.step_key}:${step.status}`).join(" ")}`);
}

async function account(email: string, password: string, name: string): Promise<string> {
  const signup = await getApi().request("/api/public/auth/signup", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, display_name: name }),
  });
  if (signup.status === 201) {
    const body = await signup.json() as { access_token?: string };
    return body.access_token ?? "";
  }
  const login = await getApi().request("/api/public/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await login.json() as { access_token?: string };
  if (!login.ok || !body.access_token) throw new Error(`${email} 不能登录 ${login.status}`);
  return body.access_token;
}

live("stage 3 wujie loop", () => {
  const created = { driver: false };

  afterAll(async () => {
    if (created.driver) await serviceQuery()("DELETE FROM auth.users WHERE email = $1", [DRIVER]).catch(() => undefined);
  });

  it("walks feedback, a rejection, handoff, a failed acceptance item and v1.2", async () => {
    await getApi();
    const apps = await serviceQuery()("SELECT id FROM public.apps WHERE name = $1", [APP]);
    const appId = String(apps[0]?.["id"] ?? "");
    expect(appId).not.toBe("");
    await serviceQuery()(
      `UPDATE public.step_runs SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL
       WHERE status IN ('running','pending','waiting_model') AND run_id IN (
         SELECT r.id FROM public.workflow_runs r JOIN public.workflows w ON w.id = r.workflow_id
         WHERE w.key IN ('feature_enhance','iteration_release') AND r.status = 'running')`,
    );
    await serviceQuery()(
      `UPDATE public.workflow_runs SET status = 'cancelled', finished_at = now()
       WHERE status = 'running' AND workflow_id IN (SELECT id FROM public.workflows WHERE key IN ('feature_enhance','iteration_release'))`,
    );
    const ready = await serviceQuery()("SELECT to_regclass('public.feedback_items') AS name", []);
    expect(ready[0]?.["name"]).toBe("feedback_items");

    const driverToken = await account(DRIVER, driverPassword, "阶段3验收");
    created.driver = true;
    await serviceQuery()("INSERT INTO public.user_roles(user_id, role) SELECT id, 'admin' FROM auth.users WHERE email = $1 ON CONFLICT DO NOTHING", [DRIVER]);
    const wujieToken = await account(WUJIE, wujiePassword(), "吴姐");
    const wujie = await serviceQuery()("SELECT id FROM auth.users WHERE email = $1", [WUJIE]);
    const wujieId = String(wujie[0]?.["id"] ?? "");
    await serviceQuery()(
      "INSERT INTO public.app_members(app_id, user_id, role) VALUES ($1,$2,'business') ON CONFLICT (app_id, user_id, role) DO NOTHING",
      [appId, wujieId],
    );
    const contact = await serviceQuery()(
      `SELECT c.id FROM public.contacts c JOIN public.app_contacts ac ON ac.contact_id = c.id
       WHERE ac.app_id = $1 AND c.name = '吴姐' LIMIT 1`, [appId],
    );
    if (contact[0]) {
      await serviceQuery()("UPDATE public.contacts SET linked_profile_id = $2 WHERE id = $1", [contact[0]["id"], wujieId]);
    } else {
      const inserted = await serviceQuery()("INSERT INTO public.contacts(name, created_by) VALUES ('吴姐', $1) RETURNING id", [wujieId]);
      await serviceQuery()(
        "INSERT INTO public.app_contacts(app_id, contact_id, app_role, is_business) VALUES ($1,$2,'business',true)",
        [appId, inserted[0]?.["id"]],
      );
      await serviceQuery()("UPDATE public.contacts SET linked_profile_id = $2 WHERE id = $1", [inserted[0]?.["id"], wujieId]);
    }

    const adminAuth = { Authorization: `Bearer ${driverToken}`, "content-type": "application/json" };
    const wujieAuth = { Authorization: `Bearer ${wujieToken}`, "content-type": "application/json" };
    const hidden = await getApi().request(`/api/apps/${appId}/data-model`, { headers: wujieAuth });
    expect(hidden.status).toBe(403);
    const hooks = await getApi().request("/api/admin/hooks", { headers: wujieAuth });
    expect(hooks.status).toBe(403);
    const prototype = await getApi().request(`/api/apps/${appId}/prototype`, { headers: wujieAuth });
    expect(prototype.status).not.toBe(403);

    await serviceQuery()(
      `DELETE FROM public.feedback_items f WHERE f.app_id = $1 AND f.title = '补货建议要按门店改'
       AND NOT EXISTS (SELECT 1 FROM public.cr_feedback c WHERE c.feedback_id = f.id)`, [appId],
    );
    const posted = await getApi().request(`/api/apps/${appId}/feedback`, {
      method: "POST", headers: wujieAuth,
      body: JSON.stringify({ title: "补货建议要按门店改", body: "希望把补货建议改成按门店改数量" }),
    });
    const feedback = await posted.json() as { id?: string };
    expect(posted.status, JSON.stringify(feedback)).toBe(201);
    const triaged = await serviceQuery()("SELECT category, requirement_code FROM public.feedback_items WHERE id = $1", [feedback.id]);
    expect(triaged[0]?.["category"]).toBe("change");
    const withAc = await serviceQuery()(
      `SELECT r.code FROM public.requirements r
       JOIN public.acceptance_criteria a ON a.requirement_id = r.id AND a.requirement_version = r.current_version
       WHERE r.app_id = $1 AND r.status <> 'deprecated' ORDER BY r.code LIMIT 1`, [appId],
    );
    const requirementCode = String(withAc[0]?.["code"] ?? "");
    expect(requirementCode).not.toBe("");
    await serviceQuery()("UPDATE public.feedback_items SET requirement_code = $2 WHERE id = $1", [feedback.id, requirementCode]);

    const changeRes = await getApi().request(`/api/apps/${appId}/changes`, {
      method: "POST", headers: adminAuth,
      body: JSON.stringify({ title: "按门店修改补货数量", feedback_ids: [feedback.id] }),
    });
    const change = await changeRes.json() as { id?: string; iteration_id?: string };
    expect(changeRes.status).toBe(201);
    const workflows = await serviceQuery()("SELECT id, key FROM public.workflows WHERE version = '1.1.0' AND key IN ('feature_enhance','iteration_release') AND startable", []);
    const workflowId = (key: string) => String(workflows.find((row) => row["key"] === key)?.["id"] ?? "");
    expect(workflowId("feature_enhance")).not.toBe("");

    const started = await getApi().request(`/api/apps/${appId}/runs`, {
      method: "POST", headers: adminAuth,
      body: JSON.stringify({ workflow_id: workflowId("feature_enhance"), weight: "light", change_request_id: change.id }),
    });
    const run = await started.json() as { id?: string };
    expect(started.status, JSON.stringify(run)).toBe(201);
    const runId = run.id ?? "";

    let state = await drive(runId, adminAuth);
    expect(state.steps.find((step) => step.block_key === "B32")?.status).toBe("waiting_human");
    const rejected = await getApi().request(`/api/apps/${appId}/changes/${change.id}/confirm`, {
      method: "POST", headers: wujieAuth,
      body: JSON.stringify({ decision: "reject", comment: "请按门店改数量，不要改成按区域" }),
    });
    expect(rejected.status).toBe(200);
    state = await drive(runId, adminAuth);
    expect(state.steps.find((step) => step.block_key === "B32" && step.status === "waiting_human")).toBeTruthy();
    const approved = await getApi().request(`/api/apps/${appId}/changes/${change.id}/confirm`, {
      method: "POST", headers: wujieAuth,
      body: JSON.stringify({ decision: "approve", comment: "同意按门店改" }),
    });
    expect(approved.status).toBe(200);
    state = await drive(runId, adminAuth);
    expect(state.steps.some((step) => step.status === "waiting_event")).toBe(true);

    const tasks = await serviceQuery()(
      `SELECT t.code FROM public.tasks t JOIN public.step_runs s ON s.id = t.created_by_step WHERE s.run_id = $1`, [runId],
    );
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.length).toBeLessThanOrEqual(3);
    for (const task of tasks) {
      const code = String(task["code"]);
      const branch = `sdf/${code}-s3`;
      await gitea("/repos/sdf/replenish/branches", { method: "POST", body: JSON.stringify({ new_branch_name: branch, old_branch_name: "main" }) });
      await gitea(`/repos/sdf/replenish/contents/src/${code.toLowerCase()}-note.ts`, {
        method: "POST",
        body: JSON.stringify({ branch, message: code, content: Buffer.from(`export const note = ${JSON.stringify(code)};\n`).toString("base64") }),
      });
      await gitea("/repos/sdf/replenish/pulls", {
        method: "POST",
        body: JSON.stringify({ head: branch, base: "main", title: `[${code}] 按门店改数量`, body: `SDF-Task: ${code}\n` }),
      });
    }
    await syncPullRequests(appId);
    const handed = await snapshot(runId);
    expect(handed.steps.find((step) => step.block_key === "B15")?.status).toBe("succeeded");
    state = await drive(runId, adminAuth);
    expect(state.run).toBe("completed");

    await serviceQuery()(
      `INSERT INTO public.baselines(app_id, version, snapshot)
       SELECT $1, 'v1.0', COALESCE(jsonb_agg(jsonb_build_object('code', code, 'title', title, 'version', current_version) ORDER BY code), '[]'::jsonb)
       FROM public.requirements WHERE app_id = $1 AND status <> 'deprecated'
       ON CONFLICT (app_id, version) DO NOTHING`, [appId],
    );
    const releaseStart = await getApi().request(`/api/apps/${appId}/runs`, {
      method: "POST", headers: adminAuth,
      body: JSON.stringify({
        workflow_id: workflowId("iteration_release"), weight: "light",
        change_request_id: change.id, iteration_id: change.iteration_id, version: "v1.2",
      }),
    });
    const releaseRun = await releaseStart.json() as { id?: string };
    expect(releaseStart.status).toBe(201);
    state = await drive(releaseRun.id ?? "", adminAuth);
    expect(state.steps.find((step) => step.block_key === "B33")?.status).toBe("waiting_human");
    const assigned = await serviceQuery()("SELECT id, assignee_profile_id FROM public.uat_items WHERE app_id = $1 AND result = 'pending' ORDER BY ac_code LIMIT 1", [appId]);
    expect(String(assigned[0]?.["assignee_profile_id"] ?? "")).toBe(wujieId);
    const failedItem = await getApi().request(`/api/uat/${assigned[0]?.["id"]}`, {
      method: "POST", headers: wujieAuth,
      body: JSON.stringify({ result: "failed", fail_reason: "这个门店改完数量后没有重新计算建议" }),
    });
    const failedBody = await failedItem.json() as { feedback_id?: string };
    expect(failedItem.status).toBe(200);
    expect(failedBody.feedback_id).toBeTruthy();
    const linked = await serviceQuery()("SELECT 1 FROM public.cr_feedback WHERE feedback_id = $1 AND change_request_id = $2", [failedBody.feedback_id, change.id]);
    expect(linked.length).toBe(1);
    const uatStep = state.steps.find((step) => step.block_key === "B33");
    const uatOk = await getApi().request(`/api/steps/${uatStep?.id}/decide`, {
      method: "POST", headers: wujieAuth,
      body: JSON.stringify({ decision: "approve", comment: "其余项通过，不通过的已经记成反馈", goto: null }),
    });
    expect(uatOk.status).toBe(200);
    state = await drive(releaseRun.id ?? "", adminAuth);
    expect(state.run).toBe("completed");

    const notes = await getApi().request(`/api/apps/${appId}/releases`, { headers: wujieAuth });
    const notesText = await notes.text();
    expect(notes.status).toBe(200);
    expect(notesText).toContain("v1.2");
    expect(notesText).not.toContain("notes_technical");
    const compared = await getApi().request(`/api/apps/${appId}/baselines/compare?from=v1.0&to=v1.2`, { headers: wujieAuth });
    const explanation = await compared.json() as { explanation?: string };
    expect(compared.status).toBe(200);
    expect(explanation.explanation ?? "").toMatch(/CR-|DEC-/);
    const original = await serviceQuery()("SELECT status, released_in FROM public.feedback_items WHERE id = $1", [feedback.id]);
    expect(original[0]?.["status"]).toBe("released");
    expect(original[0]?.["released_in"]).toBe("v1.2");
    const bug = await serviceQuery()("SELECT status FROM public.feedback_items WHERE id = $1", [failedBody.feedback_id]);
    expect(bug[0]?.["status"]).not.toBe("released");
  }, 900_000);
});
