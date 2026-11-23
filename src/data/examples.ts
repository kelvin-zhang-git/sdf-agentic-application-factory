import { queryOptions } from "@tanstack/react-query";
import { api } from "./http";
export interface CatalogEntry { id: string; kind: "block" | "agent"; name: string; batch: string; status: "not_started" | "implemented"; source: "seed"; enabled?: boolean }
export interface ExampleArtifact { id: string; app_id: string; title: string; format: "markdown" | "json" | "yaml" | "mermaid"; version: number; content: string; source: "seed" }
export const catalogQuery = (kind: "block" | "agent") => queryOptions({ queryKey: ["catalog", kind], queryFn: () => api<{ items: CatalogEntry[] }>(`/catalog?kind=${kind}`).then((r) => r.items) });
export const artifactsQuery = (id: string) => queryOptions({ queryKey: ["app", id, "artifacts"], queryFn: () => api<{ items: ExampleArtifact[] }>(`/apps/${id}/artifacts`).then((r) => r.items) });