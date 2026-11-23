import { useSyncExternalStore } from "react";
import { getLiveMode, subscribeLiveMode } from "@/data/live";
import { cn } from "@/lib/utils";

export function LiveNote() {
  const mode = useSyncExternalStore(subscribeLiveMode, getLiveMode, () => "poll" as const);
  const live = mode === "live";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-panel px-2.5 py-1 text-xs text-muted-foreground"
      role="status"
    >
      <span
        className={cn("size-2 rounded-full", live ? "bg-success" : "bg-warning")}
        aria-hidden
      />
      <span>{live ? "已连接实时更新" : "实时连接已断开，每 5 秒刷新"}</span>
    </span>
  );
}
