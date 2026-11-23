// 试制首版里能够自动核对的规则。生成的工程和测试都从这里来。

export function assignLate(hoursOpen: number, assigned: boolean): boolean {
  return assigned || hoursOpen <= 4;
}

export function canClose(retested: boolean): boolean {
  return retested;
}

export function nodeColor(openUnwaivedS: number): "red" | "green" {
  return openUnwaivedS > 5 ? "red" : "green";
}

export function allowExport(role: string): boolean {
  return role === "lead" || role === "qa";
}

export function serverModuleSource(header: string): string {
  return `${header}
export function assignLate(hoursOpen, assigned) { return assigned || hoursOpen <= 4; }
export function canClose(retested) { return retested; }
export function nodeColor(openUnwaivedS) { return openUnwaivedS > 5 ? "red" : "green"; }
export function allowExport(role) { return role === "lead" || role === "qa"; }
export function start() { return { ok: true }; }
`;
}

export type RuleKind = "assign" | "close" | "node" | "export";

export function ruleKind(text: string): RuleKind | null {
  if (text.includes("指派")) return "assign";
  if (text.includes("复检") || text.includes("关闭")) return "close";
  if (text.includes("S 级") || text.includes("红色") || text.includes("节点")) return "node";
  if (text.includes("导出") || text.includes("权限")) return "export";
  return null;
}

export function ruleTestSource(cases: { code: string; title: string; kind: RuleKind }[]): string {
  const body = cases.map((item) => {
    const name = JSON.stringify(`${item.code} ${item.title}`.slice(0, 80));
    if (item.kind === "assign") return `test(${name}, () => { assert.equal(assignLate(5, false), false); assert.equal(assignLate(4, false), true); assert.equal(assignLate(8, true), true); });`;
    if (item.kind === "close") return `test(${name}, () => { assert.equal(canClose(false), false); assert.equal(canClose(true), true); });`;
    if (item.kind === "node") return `test(${name}, () => { assert.equal(nodeColor(6), "red"); assert.equal(nodeColor(5), "green"); });`;
    return `test(${name}, () => { assert.equal(allowExport("business"), false); assert.equal(allowExport("lead"), true); });`;
  }).join("\n");
  return `import test from "node:test";
import assert from "node:assert/strict";
import { assignLate, canClose, nodeColor, allowExport } from "../src/server.js";
${body}
`;
}
