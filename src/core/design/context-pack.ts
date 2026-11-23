import { caseKindLabel } from "./test-design";

export interface ContextTask {
  code: string;
  title: string;
  description: string;
  criteria: { code: string; text: string }[];
  ddl: string;
  openapi: string;
  allowed_paths: string[];
  forbidden_paths: string[];
  cases?: { ac_code: string; kind: string; title: string; steps: string[]; expected: string }[];
}

export function renderContextPack(task: ContextTask): string {
  const lines = [
    `# ${task.code} ${task.title}`,
    "",
    task.description,
    "",
    "## 验收标准",
    ...task.criteria.map((c) => `- ${c.code}：${c.text}`),
    "",
    ...(task.cases?.length ? [
      "## 测试用例",
      ...task.cases.map((item) => `- ${item.ac_code} ${caseKindLabel(item.kind)}：${item.title}\n  期望：${item.expected}\n  步骤：${item.steps.join("；") || "按标题执行"}`),
      "",
    ] : []),
    "## 相关表",
    task.ddl || "（本任务不改表）",
    "",
    "## 相关接口",
    task.openapi || "（本任务不改接口）",
    "",
    "## 允许修改",
    ...task.allowed_paths.map((p) => `- ${p}`),
    "",
    "## 禁止修改",
    ...task.forbidden_paths.map((p) => `- ${p}`),
    "",
    `SDF-Task: ${task.code}`,
    "",
  ];
  return lines.join("\n");
}

const MERMAID = /^(flowchart|graph|sequenceDiagram|erDiagram|classDiagram|stateDiagram(?:-v2)?|C4Context|C4Container|pie|gantt)\b/;

export function checkMermaid(source: string): string | null {
  const first = source.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("%%"));
  if (!first || !MERMAID.test(first)) return "图的第一行不是支持的 Mermaid 类型";
  return null;
}
