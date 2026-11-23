// 测试设计的可见交付物：每条验收标准至少一条正常路径和一条例外路径。

export type CaseKind = "normal" | "exception" | "boundary";

export interface DesignedCase {
  requirement_code: string;
  ac_code: string;
  kind: CaseKind;
  title: string;
  preconditions: string;
  steps: string[];
  expected: string;
}

export interface CaseRequirement {
  code: string;
  title: string;
  criteria: { code?: string; text: string }[];
}

const KIND_LABEL: Record<string, string> = { normal: "正常", exception: "例外", boundary: "边界" };

export function caseKindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

function clip(value: string, max: number): string {
  return value.trim().slice(0, max);
}

/** 模型没覆盖到的验收标准，用可执行的正常路径和例外路径补上。 */
export function fillCaseGaps(reqs: CaseRequirement[], cases: DesignedCase[]): DesignedCase[] {
  const out = [...cases];
  for (const req of reqs) {
    for (const ac of req.criteria) {
      if (!ac.code) continue;
      const mine = out.filter((item) => item.ac_code === ac.code && item.requirement_code === req.code);
      if (!mine.some((item) => item.kind === "normal")) {
        out.push({
          requirement_code: req.code,
          ac_code: ac.code,
          kind: "normal",
          title: clip(`${ac.code} 正常路径：${req.title}`, 200),
          preconditions: "已用该功能对应的岗位登录，主数据按当前澄清结论准备。",
          steps: [
            clip(`打开「${req.title}」对应的功能`, 300),
            "按验收标准准备合法输入并提交",
            clip(ac.text, 300),
          ],
          expected: clip(ac.text, 500),
        });
      }
      if (!mine.some((item) => item.kind === "exception" || item.kind === "boundary")) {
        out.push({
          requirement_code: req.code,
          ac_code: ac.code,
          kind: "exception",
          title: clip(`${ac.code} 例外路径：${req.title}`, 200),
          preconditions: "已登录，但故意缺少必填项或使用越界数据。",
          steps: [
            clip(`打开「${req.title}」对应的功能`, 300),
            clip(`不满足「${ac.text}」后提交`, 300),
          ],
          expected: "系统拒绝这次操作，并给出能看懂的原因。数据不能记成已经成功。",
        });
      }
    }
  }
  return out;
}

export function renderTestDesign(appName: string, cases: DesignedCase[]): string {
  const lines = [
    `# ${appName} 测试用例`,
    "",
    "每条验收标准至少包含一条正常路径，以及一条例外或边界路径。开发时按用例步骤实现，测试名称里写上验收标准编号。",
    "",
  ];
  const groups = new Map<string, DesignedCase[]>();
  for (const item of cases) {
    const list = groups.get(item.requirement_code) ?? [];
    list.push(item);
    groups.set(item.requirement_code, list);
  }
  for (const [code, list] of groups) {
    lines.push(`## ${code}`, "");
    for (const item of list) {
      lines.push(`### ${item.ac_code} ${caseKindLabel(item.kind)}`, "");
      lines.push(`标题：${item.title}`);
      if (item.preconditions) lines.push(`前置：${item.preconditions}`);
      lines.push("步骤：");
      item.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
      lines.push(`期望：${item.expected}`, "");
    }
  }
  if (!cases.length) lines.push("还没有可编写的验收标准。", "");
  return lines.join("\n");
}
