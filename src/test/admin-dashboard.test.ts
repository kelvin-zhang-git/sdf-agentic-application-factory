import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { QueryClient } from "@tanstack/react-query";
import { createRouter, rootRouteId } from "@tanstack/react-router";
import { adminDashboardRoutes } from "@/api/routes/admin-dashboard";
import { authMw, onError } from "@/api/middleware";
import { routeTree } from "@/routeTree.gen";
import type { AppEnv, Deps } from "@/api/context";

function createTestApp(isAdmin: boolean) {
  const h = new Hono<AppEnv>();
  const deps = {
    auth: { verify: async () => ({ userId: "test-user", email: null }) },
    userDb: () => ({ rpc: async () => ({ data: isAdmin, error: null }) }),
    sys: { writeServerLog: async () => {} },
  } as unknown as Deps;
  h.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("traceId", "test-trace");
    await next();
  });
  h.use("*", authMw);
  h.onError(onError);
  h.route("/", adminDashboardRoutes);
  return h;
}

describe("admin dashboard permissions & routing", () => {
  it("denies anonymous access to /admin/dashboard", async () => {
    const res = await createTestApp(false).request("/admin/dashboard");
    expect(res.status).toBe(401);
  });

  it("denies non-admin access to /admin/dashboard", async () => {
    const res = await createTestApp(false).request("/admin/dashboard", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("matches /dashboard route in TanStack Router", () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });
    const matches = router.matchRoutes("/dashboard");
    expect(matches.at(-1)?.routeId).toBe("/_authenticated/_wb/dashboard");
    expect(matches.at(-1)?.routeId).not.toBe(rootRouteId);
  });
});
