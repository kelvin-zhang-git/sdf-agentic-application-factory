import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { STATUS_LABEL } from "@/data/runs";

export interface BarStep { key: string; name: string; status: string; checkpoint?: string | null; summary?: string | null; attempt?: number }
const tone = (s: string) =>
  s === "succeeded" ? "bg-success text-success-foreground border-success" :
  s === "running" ? "bg-primary text-primary-foreground border-primary" :
  s === "waiting_human" || s === "waiting_model" ? "bg-warning text-warning-foreground border-warning" :
  s === "failed" || s === "rejected" ? "bg-destructive text-destructive-foreground border-destructive" :
  s === "skipped" ? "bg-background text-muted-foreground border-dashed border-muted-foreground/60" :
  s === "cancelled" ? "bg-muted text-muted-foreground border-muted-foreground/50" : "bg-panel text-muted-foreground border-border";

/** Shared step bar: diamonds are checkpoints, the single active step pulses, skipped steps are dashed. */
export function StepBar({ steps, compact = false, onSelect, selected }: { steps: BarStep[]; compact?: boolean; onSelect?: (key: string) => void; selected?: string | null }) {
  const active = steps.find((s) => ["running", "waiting_human", "waiting_model"].includes(s.status))?.key;
  return (
    <TooltipProvider delayDuration={150}>
      <ol className={cn("flex items-center", compact ? "gap-1" : "gap-2 overflow-x-auto pb-1.5")} aria-label="步骤进度">
        {steps.map((s, i) => (
          <li key={s.key} className="flex items-center gap-1">
            {i > 0 && <span className={cn("h-px bg-border", compact ? "w-2" : "w-5")} aria-hidden />}
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" onClick={() => onSelect?.(s.key)} aria-label={`${s.name}：${STATUS_LABEL[s.status] ?? s.status}`}
                  className={cn("group flex items-center gap-2 rounded-xs px-1 py-0.5 transition-colors", onSelect ? "cursor-pointer hover:bg-muted/70" : "cursor-default")}>
                  <span className={cn("grid place-items-center border font-mono text-[10px] font-semibold tabular-nums transition-transform", compact ? "size-3" : "size-6",
                    s.checkpoint ? "rotate-45 rounded-[2px]" : "rounded-full", tone(s.status), s.key === active && "animate-pulse",
                    selected === s.key && "ring-2 ring-ring ring-offset-2 ring-offset-background")}>
                    {!compact && <span className={cn(s.checkpoint && "-rotate-45")}>{i + 1}</span>}
                  </span>
                  {!compact && <span className="whitespace-nowrap text-xs font-medium text-foreground">{s.name}{(s.attempt ?? 1) > 1 && <span className="ml-1 font-mono text-[11px] text-muted-foreground">#{s.attempt}</span>}</span>}
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs"><p className="font-medium">{s.name} · {STATUS_LABEL[s.status] ?? s.status}{s.checkpoint ? ` · 确认点：${s.checkpoint}` : ""}</p>{s.summary && <p className="mt-1 text-xs">{s.summary}</p>}</TooltipContent>
            </Tooltip>
          </li>
        ))}
      </ol>
    </TooltipProvider>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={cn("inline-flex items-center rounded-sm border px-2 py-0.5 font-mono text-[11px] font-medium", tone(status))}>{STATUS_LABEL[status] ?? status}</span>;
}

export function since(ts: string | null | undefined): string {
  if (!ts) return "-";
  const m = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  return m < 60 ? `${m} 分钟` : m < 1440 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${Math.floor(m / 1440)} 天`;
}
