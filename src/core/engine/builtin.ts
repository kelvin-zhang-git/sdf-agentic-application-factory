// 内置工作流。新版本用新的 version 插入，不改已经写进库里的旧行。
export type Weight = "light" | "standard" | "full";
export interface Checkpoint { role: string; prompt: string }
export interface StepDef {
  key: string; name: string; stage: string; block: string; weights: Weight[];
  options?: Partial<Record<Weight, Record<string, unknown>>>;
  checkpoints: Partial<Record<Weight, Checkpoint>>;
  /** 本阶段只占位，启动时记为跳过，不要求积木已经实施。 */
  skip?: boolean;
  produces?: string[];
  consumes?: string[];
  goto?: string;
  when?: string;
}
export interface WorkflowDef { key: string; name: string; steps: StepDef[] }

const W: Weight[] = ["light", "standard", "full"];
const analyzeCp: Checkpoint = { role: "ba", prompt: "确认分析结果；存在未处理阻断问题时不能通过" };
const architectCp: Checkpoint = { role: "architect", prompt: "确认架构说明和架构图" };
const businessCp: Checkpoint = { role: "business", prompt: "确认原型是否覆盖主要业务操作" };
const leadCp: Checkpoint = { role: "lead", prompt: "确认任务拆分、上下文包和允许修改的路径" };
const confirmCp: Checkpoint = { role: "business", prompt: "请确认这次改动。不同意就写下要改的地方" };
const releaseCp: Checkpoint = { role: "lead", prompt: "确认可以按这个版本发布" };

const step = (key: string, name: string, stage: string, block: string, checkpoints: StepDef["checkpoints"] = {}, extra: Partial<StepDef> = {}): StepDef =>
  ({ key, name, stage, block, weights: W, checkpoints, ...extra });

export const REQUIREMENT_ONLY: WorkflowDef = {
  key: "requirement_only", name: "仅需求",
  steps: [
    { key: "import", name: "资料导入", stage: "需求", block: "B01", weights: W, options: { light: { annotate: false } }, checkpoints: {} },
    { key: "organize", name: "需求整理", stage: "需求", block: "B02", weights: W, checkpoints: { full: { role: "ba", prompt: "复核整理出的需求和验收标准" } } },
    { key: "analyze", name: "需求分析", stage: "需求", block: "B03", weights: W, options: { light: { blockers_only: true } }, checkpoints: { light: analyzeCp, standard: analyzeCp, full: analyzeCp } },
    { key: "clarify", name: "澄清问题", stage: "需求", block: "B04", weights: W, checkpoints: { full: { role: "lead", prompt: "复核澄清问题清单" } } },
    step("docs", "需求规格说明书", "文档", "B26"),
  ],
};

export const NEW_APP_SMALL: WorkflowDef = {
  key: "new_app_small", name: "新建小型应用",
  steps: [
    step("import", "资料导入", "需求", "B01"),
    step("organize", "需求整理", "需求", "B02"),
    step("analyze", "需求分析", "需求", "B03", { light: analyzeCp, standard: analyzeCp, full: analyzeCp }),
    step("clarify", "澄清问题", "需求", "B04"),
    step("constitution", "工程规范", "设计", "B08"),
    step("data_model", "数据模型", "设计", "B10"),
    step("openapi", "接口说明", "设计", "B11"),
    step("architecture", "架构说明", "设计", "B12", { light: architectCp, standard: architectCp, full: architectCp }),
    step("prototype", "可交互原型", "设计", "B09", { light: businessCp, standard: businessCp, full: businessCp }),
    step("test_design", "测试设计", "质量", "B18"),
    step("tasks", "任务与上下文包", "开发", "B14", { light: leadCp, standard: leadCp, full: leadCp }),
    step("pipeline", "流水线模板", "开发", "B22"),
    step("handoff", "交接包", "开发", "B15"),
    step("report", "测试报告", "质量", "B20"),
    step("gate", "交付检查", "质量", "B21"),
    step("docs", "规格与设计文档", "文档", "B26"),
  ],
};

const future = (key: string, name: string, steps: StepDef[]): WorkflowDef => ({ key, name, steps });

