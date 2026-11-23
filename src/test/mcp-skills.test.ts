import { describe, expect, it } from "vitest";
import { codingSkillFiles } from "@/core/coding-skills";
import { handleMcp, type McpStore } from "@/core/mcp/protocol";

const store: McpStore = {
  async listTasks() { return [{ app_id: "a", app_name: "试制", code: "T-0001", title: "开单", status: "todo", allowed_paths: ["src/"], forbidden_paths: [".env"] }]; },
  async getTask() { return { code: "T-0001", title: "开单", content: "上下文", allowed_paths: ["src/"], forbidden_paths: [".env"] }; },
  async getRequirement() { return null; },
  async lookupTerm() { return [{ kind: "requirement", code: "REQ-0001", excerpt: "工长开单" }]; },
  async checkScope(_user, _app, code, files) {
    return { task_code: code, outside: files.filter((file) => file === ".env") };
  },
  async submitClarification() { return { code: "Q-0008" }; },
};

describe("coding skills and mcp", () => {
  it("writes an acceptance rule and includes the domain dictionary when present", () => {
    const files = codingSkillFiles({ appName: "试制问题闭环台", constitution: "接口错误用中文。", domain: "缺陷等级 S/A/B/C" });
    expect(files.map((file) => file.path)).toEqual([".cursor/rules/sdf-acceptance.mdc", "skills/sdf-coding/SKILL.md"]);
    expect(files[0]?.content).toContain("AC-");
    expect(files[1]?.content).toContain("缺陷等级");
    expect(files[1]?.content).toContain("接口错误用中文");
  });

  it("lists tools and checks a path through the protocol", async () => {
    const listed = await handleMcp(store, "user", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(JSON.stringify(listed.body)).toContain("check_scope");
    const called = await handleMcp(store, "user", {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "check_scope", arguments: { app: "试制", code: "T-0001", files: ["src/a.js", ".env"] } },
    });
    expect(JSON.stringify(called.body)).toContain(".env");
    const missing = await handleMcp(store, "user", {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "get_requirement", arguments: { app: "试制", code: "REQ-0009" } },
    });
    expect(JSON.stringify(missing.body)).toContain("没有找到");
  });
});
