// 主机厂进场：回写文件、规格目录、证据包。只处理已经落库的文字，不调用模型。
import { strToU8, zipSync } from "fflate";

export interface ExportRequirement {
  code: string;
  title: string;
  story: string;
  status: string;
  external_ref: string | null;
  confirmed_at: string | null;
}
export interface ExportCriterion { requirement_code: string; code: string; text: string }
export interface ExportTest { requirement_code: string; ac_code: string | null; name: string; status: string }

const STATUS_LABEL: Record<string, string> = { draft: "草稿", approved: "已确认", deprecated: "已废弃" };

function cell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;
}
function line(values: string[]): string {
  return values.map(cell).join(",");
}
function close(tag: string): string {
  return "<" + "/" + tag + ">";
}
function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function requirementsCsv(requirements: ExportRequirement[], criteria: ExportCriterion[], tests: ExportTest[]): string {
  const rows = [line(["需求编号", "甲方编号", "标题", "状态", "确认时间", "验收标准编号", "验收标准", "测试名称", "测试结论"])];
  for (const req of requirements) {
    const acs = criteria.filter((item) => item.requirement_code === req.code);
    const related = tests.filter((item) => item.requirement_code === req.code);
    const base = [req.code, req.external_ref ?? "", req.title, STATUS_LABEL[req.status] ?? req.status, req.confirmed_at ?? ""];
    if (!acs.length && !related.length) rows.push(line([...base, "", "", "", ""]));
    for (const ac of acs) {
      const hit = related.find((item) => item.ac_code === ac.code);
      rows.push(line([...base, ac.code, ac.text, hit?.name ?? "", hit?.status ?? ""]));
    }
  }
  return `\uFEFF${rows.join("\n")}\n`;
}

