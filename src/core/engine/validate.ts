// Workflow definition checks and plan preview (same rules for list page and start).
import { parse } from "yaml";
import type { WorkflowDef, Weight } from "./builtin";
import { IMPLEMENTED_BLOCKS } from "../blocks";

export const ROLES = ["lead", "ba", "architect", "security", "dev", "qa", "business"];
export interface PlanStep { key: string; name: string; block: string; skipped: boolean; checkpoint: string | null }
export function planPreview(def: WorkflowDef, weight: Weight, disabled: readonly string[] = []): PlanStep[] {
  if (!Array.isArray(def?.steps)) return [];
  const off = new Set(disabled);
  return def.steps.map((s) => ({ key: s.key, name: s.name, block: s.block, skipped: s.skip === true || !(s.weights ?? []).includes(weight) || off.has(s.block), checkpoint: s.checkpoints?.[weight]?.role ?? null }));
}
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
/** 积木默认产出。自定义工作流没写 produces 时用这张表接上一步。 */
const PRODUCES: Record<string, string> = {
  B01: "source_segments", B02: "requirements", B03: "analysis", B04: "clarifications", B05: "change_plan",
  B06: "solution_sketch", B07: "priority_list",
  B08: "constitution", B09: "prototype", B10: "data_model", B11: "openapi", B12: "architecture",
  B14: "tasks", B15: "handoff", B16: "repo_summary", B18: "test_cases", B19: "test_script", B20: "test_report",
  B13: "scaffold",
  B17: "review_note",
  B21: "delivery_gate", B22: "pipeline", B23: "deploy_pack", B24: "release_notes", B26: "documents", B28: "asset_pack", B29: "task_board", B30: "flow_metrics", B31: "feedback_triage",
  B32: "business_confirm", B33: "uat",
};
const CONSUMES: Record<string, string[]> = {
  B02: ["source_segments"], B03: ["requirements"], B04: ["requirements"], B05: ["requirements"],
  B06: ["requirements"], B07: ["requirements"],
  B09: ["requirements"], B10: ["requirements"], B11: ["data_model"], B12: ["requirements"],
  B13: ["requirements"], B14: ["requirements"], B15: ["tasks"], B18: ["requirements"], B19: ["requirements"], B20: ["test_cases"], B21: ["test_report"],
  B28: ["requirements"], B29: ["tasks"],
  B23: ["requirements"],
  B24: ["delivery_gate"], B26: ["requirements"], B32: ["change_plan"], B33: ["requirements"],
};

function whenIssue(expr: string): string | null {
  const piece = String.raw`(?:true|false|weight\s*==\s*'(?:light|standard|full)')`;
  return new RegExp(`^${piece}(?:\\s+(?:and|or)\\s+${piece})*$`).test(expr.trim()) ? null : "when 只能写 true、false，或 weight == 'light'|'standard'|'full'，并用 and / or 连接";
}

export function validateWorkflow(yamlText: string, def: WorkflowDef, appRoles?: string[], chain = false): string[] {
  const issues: string[] = [];
  try { if (stable(parse(yamlText)) !== stable(def)) issues.push("YAML 与已保存的定义不一致"); } catch { issues.push("YAML 无法解析"); }
  if (!Array.isArray(def?.steps)) return [...issues, "缺少 steps"];
  const keys = new Set<string>();
  for (const s of def.steps) {
    if (!s?.key) { issues.push("有步骤缺少 key"); continue; }
    if (keys.has(s.key)) issues.push(`步骤 ${s.key} 重复`);
    keys.add(s.key);
    if (!s.skip && !IMPLEMENTED_BLOCKS.includes(s.block)) issues.push(`包含未实施积木 ${s.block}`);
    if (s.when) {
      const bad = whenIssue(s.when);
      if (bad) issues.push(`步骤 ${s.key} 的 ${bad}`);
    }
    for (const [w, cp] of Object.entries(s.checkpoints ?? {})) {
      if (!cp) continue;
      if (!ROLES.includes(cp.role)) issues.push(`步骤 ${s.key}（${w}）的确认角色 ${cp.role} 无效`);
      else if (appRoles && !appRoles.includes(cp.role) && cp.role !== "lead") issues.push(`本应用没有「${cp.role}」角色成员，${s.key} 的确认点将只能由负责人处理`);
    }
    if (chain && !s.skip) {
      const needs = s.consumes ?? CONSUMES[s.block] ?? [];
      const index = def.steps.indexOf(s);
      for (const item of needs) {
        const later = def.steps.findIndex((step, at) => at > index && (step.produces ?? (PRODUCES[step.block] ? [PRODUCES[step.block]] : [])).includes(item));
        const earlier = def.steps.slice(0, index).some((step) => (step.produces ?? (PRODUCES[step.block] ? [PRODUCES[step.block]] : [])).includes(item));
        if (later >= 0 && !earlier) issues.push(`步骤 ${s.key} 需要先有制品 ${item}`);
      }
    }
  }
  if (chain) {
    for (const s of def.steps) {
      if (s?.goto && !keys.has(s.goto)) issues.push(`步骤 ${s.key} 的 goto「${s.goto}」没有对应步骤`);
    }
  }
  return issues;
}
