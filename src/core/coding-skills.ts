// 交接时随规格一起提交的编码技能。编码工具读这些文件，不代替平台上的验收计算。

export interface SkillFile { path: string; content: string }

function clip(text: string, max: number): string {
  const value = text.trim();
  return value.length <= max ? value : `${value.slice(0, max)}\n\n（其余见仓库里的 CONSTITUTION.md）`;
}

/** 生成 Cursor 规则和一份可复用的技能说明。领域字典有内容时才附上。 */
export function codingSkillFiles(input: { appName: string; constitution: string; domain: string | null }): SkillFile[] {
  const files: SkillFile[] = [
    {
      path: ".cursor/rules/sdf-acceptance.mdc",
      content: `---
description: SDF 验收测试的写法。测试名里要有验收标准编号。
globs: test/**/*.js
alwaysApply: true
---

# 验收测试

测试文件放在仓库的 \`test/\` 目录下（例如 \`test/*.test.js\` 或任务允许的子目录 \`test/<模块>/*.test.js\`），用 \`node --test\` 运行。

测试名称里写上 \`AC-\` 加四位数字，例如 \`AC-0008 正常开单\`。带字母的编号不会被计入覆盖。

只修改当前任务允许的路径。\`.env\` 和密钥文件不要写入仓库。

提交说明的最后一行写 \`SDF-Task: T-xxxx\`，或让标题以 \`[T-xxxx]\` 开头。
`,
    },
    {
      path: "skills/sdf-coding/SKILL.md",
      content: `---
name: sdf-coding
description: 按 SDF 交接包编写 ${input.appName} 的代码和验收测试。先读任务上下文，再按允许路径修改。
---

# ${input.appName} 编码约定

先读仓库根目录的 \`CONSTITUTION.md\`、\`specs/app/requirements.md\` 和 \`context/T-xxxx.md\`。任务末尾的 \`SDF-Task:\` 行不要删。

验收测试放在 \`test/\` 下（\`test/*.test.js\` 或任务允许的 \`test/<模块>/*.test.js\`），名称包含 \`AC-0008\` 这种编号。没有报告的验收标准记为未执行，不要把没跑过的测试写成通过。

## 研发规范摘录

${clip(input.constitution, 1800)}
${input.domain?.trim() ? `\n## 领域词典摘录\n\n${clip(input.domain, 1200)}\n` : ""}`,
    },
  ];
  return files;
}
