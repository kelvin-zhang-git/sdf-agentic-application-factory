// Data access functions: components call only these (migration constraint §10.1).
import { queryOptions } from "@tanstack/react-query";
import { api, ApiError } from "./http";
import type { Me, AppRow, Member, AppContact, AuditRow, AdminUser, DirectoryUser, AppRole, GlobalRole, ModelConfig, LlmProvider, ProviderInput, ModelRoute, ModelRouteInput, LlmCall, LlmInvokeResult, TaskTier } from "./types";

export const meQuery = () => queryOptions({ queryKey: ["me"], queryFn: () => api<Me>("/me") });
export const appsQuery = () => queryOptions({ queryKey: ["apps"], queryFn: () => api<{ items: AppRow[] }>("/apps").then((r) => r.items) });
export const appQuery = (id: string) => queryOptions({ queryKey: ["app", id], queryFn: () => api<AppRow>(`/apps/${id}`) });
export interface ReleaseNote { id: string; version: string; notes_business: string | null; published_at: string | null }
export const releasesQuery = (id: string) => queryOptions({ queryKey: ["app", id, "releases"], queryFn: () => api<{ items: ReleaseNote[] }>(`/apps/${id}/releases`).then((r) => r.items) });
export const membersQuery = (id: string) => queryOptions({ queryKey: ["app", id, "members"], queryFn: () => api<{ items: Member[] }>(`/apps/${id}/members`).then((r) => r.items) });
export const appDirectoryQuery = (id: string) => queryOptions({ queryKey: ["app", id, "directory"], queryFn: () => api<{ items: DirectoryUser[] }>(`/apps/${id}/directory`).then((r) => r.items) });
export const contactsQuery = (id: string) => queryOptions({ queryKey: ["app", id, "contacts"], queryFn: () => api<{ items: AppContact[] }>(`/apps/${id}/contacts`).then((r) => r.items) });
export const auditQuery = (filters: { appId?: string; action?: string; targetType?: string; from?: string; to?: string } = {}) => queryOptions({
  queryKey: ["audit", filters],
  queryFn: () => {
    const params = new URLSearchParams();
    if (filters.appId) params.set("app_id", filters.appId);
    if (filters.action) params.set("action", filters.action);
    if (filters.targetType) params.set("target_type", filters.targetType);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    const q = params.toString();
    return api<{ items: AuditRow[] }>(`/audit${q ? `?${q}` : ""}`).then((r) => r.items);
  },
});
export const adminUsersQuery = () => queryOptions({ queryKey: ["admin", "users"], queryFn: () => api<{ items: AdminUser[] }>("/admin/users").then((r) => r.items) });
export const metaQuery = () => queryOptions({ queryKey: ["meta"], queryFn: () => api<Record<string, unknown>>("/meta") });

export type AppInput = Pick<AppRow, "name" | "description" | "phase" | "classification" | "redact_before_llm"> & { current_version?: string | null; redact_terms?: string[] };
export const createApp = (input: AppInput) => api<AppRow>("/apps", { method: "POST", body: input });
export const updateApp = (id: string, input: Partial<AppInput>) => api<AppRow>(`/apps/${id}`, { method: "PATCH", body: input });
export const addMember = (id: string, email: string, role: AppRole) => api(`/apps/${id}/members`, { method: "POST", body: { email, role } });
export const setAppUserRoles = (appId: string, userId: string, roles: AppRole[], expires_at?: string | null) =>
  api(`/apps/${appId}/members/by-user/${userId}`, {
    method: "PUT",
    body: expires_at === undefined ? { roles } : { roles, expires_at },
  });
export const removeMember = (id: string, mid: string) => api(`/apps/${id}/members/${mid}`, { method: "DELETE" });
export const addContact = (id: string, input: { name: string; title: string; org: string; email: string | null; app_role: AppRole; is_business: boolean }) =>
  api(`/apps/${id}/contacts`, { method: "POST", body: input });
export const removeContact = (id: string, acid: string) => api(`/apps/${id}/contacts/${acid}`, { method: "DELETE" });
export const linkContact = (id: string, acid: string, unlink = false) => api(`/apps/${id}/contacts/${acid}/link`, { method: "POST", body: { unlink } });
export const bootstrapAdmin = (token: string) => api("/bootstrap", { method: "POST", headers: { "X-SDF-Bootstrap-Token": token } });
export const setUserRoles = (uid: string, roles: GlobalRole[]) => api(`/admin/users/${uid}/roles`, { method: "PUT", body: { roles } });
export const setAccountExpiry = (uid: string, expires_at: string | null) => api(`/admin/users/${uid}/expiry`, { method: "PUT", body: { expires_at } });
export const setMemberExpiry = (appId: string, memberId: string, expires_at: string | null) => api(`/apps/${appId}/members/${memberId}/expiry`, { method: "PATCH", body: { expires_at } });

type OperationFailure = { ok: false; error: { code: string; message: string; error_id: string; trace_id: string } };
async function operationResult<T extends { ok: true }>(request: Promise<T | OperationFailure>): Promise<T> {
  const result = await request;
  if (!result.ok) throw new ApiError(200, result.error.code, result.error.message, result.error.error_id, result.error.trace_id);
  return result;
}

export const modelConfigQuery = () => queryOptions({ queryKey: ["admin", "models"], queryFn: () => api<ModelConfig>("/admin/models") });
export const modelCallsQuery = () => queryOptions({ queryKey: ["admin", "model-calls"], queryFn: () => api<{ items: LlmCall[] }>("/admin/models/calls").then((r) => r.items) });
export const createProvider = (input: ProviderInput & { api_key: string }) => api<LlmProvider>("/admin/models/providers", { method: "POST", body: input });
export const updateProvider = (id: string, input: Partial<ProviderInput>) => api<LlmProvider>(`/admin/models/providers/${id}`, { method: "PATCH", body: input });
export const deleteProvider = (id: string) => api(`/admin/models/providers/${id}`, { method: "DELETE" });
export const discoverProviderModels = (id: string) => operationResult(api<{ ok: true; models: string[] } | OperationFailure>(`/admin/models/providers/${id}/discover`, { method: "POST" }));
export const testProvider = (id: string, model: string) => operationResult(api<{ ok: true; duration_ms: number } | OperationFailure>(`/admin/models/providers/${id}/test`, { method: "POST", body: { model } }));
export const createModelRoute = (input: ModelRouteInput) => api<ModelRoute>("/admin/models/routes", { method: "POST", body: input });
export const updateModelRoute = (id: string, input: Partial<ModelRouteInput>) => api<ModelRoute>(`/admin/models/routes/${id}`, { method: "PATCH", body: input });
export const deleteModelRoute = (id: string) => api(`/admin/models/routes/${id}`, { method: "DELETE" });
export const invokeModel = (input: { app_id: string; task_tier: TaskTier; messages: { role: "system" | "user" | "assistant"; content: string }[]; max_tokens?: number }) =>
  operationResult(api<LlmInvokeResult | OperationFailure>("/admin/models/invoke", { method: "POST", body: input }));
