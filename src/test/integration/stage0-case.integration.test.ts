// @vitest-environment node
// S0-08：把澄远零售两份工作坊纪要跑完 requirement_only。结束后撤销临时管理员，资料和运行留在种子应用上。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getApi } from "@/adapters/runtime";
import { serviceQuery } from "@/adapters/pg-client";
import { engineStore } from "@/adapters/engine-store";
import { runEngine } from "@/core/engine/runner";

const live = process.env["SDF_PG_SERVICE_PASSWORD"] && process.env["SDF_BOOTSTRAP_TOKEN"] ? describe : describe.skip;
const EMAIL = "s008-admin@sdf.internal";
const password = `Sdf-${crypto.randomUUID()}`;
let owns = false;
let token = "";

function api(method: string, path: string, body?: BodyInit, json = true) {
  return getApi().request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(json && body ? { "content-type": "application/json" } : {}),
      ...(path.endsWith("/bootstrap") ? { "x-sdf-bootstrap-token": process.env["SDF_BOOTSTRAP_TOKEN"] ?? "" } : {}),
    },
    ...(body ? { body } : {}),
  });
}

function minutes(md: string, from: string, to: string): string {
  const start = md.indexOf(from);
  const end = md.indexOf(to, start + from.length);
  const chunk = md.slice(start, end);
  const mark = "### 纪要正文";
  const at = chunk.indexOf(mark);
  return chunk.slice(at + mark.length).trim();
}

async function steps(runId: string) {
  return await serviceQuery()(
    "SELECT id, step_key, status, attempt FROM public.step_runs WHERE run_id = $1 AND is_current ORDER BY seq",
    [runId],
  );
}

async function drive(runId: string, ready: (rows: Record<string, unknown>[]) => boolean) {
  const deadline = Date.now() + 240_000;
  let rows = await steps(runId);
  while (Date.now() < deadline) {
    if (ready(rows)) return rows;
    if (rows.some((r) => r["status"] === "failed")) {
      const err = await serviceQuery()("SELECT step_key, error FROM public.step_runs WHERE run_id = $1 AND status = 'failed' AND is_current", [runId]);
      throw new Error(JSON.stringify(err));
    }
    await runEngine(engineStore, { runId, budgetMs: 60_000 });
    rows = await steps(runId);
  }
  throw new Error(`运行超时：${JSON.stringify(rows)}`);
}

