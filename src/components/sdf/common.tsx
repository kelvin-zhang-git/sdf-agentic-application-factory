import type { ReactNode } from "react";
import { ApiError } from "@/data/http";
import { Badge } from "@/components/ui/badge";

export function PageHeader({
  title,
  desc,
  eyebrow,
  actions,
}: {
  title: string;
  desc?: string | undefined;
  eyebrow?: string | undefined;
  actions?: ReactNode;
}) {
  return (
    <div className="panel-surface mb-6 overflow-hidden rounded-md">
      <div className="blueprint-grid">
        <div className="flex flex-wrap items-end justify-between gap-4 bg-panel/85 px-5 py-5 sm:px-6">
          <div className="min-w-0">
            <p className="stencil text-[10px] font-medium text-primary">
              {eyebrow ?? "ENTERPRISE SDF WORKBENCH"}
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
            {desc && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{desc}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      </div>
    </div>
  );
}

export function Planned({ batch, what }: { batch: string; what: string }) {
  return (
    <div className="panel-surface rounded-md border-dashed p-8 text-center">
      <Badge variant="outline" className="mb-3">规划中 · 批次 {batch}</Badge>
      <p className="text-sm text-muted-foreground">{what}将在批次 {batch} 实现，目前尚未实施。</p>
    </div>
  );
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.errorId ? `${e.message}（错误编号 ${e.errorId}）` : e.message;
  return e instanceof Error ? e.message : "操作失败";
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {errorText(error)}
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs text-muted-foreground tabular-nums">{children}</span>;
}
