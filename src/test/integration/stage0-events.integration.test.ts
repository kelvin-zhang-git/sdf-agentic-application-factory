// @vitest-environment node
// S0-06：已登录用户能从 /api/events 立刻收到步骤变更，不需要等 5 秒轮询。
import { afterAll, describe, expect, it } from "vitest";
import { getApi } from "@/adapters/runtime";
import { publishChange } from "@/adapters/scheduler-node";
import { serviceQuery } from "@/adapters/pg-client";

const live = process.env["SDF_PG_SERVICE_PASSWORD"] && process.env["SDF_JWT_SECRET"] ? describe : describe.skip;
const EMAIL = "s006-user@sdf.internal";
const password = `Sdf-${crypto.randomUUID()}`;

async function wipe() {
  await serviceQuery()("DELETE FROM auth.users WHERE email = $1", [EMAIL]);
}

live("stage 0 events", () => {
  afterAll(wipe, 30_000);

  it("pushes a step change over SSE within a second", async () => {
    await wipe();
    const signup = await getApi().request("/api/public/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password, display_name: "实时验收" }),
    });
    const signed = await signup.json() as { access_token?: string; error?: { message?: string } };
    expect(signup.status, signed.error?.message).toBe(201);
    const token = signed.access_token ?? "";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const response = await getApi().request("/api/events", {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");
    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();
    publishChange({ runId: "s006-run" });
    const decoder = new TextDecoder();
    let text = "";
    const started = Date.now();
    while (!text.includes("s006-run") && Date.now() - started < 3000) {
      const chunk = await reader!.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    clearTimeout(timer);
    controller.abort();
    expect(text).toContain("event: changed");
    expect(text).toContain("s006-run");
    expect(Date.now() - started).toBeLessThan(1000);
  }, 20_000);
});
