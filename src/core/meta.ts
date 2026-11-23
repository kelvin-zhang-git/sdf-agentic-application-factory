// Feature status registry reported by GET /api/meta (admin only).
export type FeatureStatus = "implemented" | "schema_only" | "not_started";
export interface FeatureInfo { key: string; name: string; batch: string; status: FeatureStatus }

export const FEATURES: FeatureInfo[] = [
  { key: "auth", name: "登录注册与全局角色", batch: "1A", status: "implemented" },
  { key: "bootstrap", name: "首位管理员初始化", batch: "1A", status: "implemented" },
  { key: "apps", name: "应用与成员管理", batch: "1A", status: "implemented" },
  { key: "contacts", name: "业务联系人", batch: "1A", status: "implemented" },
  { key: "audit", name: "审计日志写入", batch: "1A", status: "implemented" },
  { key: "portal_switch", name: "业务方视角切换", batch: "1A", status: "implemented" },
  { key: "models", name: "模型配置与密钥加密", batch: "1B", status: "implemented" },
  { key: "llm", name: "模型调用层", batch: "1B", status: "implemented" },
  { key: "diagnostics", name: "系统日志、诊断包、自检", batch: "1C", status: "implemented" },
  { key: "diagnostic_logs", name: "管理员日志检索与诊断导出", batch: "1C", status: "implemented" },
  { key: "cron", name: "数据库定时日志清理", batch: "1C", status: "implemented" },
  { key: "seed", name: "批次 1 种子数据", batch: "1C", status: "implemented" },
  { key: "artifact_viewer", name: "示例制品与版本差异", batch: "1C", status: "implemented" },
  { key: "public_hooks", name: "外部签名回调与连接器", batch: "4", status: "implemented" },
  { key: "workflow_schema", name: "工作流、运行、需求数据结构与权限", batch: "2A", status: "implemented" },
  { key: "engine", name: "工作流引擎（原子领取、租约、分片、退回、重跑、超时重试）", batch: "2B", status: "implemented" },
  { key: "blocks_req", name: "积木 B01–B04、B08 与 requirement_only v1.1.0", batch: "2C", status: "implemented" },
  { key: "blocks_design", name: "设计、测试、任务、流水线和文档积木，以及 new_app_small", batch: "3", status: "implemented" },
  { key: "workflows", name: "运行详情、运行列表、工作流页、我的待办、需求标签页", batch: "2D", status: "implemented" },
  { key: "realtime_push", name: "实时推送（SSE，断开后 5 秒轮询）", batch: "2", status: "implemented" },
  { key: "waiting_event", name: "外部事件等待 resolve_wait", batch: "4", status: "implemented" },
  { key: "blocks_handoff", name: "交接、代码库概况、报告导入和交付检查", batch: "4", status: "implemented" },
  { key: "blocks_evolution", name: "反馈、变更确认、验收和发布", batch: "5", status: "implemented" },
  { key: "business_portal", name: "业务门户", batch: "5", status: "implemented" },
  { key: "custom_workflows", name: "自定义工作流", batch: "6", status: "implemented" },
  { key: "command_search", name: "全局搜索", batch: "6", status: "implemented" },
  { key: "agent_center", name: "智能体提示词与采纳统计", batch: "6", status: "implemented" },
  { key: "export_bundle", name: "应用脱敏导出", batch: "6", status: "implemented" },
  { key: "stage5_blocks", name: "方案草图、优先级、测试脚本和部署包", batch: "7", status: "implemented" },
  { key: "stage6_blocks", name: "模板脚手架、资产目录和任务板", batch: "8", status: "implemented" },
  { key: "block_toggle", name: "积木启停", batch: "9", status: "implemented" },
  { key: "stage8_access", name: "个人访问令牌、命令行和 MCP", batch: "10", status: "implemented" },
];
export const API_VERSION = "0.12.0-10";
