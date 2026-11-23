import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { resolveTemplateChoice, type TemplateSnapshot } from "@/core/document-template";
import { renderTemplatePlaceholders } from "@/core/docx-export";
import { templateRoutes } from "@/api/routes/document-templates";
import { authMw, onError } from "@/api/middleware";
import type { AppEnv, Deps } from "@/api/context";

function snap(name: string, status = "active"): TemplateSnapshot {
  return {
    id: name, key: name, name, status, version: 1,
    header_text: "{{app_name}}", footer_text: "页脚", show_page_numbers: true,
    cover: { app_name: true, classification: true, artifact_version: true, generated_at: true, step_info: false, agent_role: false },
    style_config: { accent: "FF462D" },
  };
}

describe("document template choice", () => {
  const standard = snap("标准交付文档");
  it("uses an active binding before the global default", () => {
    const chosen = resolveTemplateChoice({ bound: { status: "active", snap: snap("评审稿") }, globalDefault: snap("默认"), standard });
    expect(chosen.name).toBe("评审稿");
  });
  it("skips a retired binding and then a retired default", () => {
    expect(resolveTemplateChoice({
      bound: { status: "retired", snap: snap("旧", "retired") },
      globalDefault: snap("默认", "retired"),
      standard,
    }).name).toBe("标准交付文档");
  });
  it("fills placeholders without leaving the braces", () => {
    expect(renderTemplatePlaceholders("{{ app_name }} · {{classification}}", { app_name: "极光", classification: "内部" })).toBe("极光 · 内部");
  });
});

describe("document template admin", () => {
  it("denies a non-admin listing templates", async () => {
    const h = new Hono<AppEnv>();
    const deps = { auth: { verify: async () => ({ userId: "test-user", email: null }) }, userDb: () => ({ rpc: async () => ({ data: false, error: null }) }), sys: { writeServerLog: async () => {} } } as unknown as Deps;
    h.use("*", async (c, next) => { c.set("deps", deps); c.set("traceId", "test-trace"); await next(); });
    h.use("*", authMw);
    h.onError(onError);
    h.route("/", templateRoutes);
    const response = await h.request("/admin/document-templates", { headers: { Authorization: "Bearer test" } });
    expect(response.status).toBe(403);
  });
});