export function requirementsReqif(requirements: ExportRequirement[], criteria: ExportCriterion[]): string {
  const spec = requirements.map((req) => {
    const acs = criteria.filter((item) => item.requirement_code === req.code).map((item) => item.code + " " + item.text).join("；");
    return [
      `<SPEC-OBJECT IDENTIFIER="${esc(req.code)}">`,
      "<VALUES>",
      `<ATTRIBUTE-VALUE-STRING THE-VALUE="${esc(req.external_ref ?? "")}"><DEFINITION><ATTRIBUTE-DEFINITION-STRING-REF>外部编号</ATTRIBUTE-DEFINITION-STRING-REF>${close("DEFINITION")}${close("ATTRIBUTE-VALUE-STRING")}`,
      `<ATTRIBUTE-VALUE-STRING THE-VALUE="${esc(req.title)}"><DEFINITION><ATTRIBUTE-DEFINITION-STRING-REF>标题</ATTRIBUTE-DEFINITION-STRING-REF>${close("DEFINITION")}${close("ATTRIBUTE-VALUE-STRING")}`,
      `<ATTRIBUTE-VALUE-STRING THE-VALUE="${esc(req.story)}"><DEFINITION><ATTRIBUTE-DEFINITION-STRING-REF>描述</ATTRIBUTE-DEFINITION-STRING-REF>${close("DEFINITION")}${close("ATTRIBUTE-VALUE-STRING")}`,
      `<ATTRIBUTE-VALUE-STRING THE-VALUE="${esc(acs)}"><DEFINITION><ATTRIBUTE-DEFINITION-STRING-REF>验收标准</ATTRIBUTE-DEFINITION-STRING-REF>${close("DEFINITION")}${close("ATTRIBUTE-VALUE-STRING")}`,
      close("VALUES"),
      close("SPEC-OBJECT"),
    ].join("");
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<REQ-IF xmlns="http://www.omg.org/spec/ReqIF/20110401/reqif.xsd"><CORE-CONTENT><REQ-IF-CONTENT><SPEC-OBJECTS>${spec}${close("SPEC-OBJECTS")}${close("REQ-IF-CONTENT")}${close("CORE-CONTENT")}${close("REQ-IF")}`;
}

export function specKitFiles(input: {
  appName: string;
  constitution: string;
  requirements: ExportRequirement[];
  tasks: { code: string; title: string; paths: string[] }[];
}): Record<string, string> {
  const spec = [`# ${input.appName}`, "", "以下内容来自已经确认或仍在草稿中的需求。编码时以编号为准。", ""];
  for (const req of input.requirements) spec.push(`## ${req.code} ${req.title}`, "", req.story, req.external_ref ? `甲方编号：${req.external_ref}` : "", "");
  const plan = ["# 实现计划", "", "先按功能完成规格确认，再按任务允许的路径修改代码。不要改允许路径以外的文件。", ""];
  const tasks = ["# 任务", ""];
  for (const task of input.tasks) tasks.push(`- [${task.code}] ${task.title}`, `  允许修改：${task.paths.join("、") || "未限定"}`);
  return {
    ".specify/memory/constitution.md": input.constitution || "尚未写入研发规范。",
    "specs/app/spec.md": spec.join("\n"),
    "specs/app/plan.md": plan.join("\n"),
    "specs/app/tasks.md": tasks.join("\n"),
  };
}

export interface EvidenceInput {
  appName: string;
  version: string;
  requirements: ExportRequirement[];
  criteria: ExportCriterion[];
  tests: ExportTest[];
  findings: { level: string; rule_id: string; path: string; message: string }[];
  gate: { item_key: string; status: string; evidence: string }[];
  usage: { title: string; model: string | null; reviewed_at: string | null; edit_ratio: number | null }[];
  gaps: string[];
}

export function evidenceFiles(input: EvidenceInput): Record<string, string> {
  const gate = ["检查项,结论,说明", ...input.gate.map((item) => line([item.item_key, item.status, item.evidence]))].join("\n");
  const trace = ["需求编号,甲方编号,验收标准编号,测试名称,测试结论"];
  for (const req of input.requirements) {
    const acs = input.criteria.filter((item) => item.requirement_code === req.code);
    if (!acs.length) trace.push(line([req.code, req.external_ref ?? "", "", "", ""]));
    for (const ac of acs) {
      const hit = input.tests.find((item) => item.ac_code === ac.code);
      trace.push(line([req.code, req.external_ref ?? "", ac.code, hit?.name ?? "", hit?.status ?? "尚未执行"]));
    }
  }
  const scans = ["级别,规则,路径,说明", ...input.findings.map((item) => line([item.level, item.rule_id, item.path, item.message]))];
  const usage = ["制品,模型,审核时间,修改比例", ...input.usage.map((item) => line([item.title, item.model ?? "", item.reviewed_at ?? "", item.edit_ratio === null ? "" : String(item.edit_ratio)]))];
  const note = [
    `# ${input.appName} 版本证据包`,
    "",
    `版本：${input.version || "尚未发布"}`,
    "",
    "本包汇总需求确认、测试结论、扫描结果和人工智能使用记录。缺少证据的项目保持原结论，不记为通过。",
    "",
    "## 暂缺",
    ...(input.gaps.length ? input.gaps.map((item) => `- ${item}`) : ["- 无"]),
    "",
  ];
  return {
    "说明.md": note.join("\n"),
    "追溯矩阵.csv": `\uFEFF${trace.join("\n")}\n`,
    "验收结论.csv": `\uFEFF${gate}\n`,
    "扫描结果.csv": `\uFEFF${scans.join("\n")}\n`,
    "人工智能使用记录.csv": `\uFEFF${usage.join("\n")}\n`,
    "需求清单.csv": requirementsCsv(input.requirements, input.criteria, input.tests),
  };
}

export function zipTextFiles(files: Record<string, string>) {
  const packed: Record<string, Uint8Array> = {};
  for (const [name, text] of Object.entries(files)) packed[name] = strToU8(text);
  return zipSync(packed);
}

export function accountExpired(expiresAt: string | null, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const time = Date.parse(expiresAt);
  return !Number.isNaN(time) && time <= now;
}

export const AUTOMOTIVE_FEATURES: { name: string; summary: string }[] = [
  { name: "问题登记", summary: "试制现场登记缺陷，选择车辆、工位和严重度。" },
  { name: "指派与整改", summary: "问题产生后四小时内指派责任人，并记录整改。" },
  { name: "复检关闭", summary: "关闭前必须复检。未复检的问题不能关闭。" },
  { name: "试制节点验收条件", summary: "未关闭且未豁免的 S 级问题超过 5 个时，节点为红色。" },
  { name: "供应商协同", summary: "供应商问题单独跟踪，整改证据随问题保存。" },
];

export const AUTOMOTIVE_DICTIONARY = [
  "# 汽车领域数据字典（第一版）",
  "",
  "车型、配置、车辆识别代号、零件号、工位、缺陷等级（S/A/B/C）、八步纠正措施、工程变更。",
  "",
  "试制车辆编号示例：PV-001 至 PV-030。",
  "统一身份认证和制造执行系统在客户环境就绪前使用本平台的模拟接口。",
  "",
  "## 研发规范摘录",
  "",
  "接口使用中文错误说明。登录、权限和审计要有对应验收测试。不要在仓库中写入密钥。",
].join("\n");

export function mockSso(): { users: { id: string; name: string; role: string }[] } {
  return {
    users: [
      { id: "u-zhou", name: "周曼", role: "试制负责人" },
      { id: "u-zhao", name: "赵磊", role: "总装工长" },
      { id: "u-xu", name: "许宁", role: "信息安全" },
    ],
  };
}

export function mockMes(): { vehicles: { code: string; model: string; station: string }[] } {
  const stations = ["焊装", "涂装", "总装"];
  return {
    vehicles: Array.from({ length: 8 }, (_, index) => ({
      code: `PV-${String(index + 1).padStart(3, "0")}`,
      model: "极光 B2",
      station: stations[index % stations.length] ?? "总装",
    })),
  };
}
