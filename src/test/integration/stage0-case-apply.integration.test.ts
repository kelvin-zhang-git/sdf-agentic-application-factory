// @vitest-environment node
// 澄远案例的工作流已经跑完。这里只补「录入回答并生成新版本」，不再重跑整条工作流。
import { afterAll, describe, expect, it } from "vitest";
import { getApi } from "@/adapters/runtime";
import { serviceQuery } from "@/adapters/pg-client";

const live = process.env["SDF_PG_SERVICE_PASSWORD"] && process.env["SDF_BOOTSTRAP_TOKEN"] ? describe : describe.skip;
const EMAIL = "s008-admin@sdf.internal";
const password = `Sdf-${crypto.randomUUID()}`;
let owns = false;
let token = "";

function api(method: string, path: string, body?: string) {
  return getApi().request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(path.endsWith("/bootstrap") ? { "x-sdf-bootstrap-token": process.env["SDF_BOOTSTRAP_TOKEN"] ?? "" } : {}),
    },
    ...(body ? { body } : {}),
  });
}

live("stage 0 case answer", () => {
  afterAll(async () => {
    if (!owns) return;
    await serviceQuery()("DELETE FROM public.system_state", []);
    await serviceQuery()("DELETE FROM auth.users WHERE email = $1", [EMAIL]);
  }, 30_000);

  it("applies an answer and writes a new requirement version", async () => {
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
    expect((await api("POST", "/api/bootstrap", "{}")).status).toBe(200);

    const apps = await serviceQuery()("SELECT id FROM public.apps WHERE name = $1", ["澄远零售门店智能补货"]);
    const appId = String(apps[0]?.["id"] ?? "");
    const open = await serviceQuery()(
      "SELECT id FROM public.clarification_questions WHERE app_id = $1 AND status = 'open' ORDER BY code LIMIT 1",
      [appId],
    );
    const qid = String(open[0]?.["id"] ?? "");
    expect(qid).not.toBe("");
    const answered = await api("PATCH", `/api/questions/${qid}`, JSON.stringify({
      answer: "缺货由仓配计划员确认。确认前建议量保持不变，确认后才通知店长，不能直接生成采购订单。",
    }));
    expect(answered.status).toBe(200);
    const applied = await api("POST", `/api/apps/${appId}/questions/apply`);
    const body = await applied.json() as { updated?: number; unmatched?: string[]; error?: { message?: string } };
    expect(applied.status, body.error?.message).toBe(200);
    expect(body.updated ?? 0, `未匹配编号：${(body.unmatched ?? []).join(",")}`).toBeGreaterThan(0);
    const versions = await serviceQuery()(
      "SELECT max(v.version)::int AS version FROM public.requirement_versions v JOIN public.requirements r ON r.id = v.requirement_id WHERE r.app_id = $1",
      [appId],
    );
    expect(Number(versions[0]?.["version"] ?? 0)).toBeGreaterThanOrEqual(2);
  }, 120_000);
});
