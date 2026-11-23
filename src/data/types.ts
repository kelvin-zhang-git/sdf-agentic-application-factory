export type GlobalRole = "admin" | "lead" | "ba" | "architect" | "security" | "dev" | "qa" | "business";
export type AppRole = Exclude<GlobalRole, "admin">;
export interface Me {
  user_id: string; profile: { id: string; email: string | null; display_name: string } | null;
  global_roles: GlobalRole[]; app_roles: AppRole[]; business_only: boolean; bootstrapped: boolean;
}
export interface AppRow {
  source?: "user" | "seed";
  id: string; name: string; description: string; phase: "development" | "maintenance";
  classification: "public" | "internal" | "sensitive" | "confidential"; redact_before_llm: boolean;
  redact_terms?: string[];
  current_version: string | null; created_at: string; updated_at: string; my_roles?: AppRole[];
  app_members?: { count: number }[];
}
export interface Member { id: string; role: AppRole; user_id: string; expires_at: string | null; profiles: { id: string; email: string | null; display_name: string } | null }
export interface AppContact {
  id: string; app_role: AppRole; is_business: boolean;
  contacts: { id: string; name: string; title: string; org: string; email: string | null; is_demo: boolean; linked_profile_id: string | null } | null;
}
export interface AuditRow { id: number; trace_id: string | null; actor_id: string | null; app_id: string | null; action: string; target_type: string | null; target_id: string | null; detail: Record<string, unknown>; created_at: string }
export interface UserMembership { app_id: string; app_name: string; roles: AppRole[]; expires_at: string | null }
export interface AdminUser { id: string; email: string | null; display_name: string; created_at: string; expires_at: string | null; roles: GlobalRole[]; memberships?: UserMembership[] }
export interface DirectoryUser { id: string; email: string | null; display_name: string }
export type TaskTier = "fast" | "standard" | "deep";
export interface LlmProvider {
  id: string; name: string; base_url: string; models: string[]; secret_id: string;
  allowed_for_sensitive: boolean; enabled: boolean; priority: number;
  last_status: "untested" | "success" | "error"; last_checked_at: string | null; last_error: string | null;
  key_last4: string | null; created_at: string; updated_at: string;
}
export interface ModelRoute { id: string; task_tier: TaskTier; provider_id: string; model: string; fallback_order: number }
export interface ModelConfig { providers: LlmProvider[]; routes: ModelRoute[] }
export interface ProviderInput {
  name: string; base_url: string; models: string[]; allowed_for_sensitive: boolean; enabled: boolean; priority: number;
  api_key?: string;
}
export interface ModelRouteInput { task_tier: TaskTier; provider_id: string; model: string; fallback_order: number }
export interface LlmCall {
  id: string; trace_id: string | null; app_id: string | null; provider_id: string | null;
  task_tier: TaskTier; model: string; status: "success" | "error"; duration_ms: number;
  prompt_tokens: number; completion_tokens: number; total_tokens: number; attempt: number;
  redacted: boolean; error_code: string | null; error_message: string | null; created_at: string;
}
export interface LlmInvokeResult {
  ok: true;
  content: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  provider_id: string; provider_name: string; model: string; task_tier: TaskTier; attempt: number;
  redacted: boolean; trace_id: string;
}

export const ROLE_LABEL: Record<GlobalRole, string> = {
  admin: "平台管理员", lead: "交付负责人", ba: "业务分析师", architect: "架构师", security: "信息安全", dev: "开发", qa: "测试", business: "业务方",
};
export const PHASE_LABEL = { development: "开发期", maintenance: "维护期" } as const;
export const CLASS_LABEL = { public: "公开", internal: "内部", sensitive: "敏感", confidential: "机密" } as const;
