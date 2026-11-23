import { describe, expect, it, vi } from "vitest";
import { createApi } from "@/api/app";
import type { Deps } from "@/api/context";

function setup(bootstrapped: boolean) {
  const bootstrapAdmin = vi.fn(async () => true);
  const writeAudit = vi.fn(async () => {});
  const deps = {
    auth: { verify: async () => ({ userId: "verified-user", email: null }) },
    userDb: () => ({ rpc: async () => ({ data: false, error: null }) }),
    env: { get: (name: string) => name === "SDF_BOOTSTRAP_TOKEN" ? "test-only-token" : undefined },
    sys: { isBootstrapped: async () => bootstrapped, bootstrapAdmin, writeAudit, writeServerLog: async () => {} },
  } as unknown as Deps;
  return { app: createApi(deps), bootstrapAdmin, writeAudit };
}
describe("bootstrap and administrator boundaries", () => {
  it("uses the verified token user, not a request-body user ID", async () => {
    const { app, bootstrapAdmin, writeAudit } = setup(false);
    const response = await app.request("/api/bootstrap", { method: "POST", headers: { Authorization: "Bearer test", "X-SDF-Bootstrap-Token": "test-only-token", "Content-Type": "application/json" }, body: JSON.stringify({ user_id: "attacker" }) });
    expect(response.status).toBe(200); expect(bootstrapAdmin).toHaveBeenCalledWith("verified-user");
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ actor_id: "verified-user", action: "system.bootstrap_admin" }));
  });
  it("returns 410 without attempting bootstrap after initialization", async () => {
    const { app, bootstrapAdmin } = setup(true);
    const response = await app.request("/api/bootstrap", { method: "POST", headers: { Authorization: "Bearer test" } });
    expect(response.status).toBe(410); expect(bootstrapAdmin).not.toHaveBeenCalled();
  });
  it("rejects non-admin metadata access", async () => {
    const { app } = setup(true); const response = await app.request("/api/meta", { headers: { Authorization: "Bearer test" } });
    expect(response.status).toBe(403); expect((await response.json()).error.code).toBe("FORBIDDEN");
  });
  it("keeps the external cron endpoint closed without its secret", async () => {
    const { app } = setup(true); const response = await app.request("/api/public/hooks/cron", { method: "POST", body: "{}" });
    expect(response.status).toBe(403); expect((await response.json()).error.code).toBe("FORBIDDEN");
  });
});