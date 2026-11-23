import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { exampleRoutes } from "@/api/routes/examples";
import { authMw, onError } from "@/api/middleware";
import type { AppEnv, Deps } from "@/api/context";
describe("example artifact permissions", () => {
  function setup() {
    const from = vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }));
    const deps = { auth: { verify: async () => ({ userId: "member", email: null }) }, userDb: () => ({ from }), sys: { writeServerLog: async () => {} } } as unknown as Deps;
    const h = new Hono<AppEnv>(); h.onError(onError);
    h.use("*", async (c, next) => { c.set("deps", deps); c.set("traceId", "test-trace"); await next(); }); h.use("*", authMw); h.route("/", exampleRoutes);
    return { h, from };
  }
  it("denies anonymous artifact reads", async () => { const { h, from } = setup(); const response = await h.request("/apps/1c000000-0000-4000-8000-000000000001/artifacts"); expect(response.status).toBe(401); expect(from).not.toHaveBeenCalled(); });
  it("does not query artifacts when caller cannot see the application", async () => { const { h, from } = setup(); const response = await h.request("/apps/1c000000-0000-4000-8000-000000000001/artifacts", { headers: { Authorization: "Bearer test" } }); expect(response.status).toBe(404); expect(from.mock.calls).toEqual([["apps"]]); });
});