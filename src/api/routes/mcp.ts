import { Hono } from "hono";
import { mcpStore } from "@/adapters/mcp-store";
import { handleMcp } from "@/core/mcp/protocol";
import type { AppEnv } from "../context";

export const mcpRoutes = new Hono<AppEnv>();

mcpRoutes.get("/mcp", (c) => c.json({
  name: "enterprise-sdf",
  protocol: "2024-11-05",
  endpoint: "/api/mcp",
  auth: "Authorization: Bearer sdf_pat_...",
}));

mcpRoutes.post("/mcp", async (c) => {
  const body = await c.req.json().catch(() => null);
  const result = await handleMcp(mcpStore(), c.get("userId"), body);
  if (result.body === null) return c.body(null, 202);
  return c.json(result.body, result.status as 200 | 400);
});
