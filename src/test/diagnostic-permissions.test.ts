import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { diagnosticRoutes } from "@/api/routes/diagnostics";
import { authMw, onError } from "@/api/middleware";
import type { AppEnv, Deps } from "@/api/context";

function app() {
  const h = new Hono<AppEnv>();
  const deps = { auth: { verify: async () => ({userId:"test-user",email:null}) }, userDb: () => ({rpc:async () => ({data:false,error:null})}), sys: {writeServerLog:async () => {}} } as unknown as Deps;
  h.use("*",async (c,next) => {c.set("deps",deps);c.set("traceId","test-trace");await next();});
  h.use("*",authMw); h.onError(onError);h.route("/",diagnosticRoutes);return h;
}
describe("diagnostics permissions",() => {
  for (const path of ["/admin/logs","/admin/diagnostics","/admin/health"]) {
    it(`denies non-admin ${path}`,async () => { const response=await app().request(path,{headers:{Authorization:"Bearer test"}}); expect(response.status).toBe(403);expect((await response.json()).error.code).toBe("FORBIDDEN"); });
  }
  it("denies anonymous client reporting",async () => {const response=await app().request("/client-errors",{method:"POST"});expect(response.status).toBe(401);});
});