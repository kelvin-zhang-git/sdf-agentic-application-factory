// @vitest-environment node
// 阶段 4：搜索、自定义工作流、评论提及、智能体提示词和新版本、脱敏导出。测完删除临时数据。
import { afterAll, describe, expect, it } from "vitest";
import { serviceQuery } from "@/adapters/pg-client";
import { getApi } from "@/adapters/runtime";

const live = process.env["SDF_PG_SERVICE_PASSWORD"] ? describe : describe.skip;
const EMAIL = "s4-release@sdf.internal";
const APP = "阶段4验收";
const password = `Sdf-${crypto.randomUUID()}`;

live("stage 4 release surface", () => {
  const created = { appId: "", user: false, workflowId: "", architectVersion: 0 };

  afterAll(async () => {
    if (created.workflowId) await serviceQuery()("DELETE FROM public.workflows WHERE id = $1 AND is_builtin = false", [created.workflowId]).catch(() => undefined);
    if (created.appId) await serviceQuery()("DELETE FROM public.apps WHERE id = $1", [created.appId]).catch(() => undefined);
    if (created.architectVersion > 1) await serviceQuery()("DELETE FROM public.agent_prompt_versions WHERE role_key = 'architect' AND version = $1", [created.architectVersion]).catch(() => undefined);
    if (created.user) await serviceQuery()("DELETE FROM auth.users WHERE email = $1", [EMAIL]).catch(() => undefined);
  });

  it("searches, saves a workflow, mentions a person, versions a prompt, and exports a redacted bundle", async () => {
    await serviceQuery()("DELETE FROM public.apps WHERE name = $1", [APP]);
    await serviceQuery()("DELETE FROM auth.users WHERE email = $1", [EMAIL]);
    const signup = await getApi().request("/api/public/auth/signup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password, display_name: "阶段4验收" }),
    });
    const signed = await signup.json() as { access_token?: string; error?: { message?: string } };
    expect(signup.status, signed.error?.message).toBe(201);
    created.user = true;
    await serviceQuery()("INSERT INTO public.user_roles(user_id, role) SELECT id, 'admin' FROM auth.users WHERE email = $1 ON CONFLICT DO NOTHING", [EMAIL]);
    const auth = { Authorization: `Bearer ${signed.access_token}`, "content-type": "application/json" };

    const found = await getApi().request("/api/search?q=REQ-", { headers: auth });
    const hits = await found.json() as { items?: { code: string }[] };
    expect(found.status).toBe(200);
    expect(Array.isArray(hits.items)).toBe(true);

    const yaml = "key: stage4_check\nname: 阶段4检查\nsteps:\n  - key: import\n    name: 导入\n    stage: 需求\n    block: B01\n    weights: [standard]\n    checkpoints: {}\n  - key: organize\n    name: 整理\n    stage: 需求\n    block: B02\n    weights: [standard]\n    checkpoints: {}\n    when: weight == 'standard'\n";
    const checked = await getApi().request("/api/workflows/validate", { method: "POST", headers: auth, body: JSON.stringify({ yaml }) });
    const checkBody = await checked.json() as { issues?: string[] };
    expect(checked.status).toBe(200);
    expect(checkBody.issues ?? []).toEqual([]);

    const appRes = await getApi().request("/api/apps", { method: "POST", headers: auth, body: JSON.stringify({ name: APP, classification: "internal" }) });
    const app = await appRes.json() as { id?: string };
    expect(appRes.status).toBe(201);
    created.appId = app.id ?? "";
    const saved = await getApi().request("/api/workflows", {
      method: "POST", headers: auth,
      body: JSON.stringify({ app_id: created.appId, key: "stage4_check", name: "阶段4检查", yaml }),
    });
    const workflow = await saved.json() as { id?: string; startable?: boolean; error?: { message?: string } };
    expect(saved.status, workflow.error?.message).toBe(201);
    expect(workflow.startable).toBe(true);
    created.workflowId = workflow.id ?? "";

    const note = await getApi().request(`/api/apps/${created.appId}/comments`, {
      method: "POST", headers: auth, body: JSON.stringify({ body: `请看一下 @${EMAIL}` }),
    });
    expect(note.status).toBe(201);
    const inbox = await getApi().request("/api/inbox", { headers: auth });
    const bundle = await inbox.json() as { mentions?: { body: string }[] };
    expect((bundle.mentions ?? []).some((row) => row.body.includes(EMAIL))).toBe(true);

    const agents = await getApi().request("/api/agents", { headers: auth });
    const roles = await agents.json() as { items?: { key: string }[] };
    expect(roles.items?.length).toBe(10);
    const prompt = await getApi().request("/api/agents/architect/prompts", {
      method: "POST", headers: auth, body: JSON.stringify({ prompt: "你是架构师。只用中文，不要输出密钥。" }),
    });
    const version = await prompt.json() as { version?: number };
    expect(prompt.status).toBe(201);
    expect(version.version).toBeGreaterThan(1);
    created.architectVersion = version.version ?? 0;

    const packed = await getApi().request(`/api/apps/${created.appId}/export-bundle`, { headers: auth });
    const bytes = new Uint8Array(await packed.arrayBuffer());
    expect(packed.status).toBe(200);
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });
});