export const BUILTIN_WORKFLOWS: { def: WorkflowDef; version: string; description: string; startable: boolean }[] = [
  { def: REQUIREMENT_ONLY, version: "1.1.0", description: "资料、需求、澄清，并生成需求规格说明书", startable: true },
  { def: NEW_APP_SMALL, version: "1.1.0", description: "小型新应用：需求、设计、原型、测试、任务、交接、报告、交付检查和文档", startable: true },
  { def: future("feature_enhance", "功能增强", [
    step("plan", "变更方案", "需求", "B05", { light: analyzeCp, standard: analyzeCp, full: analyzeCp }),
    step("confirm", "业务确认", "需求", "B32", { light: confirmCp, standard: confirmCp, full: confirmCp }),
    step("tasks", "任务拆分", "开发", "B14", { light: leadCp, standard: leadCp, full: leadCp }),
    step("handoff", "交接包", "开发", "B15"),
    step("docs", "文档", "文档", "B26"),
  ]), version: "1.1.0", description: "针对已确认的变更：方案、业务确认、任务、交接和文档", startable: true },
  { def: future("hotfix_light", "轻量修复", [
    step("import", "资料导入", "需求", "B01"), step("tasks", "任务拆分", "开发", "B14"), step("handoff", "交接包", "开发", "B15"),
  ]), version: "1.0.0", description: "含后续阶段积木，当前不能启动", startable: false },
  { def: future("hotfix_light", "轻量修复", [
    step("plan", "变更方案", "需求", "B05", { light: analyzeCp, standard: analyzeCp, full: analyzeCp }),
    step("tasks", "任务拆分", "开发", "B14", { light: leadCp, standard: leadCp, full: leadCp }),
    step("handoff", "交接包", "开发", "B15"),
    step("report", "测试报告", "质量", "B20"),
    step("gate", "交付检查", "质量", "B21"),
  ]), version: "1.1.0", description: "缺陷热修：变更方案、任务、交接、报告和交付检查", startable: true },
  { def: future("scaffold_pack", "脚手架", [
    step("scaffold", "模板脚手架", "开发", "B13"),
    step("tasks", "任务拆分", "开发", "B14", { light: leadCp, standard: leadCp, full: leadCp }),
    step("board", "任务板", "开发", "B29"),
    step("assets", "资产包", "文档", "B28"),
  ]), version: "1.0.0", description: "按已有需求生成工程骨架、任务、任务板和资产包", startable: true },
  { def: future("delivery_pack", "交付包", [
    step("priority", "优先级", "需求", "B07"),
    step("sketch", "方案草图", "设计", "B06"),
    step("scripts", "测试脚本", "质量", "B19"),
    step("deploy", "部署包", "交付", "B23"),
  ]), version: "1.0.0", description: "按已有需求排出优先级，并生成方案草图、测试脚本和部署包", startable: true },
  { def: future("doc_backfill", "文档补全", [
    step("repo", "代码库概况", "设计", "B16"),
    step("data_model", "数据模型", "设计", "B10"),
    step("openapi", "接口说明", "设计", "B11"),
    step("architecture", "架构说明", "设计", "B12"),
    step("docs", "规格与设计文档", "文档", "B26"),
  ]), version: "1.0.0", description: "从已有代码库补数据模型、接口、架构和设计文档", startable: true },
  { def: future("code_review_flow", "代码评审", [
    step("review", "代码评审", "开发", "B17"),
    step("report", "测试报告", "质量", "B20"),
    step("gate", "交付检查", "质量", "B21"),
    step("metrics", "交付流度量", "交付", "B30"),
  ]), version: "1.0.0", description: "评审打开的合并请求，汇总报告并计算交付流指标", startable: true },
  { def: future("iteration_release", "迭代发布", [
    step("uat", "业务验收", "质量", "B33", { light: confirmCp, standard: confirmCp, full: confirmCp }),
    step("report", "测试报告", "质量", "B20"),
    step("gate", "交付检查", "质量", "B21"),
    step("release", "发布说明", "文档", "B24", { light: releaseCp, standard: releaseCp, full: releaseCp }),
    step("docs", "文档", "文档", "B26"),
  ]), version: "1.1.0", description: "业务验收、交付检查、发布说明和基线", startable: true },
];
