// @vitest-environment node
// 阶段 2：Gitea 交接、超范围合并请求、只上传 JUnit 时漏洞项必须是未执行。不删除管理员，不重跑澄远全流程。
import { afterAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { publishHandoff } from "@/adapters/stage2-store";
import { createServiceDb, serviceQuery } from "@/adapters/pg-client";
import { getApi } from "@/adapters/runtime";

const live = process.env["SDF_PG_SERVICE_PASSWORD"] && process.env["GITEA_TOKEN"] ? describe : describe.skip;
const EMAIL = "s2-driver@sdf.internal";
const PROBE = "交接探针";
const password = `Sdf-${crypto.randomUUID()}`;
const hookSecret = `hook-${crypto.randomUUID()}`;

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
  const text = await response.text();
  if (!response.ok && response.status !== 409 && response.status !== 422) throw new Error(`${response.status} ${path} ${text.slice(0, 180)}`);
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

live("stage 2 gitea handoff", () => {
  const created: { appId: string; user: boolean } = { appId: "", user: false };

  afterAll(async () => {
    if (created.appId) await serviceQuery()("DELETE FROM public.apps WHERE id = $1", [created.appId]).catch(() => undefined);
    if (created.user) await serviceQuery()("DELETE FROM auth.users WHERE email = $1", [EMAIL]).catch(() => undefined);
  });

  it("hands off a probe task, flags an out-of-scope file, and leaves the scan not executed", async () => {
    await serviceQuery()("DELETE FROM public.apps WHERE name = $1", [PROBE]);
    await gitea("/orgs", { method: "POST", body: JSON.stringify({ username: "sdf", visibility: "private" }) });
    for (const repo of ["probe", "replenish"]) {
      await gitea("/orgs/sdf/repos", { method: "POST", body: JSON.stringify({ name: repo, private: true, auto_init: true, default_branch: "main" }) });
    }

    await serviceQuery()("DELETE FROM auth.users WHERE email = $1", [EMAIL]);
    const signup = await getApi().request("/api/public/auth/signup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password, display_name: "阶段2验收" }),
    });
    const signed = await signup.json() as { access_token?: string; error?: { message?: string } };
    expect(signup.status, signed.error?.message).toBe(201);
    created.user = true;
    await serviceQuery()("INSERT INTO public.user_roles(user_id, role) SELECT id, 'admin' FROM auth.users WHERE email = $1 ON CONFLICT DO NOTHING", [EMAIL]);
    const token = signed.access_token ?? "";
    const auth = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
    const appRes = await getApi().request("/api/apps", { method: "POST", headers: auth, body: JSON.stringify({ name: PROBE, classification: "internal" }) });
    const app = await appRes.json() as { id?: string; error?: { message?: string } };
    expect(appRes.status, app.error?.message).toBe(201);
    created.appId = app.id ?? "";
    const users = await serviceQuery()("SELECT id FROM auth.users WHERE email = $1", [EMAIL]);
    const userId = String(users[0]?.["id"] ?? "");
    const source = await serviceQuery()(
      `INSERT INTO public.sources(code, app_id, kind, title, parse_status, created_by) VALUES ('SRC-0001', $1, 'document', '探针资料', 'parsed', $2) RETURNING id`,
      [created.appId, userId],
    );
    const segment = await serviceQuery()(
      `INSERT INTO public.source_segments(source_id, app_id, seq, text) VALUES ($1, $2, 1, '探针结果要能看见') RETURNING id`,
      [source[0]?.["id"], created.appId],
    );
    await serviceQuery()(
      `INSERT INTO public.requirements(code, app_id, title, story, citations)
       VALUES ('REQ-0001', $1, '探针需求', '用于交接验收', jsonb_build_array(jsonb_build_object('segment_id', $2::text)))`,
      [created.appId, segment[0]?.["id"]],
    );
    const requirement = await serviceQuery()("SELECT id FROM public.requirements WHERE app_id = $1 AND code = 'REQ-0001'", [created.appId]);
    await serviceQuery()(
      `INSERT INTO public.acceptance_criteria(code, requirement_id, app_id, format, text, requirement_version) VALUES ('AC-0001-01', $1, $2, 'ears', '页面能看到探针结果', 1)`,
      [requirement[0]?.["id"], created.appId],
    );
    const written = await createServiceDb().rpc("sdf_write_artifact", {
      _app: created.appId,
      _a: { type: "context_pack", key: "T-0001", title: "T-0001 上下文包", content: "# T-0001\n\n## 允许修改\n\nsrc/**\n\nSDF-Task: T-0001\n" },
      _step: null, _actor: null, _source: "agent",
    });
    expect(written.error).toBeNull();
    const pack = [{ id: written.data }];
    await serviceQuery()(
      `INSERT INTO public.tasks(app_id, code, title, description, requirement_codes, ac_codes, allowed_paths, forbidden_paths, context_artifact_id)
       VALUES ($1, 'T-0001', '探针任务', '只改 src', ARRAY['REQ-0001'], ARRAY['AC-0001-01'], ARRAY['src/**'], ARRAY['.env','**/.env'], $2)`,
      [created.appId, pack[0]?.["id"]],
    );
    const workflows = await serviceQuery()("SELECT id FROM public.workflows WHERE key = 'new_app_small' AND version = '1.1.0'", []);
    expect(String(workflows[0]?.["id"] ?? "")).not.toBe("");
    const run = await serviceQuery()(
      `INSERT INTO public.workflow_runs(code, app_id, workflow_id, workflow_snapshot, weight, status, current_step_key, started_by, trace_id)
       VALUES ('R-0099', $1, $2, '{}'::jsonb, 'standard', 'waiting_event', 'handoff', $3, 'stage2') RETURNING id`,
      [created.appId, workflows[0]?.["id"], users[0]?.["id"]],
    );
    const runId = String(run[0]?.["id"]);
    await serviceQuery()(
      `INSERT INTO public.step_runs(run_id, app_id, step_key, stage, block_key, seq, status)
       VALUES ($1, $2, 'handoff', '开发', 'B15', 1, 'waiting_event')`,
      [runId, created.appId],
    );

    const saved = await getApi().request("/api/connectors", {
      method: "POST", headers: auth,
      body: JSON.stringify({
        app_id: created.appId, name: "vm-9 Gitea", vendor: "gitea", capability: "code_repo",
        base_url: "http://git.example.com:3002/api/v1", token: giteaToken(), webhook_secret: hookSecret,
        owner: "sdf", repo: "probe", default_branch: "main",
      }),
    });
    const connector = await saved.json() as { id?: string; error?: { message?: string } };
    expect(saved.status, connector.error?.message).toBe(201);
    const tested = await getApi().request(`/api/connectors/${connector.id}/test`, { method: "POST", headers: auth });
    expect(tested.status, await tested.text()).toBe(200);

    const handed = await publishHandoff(created.appId, runId, "R-0099");
    expect(handed.branch).toBe("sdf/handoff-R-0099");
    const branch = await gitea("/repos/sdf/probe/contents/context/T-0001.md?ref=sdf/handoff-R-0099");
    expect(String(branch["content"] ?? "").length).toBeGreaterThan(10);

    await gitea("/repos/sdf/probe/branches", { method: "POST", body: JSON.stringify({ new_branch_name: "sdf/T-0001-extra", old_branch_name: "main" }) });
    const file = (path: string, content: string) => gitea(`/repos/sdf/probe/contents/${path}`, {
      method: "POST",
      body: JSON.stringify({ branch: "sdf/T-0001-extra", message: `add ${path}`, content: Buffer.from(content).toString("base64") }),
    });
    await file("src/ok.ts", "export const ok = true;\n");
    await file(".env", "SECRET=1\n");
    const pull = await gitea("/repos/sdf/probe/pulls", {
      method: "POST",
      body: JSON.stringify({ head: "sdf/T-0001-extra", base: "main", title: "[T-0001] 探针", body: "SDF-Task: T-0001\n" }),
    });
    const raw = JSON.stringify({
      pull_request: { id: pull["id"], number: pull["number"], title: "[T-0001] 探针", body: "SDF-Task: T-0001\n", html_url: pull["html_url"], state: "open", merged: false, head: { ref: "sdf/T-0001-extra" }, user: { login: "sdf-admin" } },
      repository: { full_name: "sdf/probe" },
    });
    const signature = createHmac("sha256", hookSecret).update(raw).digest("hex");
    const hooked = await getApi().request(`/api/public/hooks/scm/${connector.id}`, {
      method: "POST", headers: { "content-type": "application/json", "x-gitea-signature": signature }, body: raw,
    });
    const claimed = await hooked.json() as { matched?: string; out_of_scope_files?: string[]; error?: { message?: string } };
    expect(hooked.status, claimed.error?.message).toBe(200);
    expect(claimed.matched).toBe("T-0001");
    expect(claimed.out_of_scope_files).toContain(".env");
    const step = await serviceQuery()("SELECT status FROM public.step_runs WHERE run_id = $1 AND is_current", [runId]);
    expect(step[0]?.["status"]).toBe("succeeded");

    const issued = await getApi().request(`/api/apps/${created.appId}/ingest-tokens`, {
      method: "POST", headers: auth, body: JSON.stringify({ name: "探针流水线" }),
    });
    const ingest = await issued.json() as { token?: string };
    expect(issued.status).toBe(201);
    const junit = `<?xml version="1.0"?><testsuite><testcase name="AC-0001-01 探针结果可见"/></testsuite>`;
    const uploaded = await getApi().request("/api/public/hooks/ingest/reports", {
      method: "POST", headers: { Authorization: `Bearer ${ingest.token}`, "content-type": "application/json" },
      body: JSON.stringify({ junit }),
    });
    expect(uploaded.status).toBe(200);
    const gateRes = await getApi().request(`/api/apps/${created.appId}/gates/run`, { method: "POST", headers: auth });
    const gate = await gateRes.json() as { items?: { item_key: string; status: string; numerator: number | null; denominator: number | null }[] };
    expect(gateRes.status).toBe(200);
    expect(gate.items?.find((item) => item.item_key === "ac_coverage")).toMatchObject({ status: "PASSED", numerator: 1, denominator: 1 });
    expect(gate.items?.find((item) => item.item_key === "sarif_high")?.status).toBe("NOT_EXECUTED");

    const chengyuan = await serviceQuery()(
      `SELECT r.id, r.code FROM public.workflow_runs r JOIN public.apps a ON a.id = r.app_id
       WHERE a.name = '澄远零售门店智能补货' AND r.status = 'completed' ORDER BY r.started_at DESC LIMIT 1`, [],
    );
    if (chengyuan[0]) {
      const chengyuanId = String((await serviceQuery()("SELECT id FROM public.apps WHERE name = '澄远零售门店智能补货'", []))[0]?.["id"]);
      await serviceQuery()(
        `INSERT INTO public.app_connectors(app_id, connector_id, capability, binding) VALUES ($1,$2,'code_repo',$3::jsonb)
         ON CONFLICT (app_id, capability) DO UPDATE SET connector_id = EXCLUDED.connector_id, binding = EXCLUDED.binding`,
        [chengyuanId, connector.id, { owner: "sdf", repo: "replenish", default_branch: "main" }],
      );
      const pushed = await publishHandoff(chengyuanId, String(chengyuan[0]["id"]), String(chengyuan[0]["code"]));
      expect(pushed.branch).toBe(`sdf/handoff-${chengyuan[0]["code"]}`);
    }
  }, 180000);
});
