import { useEffect, useRef, useState } from "react";
import { ArrowRight, LayoutDashboard, Settings } from "lucide-react";
import { CLASS_LABEL, type AppRow } from "@/data/types";

export type AppTabKey =
  | "overview"
  | "req"
  | "runs"
  | "design"
  | "dev"
  | "quality"
  | "collab"
  | "features"
  | "docs"
  | "settings";

export interface StageStepItem {
  key: AppTabKey;
  num?: number;
  label: string;
  helpTitle: string;
  helpBody: string;
  hint: string;
  alignRight?: boolean;
}

/** 按真实交付先后顺序排列的主线阶段（1 → 8） */
export const STAGE_STEPS: StageStepItem[] = [
  {
    key: "req",
    num: 1,
    label: "需求资料",
    helpTitle: "1 需求与原始资料",
    helpBody: "先在此上传并解析原始纪要或规格书（支持 txt/md/docx/pdf），再核对抽取出的需求与验收标准、处理阻断级分析问题与澄清记录；确认无误后可勾选需求生成规格基线，或导出工程规范与 AI 使用记录。",
    hint: "先上传并解析至少一份原始资料，随后前往「2 流程运行」启动工作流；如需分配多人角色或绑定业务联系人，可先点右上角「设置」。",
  },
  {
    key: "runs",
    num: 2,
    label: "流程运行",
    helpTitle: "2 工作流运行与人工确认",
    helpBody: "选择内置工作流（如「新建小型应用」）与档位并启动运行，按步骤条跟踪执行进度，依次审核需求分析、架构说明、可交互原型与任务拆分四个确认点；交接完成后停在等待事件属于正常状态。",
    hint: "已解析资料就绪后可在此启动运行；点开某次运行可查看各步骤日志、产物、模型调用消耗与确认页签。",
  },
  {
    key: "design",
    num: 3,
    label: "架构原型",
    helpTitle: "3 数据模型、接口与可交互原型",
    helpBody: "查看并下载可执行的数据模型 schema.sql 与接口说明 openapi.yaml，并在安全沙箱内点击体验原型；发现页面或业务偏差时，可直接按锚点留言并一键生成下一版原型。",
    hint: "核对数据表、接口字段与交互原型符合业务边界后，进入「4 开发交接」查看任务上下文包与代码仓配置。",
  },
  {
    key: "dev",
    num: 4,
    label: "开发交接",
    helpTitle: "4 任务看板、代码仓与隔离验收",
    helpBody: "在任务板查看上下文包与允许修改路径，核对 Gitea 代码仓与交接分支（含 Cursor 规则与技能）；开发提 PR 后点击「立即同步」并认领任务，再触发无网隔离沙箱运行 test/ 自动化测试。",
    hint: "编码工具可通过个人令牌直连 /api/mcp 实时读任务与预检路径；合并请求认领并运行隔离验收后，结果自动回传质量检查。",
  },
  {
    key: "quality",
    num: 5,
    label: "质量验收",
    helpTitle: "5 测试用例与交付检查",
    helpBody: "核对每条验收标准的正常与例外测试用例（可一键补齐并导出 Word），并查看四项确定性交付检查：验收标准覆盖、测试通过率、高危漏洞与超范围修改。缺少报告时记为未执行，不按通过处理。",
    hint: "点击「重新计算」可按最新活跃合并请求与扫描报告刷新交付检查；例外放行只留存原因，不篡改原始检查状态。",
  },
  {
    key: "collab",
    num: 6,
    label: "业务协作",
    helpTitle: "6 反馈池、变更流转与沟通",
    helpBody: "查看业务门户提交的反馈并勾选合并为变更请求，生成涵盖未关闭澄清与待确认变更的会议议程，通过 @ 邮箱提醒协作者，并在发布后按版本号对比变更差异。",
    hint: "将门户反馈合并为变更后，可通过功能增强与迭代发布联动业务门户完成业务确认、用户验收与版本上线。",
    alignRight: true,
  },
  {
    key: "features",
    num: 7,
    label: "功能证据",
    helpTitle: "7 功能版本、影响分析与证据导出",
    helpBody: "按功能与迭代版本组织进度（可选套用汽车领域包），核查敏感数据模型路由状态，按需求编号执行追溯级变更影响分析，并一键导出需求 CSV、ReqIF、Spec Kit 与版本证据包。",
    hint: "发生需求修改或准备版本归档时，可在此核对受影响的验收标准、任务与下游制品，并打包导出版本证据包。",
    alignRight: true,
  },
  {
    key: "docs",
    num: 8,
    label: "交付文档",
    helpTitle: "8 规格与设计文档导出",
    helpBody: "集中查看由工作流生成的中文需求规格说明书与设计文档，结合「管理 → 报告模板」中的封面、页眉页脚与页码样式，一键下载正式交付版 Word 文档。",
    hint: "交接与交付检查完成后会自动产出最新规格与设计文档；如需调整文档版式，可在报告模板中修改后重新下载。",
    alignRight: true,
  },
];