live("stage 0 case", () => {
  afterAll(async () => {
    if (!owns) return;
    await serviceQuery()("DELETE FROM public.system_state", []);
    await serviceQuery()("DELETE FROM auth.users WHERE email = $1", [EMAIL]);
    const left = await serviceQuery()("SELECT public.is_bootstrapped() AS ready", []);
    expect(left[0]?.["ready"]).toBe(false);
  }, 30_000);

  it("runs the two Chengyuan workshops through B01-B04 and produces requirement v2", async () => {
    const existing = await serviceQuery()(
      "SELECT u.email AS email FROM public.system_state s LEFT JOIN auth.users u ON u.id = s.bootstrapped_by",
      [],
    );
    const email = existing[0]?.["email"] ? String(existing[0]["email"]) : "";
    if (email && email !== EMAIL) throw new Error(`系统已由 ${email} 初始化，本测试不会改动`);
    owns = true;
    await serviceQuery()("DELETE FROM public.system_state", []);
    await serviceQuery()("DELETE FROM auth.users WHERE email = $1", [EMAIL]);

    const signup = await getApi().request("/api/public/auth/signup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password, display_name: "案例验收" }),
    });
    const signed = await signup.json() as { access_token?: string; error?: { message?: string } };
    expect(signup.status, signed.error?.message).toBe(201);
    token = signed.access_token ?? "";
    expect((await api("POST", "/api/bootstrap", JSON.stringify({}))).status).toBe(200);

    const apps = await serviceQuery()("SELECT id FROM public.apps WHERE name = $1", ["澄远零售门店智能补货"]);
    const appId = String(apps[0]?.["id"] ?? "");
    expect(appId).not.toBe("");
    const md = readFileSync(resolve(process.cwd(), "../仿真案例-澄远零售门店智能补货.md"), "utf8");
    const texts = [
      ["工作坊纪要一：补货主流程", minutes(md, "## 2. 工作坊纪要一", "## 3. 工作坊纪要二")],
      ["工作坊纪要二：例外与合规", minutes(md, "## 3. 工作坊纪要二", "## 4. 访谈记录")],
    ];
    const sourceIds: string[] = [];
    for (const [title, text] of texts) {
      const form = new FormData();
      form.set("title", title ?? "");
      form.set("kind", "minutes");
      form.set("text", text ?? "");
      const uploaded = await api("POST", `/api/apps/${appId}/sources`, form, false);
      const body = await uploaded.json() as { id?: string; error?: { message?: string } };
      expect(uploaded.status, body.error?.message).toBe(201);
      sourceIds.push(body.id ?? "");
    }
    const wf = await serviceQuery()("SELECT id FROM public.workflows WHERE key = 'requirement_only' AND startable ORDER BY version DESC", []);
    const started = await api("POST", `/api/apps/${appId}/runs`, JSON.stringify({
      workflow_id: String(wf[0]?.["id"]), weight: "light", source_ids: sourceIds,
    }));
    const runBody = await started.json() as { id?: string; error?: { message?: string } };
    expect(started.status, runBody.error?.message).toBe(201);
    const runId = runBody.id ?? "";

    let rows = await drive(runId, (list) => list.some((r) => r["step_key"] === "analyze" && r["status"] === "waiting_human" && r["attempt"] === 1));
    const first = rows.find((r) => r["step_key"] === "analyze")!;
    const rejected = await api("POST", `/api/steps/${first["id"]}/decide`, JSON.stringify({ decision: "reject", comment: "请把促销和在途写进补货规则", goto: "organize" }));
    const rejectedBody = await rejected.json() as { error?: { message?: string } };
    expect(rejected.status, rejectedBody.error?.message).toBe(200);

    rows = await drive(runId, (list) => list.some((r) => r["step_key"] === "analyze" && r["status"] === "waiting_human" && Number(r["attempt"]) >= 2));
    const blockers = await serviceQuery()(
      "SELECT id FROM public.analysis_findings WHERE app_id = $1 AND status = 'open' AND severity = 'blocker'",
      [appId],
    );
    for (const finding of blockers) {
      const closed = await api("PATCH", `/api/findings/${finding["id"]}`, JSON.stringify({ status: "resolved" }));
      expect(closed.status).toBe(200);
    }
    const second = rows.find((r) => r["step_key"] === "analyze")!;
    const approved = await api("POST", `/api/steps/${second["id"]}/decide`, JSON.stringify({ decision: "approve", comment: "确认通过", goto: null }));
    const approvedBody = await approved.json() as { error?: { message?: string } };
    expect(approved.status, approvedBody.error?.message).toBe(200);

    await drive(runId, (list) => list.some((r) => r["step_key"] === "clarify" && r["status"] === "succeeded"));
    const questions = await api("GET", `/api/apps/${appId}/questions`);
    const items = ((await questions.json()) as { items?: { id: string; status: string }[] }).items ?? [];
    const open = items.find((q) => q.status === "open") ?? items[0];
    expect(open, "B04 没有产生澄清问题").toBeTruthy();
    expect((await api("PATCH", `/api/questions/${open!.id}`, JSON.stringify({ answer: "促销日和在途库存都要计入建议量，店长可以改数量但不能直接提交采购订单。" }))).status).toBe(200);
    const applied = await api("POST", `/api/apps/${appId}/questions/apply`, JSON.stringify({}));
    const appliedBody = await applied.json() as { updated?: number; error?: { message?: string } };
    expect(applied.status, appliedBody.error?.message).toBe(200);
    expect(appliedBody.updated ?? 0).toBeGreaterThan(0);
    const versions = await serviceQuery()(
      "SELECT max(v.version)::int AS version FROM public.requirement_versions v JOIN public.requirements r ON r.id = v.requirement_id WHERE r.app_id = $1",
      [appId],
    );
    expect(Number(versions[0]?.["version"] ?? 0)).toBeGreaterThanOrEqual(2);
  }, 420_000);
});
