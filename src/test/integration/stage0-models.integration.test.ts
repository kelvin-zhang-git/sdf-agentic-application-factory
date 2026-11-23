// @vitest-environment node
// S0-05：把本机 LiteLLM 配进平台，测三档连通、机密应用拦截和手机号脱敏。测完撤销临时管理员，模型配置留下。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getApi } from "@/adapters/runtime";
import { serviceQuery } from "@/adapters/pg-client";

const live = process.env["SDF_PG_SERVICE_PASSWORD"] && process.env["SDF_BOOTSTRAP_TOKEN"] && process.env["LITELLM_MASTER_KEY"]
  ? describe : describe.skip;
const EMAIL = "s005-admin@sdf.internal";
const PROVIDER = "vm-9 LiteLLM";
const password = `Sdf-${crypto.randomUUID()}`;
const phone = "13812348000";
let owns = false;
let token = "";
const appIds: string[] = [];

function request(method: string, path: string, body?: unknown) {
  return getApi().request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(path.endsWith("/bootstrap") ? { "x-sdf-bootstrap-token": process.env["SDF_BOOTSTRAP_TOKEN"] ?? "" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function wipeAdmin() {
  if (appIds.length) await serviceQuery()("DELETE FROM public.apps WHERE id = ANY($1::uuid[])", [appIds]);
  await serviceQuery()("DELETE FROM public.apps WHERE name IN ('机密探针', '脱敏探针')", []);
  await serviceQuery()("DELETE FROM public.system_state", []);
  await serviceQuery()("DELETE FROM auth.users WHERE email = $1", [EMAIL]);
}

live("stage 0 models", () => {
  beforeAll(async () => {
    const rows = await serviceQuery()(
      "SELECT u.email AS email FROM public.system_state s LEFT JOIN auth.users u ON u.id = s.bootstrapped_by",
      [],
    );
    const email = rows[0]?.["email"] ? String(rows[0]["email"]) : "";
    if (email && email !== EMAIL) throw new Error(`系统已由 ${email} 初始化，本测试不会改动`);
    owns = true;
    await serviceQuery()(
      "DELETE FROM public.model_routes WHERE provider_id IN (SELECT id FROM public.llm_providers WHERE name = $1)",
      [PROVIDER],
    );
    await serviceQuery()("DELETE FROM public.llm_providers WHERE name = $1", [PROVIDER]);
    await wipeAdmin();
  }, 30_000);

  afterAll(async () => {
    if (!owns) return;
    await wipeAdmin();
    const left = await serviceQuery()("SELECT public.is_bootstrapped() AS ready", []);
    expect(left[0]?.["ready"]).toBe(false);
    const kept = await serviceQuery()("SELECT count(*)::int AS n FROM public.llm_providers WHERE name = $1 AND enabled", [PROVIDER]);
    expect(kept[0]?.["n"]).toBe(1);
  }, 30_000);

  it("connects three tiers, blocks confidential apps, and redacts a phone number", async () => {
    const signup = await getApi().request("/api/public/auth/signup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password, display_name: "模型验收" }),
    });
    const signed = await signup.json() as { access_token?: string; error?: { message?: string } };
    expect(signup.status, signed.error?.message).toBe(201);
    token = signed.access_token ?? "";
    expect((await request("POST", "/api/bootstrap", {})).status).toBe(200);

    const created = await request("POST", "/api/admin/models/providers", {
      name: PROVIDER, base_url: "http://llm.example.com:4000/v1",
      models: ["sdf-fast", "sdf-standard", "sdf-deep"],
      api_key: process.env["LITELLM_MASTER_KEY"], allowed_for_sensitive: false, enabled: true, priority: 1,
    });
    const provider = await created.json() as { id?: string; key_last4?: string; error?: { message?: string } };
    expect(created.status, provider.error?.message).toBe(201);
    expect(provider.key_last4).toBe((process.env["LITELLM_MASTER_KEY"] ?? "").slice(-4));
    const providerId = provider.id ?? "";

    for (const [tier, model] of [["fast", "sdf-fast"], ["standard", "sdf-standard"], ["deep", "sdf-deep"]] as const) {
      const route = await request("POST", "/api/admin/models/routes", { task_tier: tier, provider_id: providerId, model, fallback_order: 1 });
      const routeBody = await route.json() as { error?: { message?: string } };
      expect(route.status, routeBody.error?.message).toBe(201);
      const tested = await request("POST", `/api/admin/models/providers/${providerId}/test`, { model });
      const testBody = await tested.json() as { ok?: boolean; error?: { code?: string; message?: string } };
      expect(tested.status, testBody.error?.message).toBe(200);
      expect(testBody.ok, testBody.error?.message).toBe(true);
    }

    const secret = await request("POST", "/api/apps", { name: "机密探针", description: "验收后删除", classification: "confidential", redact_before_llm: true });
    const secretApp = await secret.json() as { id?: string; error?: { message?: string } };
    expect(secret.status, secretApp.error?.message).toBe(201);
    appIds.push(secretApp.id ?? "");
    const blocked = await request("POST", "/api/admin/models/invoke", {
      app_id: secretApp.id, task_tier: "fast", messages: [{ role: "user", content: "你好" }], max_tokens: 8,
    });
    const blockedBody = await blocked.json() as { error?: { code?: string } };
    expect(blocked.status).toBe(400);
    expect(blockedBody.error?.code).toBe("LLM_SENSITIVE_FORBIDDEN");

    const plain = await request("POST", "/api/apps", { name: "脱敏探针", description: "验收后删除", classification: "internal", redact_before_llm: true });
    const plainApp = await plain.json() as { id?: string; error?: { message?: string } };
    expect(plain.status, plainApp.error?.message).toBe(201);
    appIds.push(plainApp.id ?? "");
    const called = await request("POST", "/api/admin/models/invoke", {
      app_id: plainApp.id, task_tier: "standard", max_tokens: 64,
      messages: [{ role: "user", content: `请原样回复这个手机号，不要解释：${phone}` }],
    });
    const calledBody = await called.json() as { ok?: boolean; redacted?: boolean; content?: string; error?: { message?: string } };
    expect(called.status, calledBody.error?.message).toBe(200);
    expect(calledBody.ok).toBe(true);
    expect(calledBody.redacted).toBe(true);
    expect(calledBody.content ?? "").not.toContain(phone);
  }, 300_000);
});