/** 常驻全局视图（非顺序步骤，随时切换） */
export const UTILITY_VIEWS: StageStepItem[] = [
  {
    key: "overview",
    label: "概览",
    helpTitle: "应用概览",
    helpBody: "汇总查看当前应用的生命周期阶段、当前发布版本、你的应用内角色、发送前脱敏开关、版本发布时间线、交付流度量指标以及全部最新制品。",
    hint: "",
    alignRight: true,
  },
  {
    key: "settings",
    label: "设置",
    helpTitle: "应用设置与治理",
    helpBody: "配置应用基本信息、数据密级与发送前脱敏（含 VIN、内网 IP 与自定义脱敏词表）、成员角色与有效期、业务联系人、代码仓连接器，以及按项目导出审计记录与脱敏数据包。",
    hint: "在此调整密级与脱敏词表、配置成员权限与有效期、绑定业务联系人或代码仓连接器，并可按时间段导出审计记录。",
    alignRight: true,
  },
];

interface AppStageNavProps {
  active: AppTabKey;
  onChange: (next: AppTabKey) => void;
  app: Pick<AppRow, "classification" | "redact_before_llm" | "current_version">;
}

export function AppStageNav({ active, onChange, app }: AppStageNavProps) {
  const [hoveredHelp, setHoveredHelp] = useState<AppTabKey | null>(null);
  const [pinnedHelp, setPinnedHelp] = useState<AppTabKey | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const openHelp = pinnedHelp ?? hoveredHelp;

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setPinnedHelp(null);
        setHoveredHelp(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPinnedHelp(null);
        setHoveredHelp(null);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  const cancelHoverClose = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const scheduleHoverClose = () => {
    cancelHoverClose();
    closeTimerRef.current = window.setTimeout(() => {
      setHoveredHelp(null);
    }, 140);
  };

  const activeStageIndex = STAGE_STEPS.findIndex((item) => item.key === active);
  const currentItem =
    STAGE_STEPS[activeStageIndex] ?? UTILITY_VIEWS.find((item) => item.key === active) ?? UTILITY_VIEWS[0]!;
  const nextStep =
    active === "overview"
      ? STAGE_STEPS[0]
      : activeStageIndex >= 0 && activeStageIndex < STAGE_STEPS.length - 1
        ? STAGE_STEPS[activeStageIndex + 1]
        : null;

  const overviewHint = `当前密级：${CLASS_LABEL[app.classification]} · 发送前脱敏${app.redact_before_llm ? "已开启" : "未开启"} · 版本：${app.current_version ?? "尚未发布"}。初次推进建议从「1 需求资料」上传原始记录开始。`;

  const renderHelpBadge = (item: StageStepItem) => {
    const isOpen = openHelp === item.key;
    return (
      <div
        className="relative"
        onMouseEnter={() => {
          cancelHoverClose();
          setHoveredHelp(item.key);
        }}
        onMouseLeave={scheduleHoverClose}
      >
        <button
          type="button"
          aria-label={`查看「${item.helpTitle}」说明`}
          aria-expanded={isOpen}
          onClick={(event) => {
            event.stopPropagation();
            setPinnedHelp((prev) => (prev === item.key ? null : item.key));
          }}
          className={[
            "flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border text-[11px] font-semibold leading-none shadow-xs transition-colors",
            isOpen
              ? "border-primary bg-background text-primary ring-2 ring-primary/15"
              : "border-border bg-background text-muted-foreground hover:border-primary hover:text-primary",
          ].join(" ")}
        >
          ?
        </button>
        {isOpen && (
          <div
            role="tooltip"
            className={[
              "absolute top-full z-50 mt-2 w-72 rounded-lg border border-border bg-popover p-4 text-left text-popover-foreground shadow-lg sm:w-80",
              item.alignRight ? "right-0" : "left-0",
            ].join(" ")}
          >
            <div className="text-sm font-semibold text-foreground">{item.helpTitle}</div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{item.helpBody}</p>
          </div>
        )}
      </div>
    );
  };

  return (
    <section
      ref={containerRef}
      aria-label="应用功能导航"
      className="panel-surface mb-6 rounded-lg border border-border bg-card p-4 shadow-xs"
    >
      {/* 顶部栏：左侧顺序推进标题，右侧常驻全局视图（概览 / 设置） */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">按顺序推进</h2>
          <span className="rounded bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {activeStageIndex >= 0 ? `第 ${activeStageIndex + 1} / ${STAGE_STEPS.length} 步` : `当前视图：${currentItem.label}`}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3" role="tablist" aria-label="全局视图">
          {UTILITY_VIEWS.map((item) => {
            const isSelected = active === item.key;
            const Icon = item.key === "overview" ? LayoutDashboard : Settings;
            return (
              <div key={item.key} className="relative inline-flex">
                <button
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  onClick={() => {
                    onChange(item.key);
                    setPinnedHelp(null);
                  }}
                  className={[
                    "inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                    isSelected
                      ? "border-primary bg-primary text-primary-foreground shadow-xs"
                      : "border-border bg-background text-foreground hover:border-primary/40 hover:bg-muted/50",
                  ].join(" ")}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{item.label}</span>
                </button>
                <div className="absolute -top-2 -right-2">{renderHelpBadge(item)}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 主线 1–8 步骤按钮区（参考附图带编号 + 右上角问号引导卡） */}
      <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-3" role="tablist" aria-label="研发交付主线步骤">
        {STAGE_STEPS.map((step) => {
          const isSelected = active === step.key;
          return (
            <div key={step.key} className="relative inline-flex">
              <button
                type="button"
                role="tab"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(step.key);
                  setPinnedHelp(null);
                }}
                className={[
                  "inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3.5 py-2 text-sm font-medium transition-colors",
                  isSelected
                    ? "border-primary bg-primary text-primary-foreground shadow-xs"
                    : "border-border bg-background text-foreground hover:border-primary/40 hover:bg-muted/50",
                ].join(" ")}
              >
                <span className="font-mono text-xs font-bold tabular-nums opacity-90">{step.num}</span>
                <span>{step.label}</span>
              </button>
              <div className="absolute -top-2 -right-2">{renderHelpBadge(step)}</div>
            </div>
          );
        })}
      </div>

      {/* 底部当前步骤导引 + 下一步快捷切换 */}
      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2.5 text-xs text-muted-foreground">
        <p className="leading-relaxed">{active === "overview" ? overviewHint : currentItem.hint}</p>
        {nextStep && (
          <button
            type="button"
            onClick={() => {
              onChange(nextStep.key);
              setPinnedHelp(null);
            }}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1 font-medium text-primary hover:underline"
          >
            <span>
              {active === "overview"
                ? `开始第 ${nextStep.num} 步：${nextStep.label}`
                : `下一步：${nextStep.num} ${nextStep.label}`}
            </span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </section>
  );
}
