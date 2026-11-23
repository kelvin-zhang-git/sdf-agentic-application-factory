// B08 工程规范：表单校验并生成 CONSTITUTION.md 内容（单独操作，不在 requirement_only 中）。
import { z } from "zod";
export const constitutionSchema = z.object({
  stack: z.string().trim().min(1, "请填写技术栈").max(2000),
  naming: z.string().trim().min(1, "请填写命名规范").max(2000),
  security: z.string().trim().min(1, "请填写安全禁止项").max(2000),
  performance: z.string().trim().min(1, "请填写性能要求").max(2000),
  other: z.string().trim().max(4000).default(""),
});
export type Constitution = z.infer<typeof constitutionSchema>;
export function constitutionMarkdown(appName: string, c: Constitution): string {
  return `# ${appName} 工程规范（CONSTITUTION）\n\n## 技术栈\n${c.stack}\n\n## 命名规范\n${c.naming}\n\n## 安全禁止项\n${c.security}\n\n## 性能与其他非功能要求\n${c.performance}\n${c.other ? `\n## 其他\n${c.other}\n` : ""}`;
}
