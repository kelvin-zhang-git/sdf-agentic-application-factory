import { queryOptions } from "@tanstack/react-query";
import { api } from "./http";

export interface FeatureRow { id: string; code: string; name: string; status: string; iteration_id: string | null; requirement_count: number }
export interface FeatureBoard {
  items: FeatureRow[];
  iterations: { id: string; code: string; name: string; status: string }[];
  changes: { code: string; title: string; status: string; business_summary: string; requirement_codes: string[]; created_at: string }[];
}
export const featureBoardQuery = (appId: string) => queryOptions({
  queryKey: ["app", appId, "features"],
  queryFn: () => api<FeatureBoard>(`/apps/${appId}/features`),
});
export const sensitiveRouteQuery = (appId: string) => queryOptions({
  queryKey: ["app", appId, "sensitive-route"],
  queryFn: () => api<{ classification: string; allowed_for_sensitive: number; blocked: boolean; reason: string }>(`/apps/${appId}/sensitive-route`),
});
export const applyDomainPack = (appId: string) => api<{ features: string[] }>(`/apps/${appId}/domain-pack/apply`, { method: "POST", body: {} });
export const distributeFeatures = (appId: string) => api<{ assigned: number }>(`/apps/${appId}/features/distribute`, { method: "POST", body: {} });
export const analyzeImpact = (appId: string, code: string, iteration_id: string | null) => api<{ summary: string; change_request: string }>(`/apps/${appId}/requirements/impact`, { method: "POST", body: { code, iteration_id } });
export const fillExternalRefs = (appId: string) => api<{ filled: number }>(`/apps/${appId}/requirements/external-refs`, { method: "POST", body: {} });
