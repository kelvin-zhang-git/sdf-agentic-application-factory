import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CommandDialog, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { api } from "@/data/http";

interface Hit { kind: string; code: string; title: string; app_id: string; run_id: string | null }

const OPEN_EVENT = "sdf:open-search";

export function openCommandPalette() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(OPEN_EVENT));
  }
}

/** Ctrl/Cmd+K 或点击侧栏搜索框打开。结果来自当前用户能看见的编号和标题。 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Hit[]>([]);
  const nav = useNavigate();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);
  useEffect(() => {
    if (!open || q.trim().length < 2) { setItems([]); return; }
    const timer = window.setTimeout(() => {
      api<{ items: Hit[] }>(`/search?q=${encodeURIComponent(q.trim())}`).then((result) => setItems(result.items)).catch(() => setItems([]));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [open, q]);
  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput value={q} onValueChange={setQ} placeholder="搜索编号或标题，例如 REQ-0001、T-0001" />
      <CommandList>
        <CommandEmpty>{q.trim().length < 2 ? "至少输入两个字开始检索" : "没有找到匹配项"}</CommandEmpty>
        {items.map((item) => (
          <CommandItem key={`${item.kind}-${item.code}-${item.run_id ?? item.app_id}`} value={`${item.code} ${item.title}`} onSelect={() => {
            setOpen(false);
            if (item.run_id) nav({ to: "/apps/$appId/runs/$runId", params: { appId: item.app_id, runId: item.run_id } });
            else nav({ to: "/apps/$appId", params: { appId: item.app_id } });
          }}>
            <span className="rounded-xs bg-primary/10 px-1.5 py-0.5 font-mono text-xs font-medium text-primary">{item.code}</span>
            <span className="stencil text-[10px] text-muted-foreground">{item.kind}</span>
            <span className="truncate text-foreground">{item.title}</span>
          </CommandItem>
        ))}
      </CommandList>
    </CommandDialog>
  );
}

export function useWorkflowPreview(yaml: string) {
  const qc = useQueryClient();
  return { qc, ...useQuery({
    queryKey: ["workflow-validate", yaml],
    enabled: yaml.trim().length > 2,
    queryFn: () => api<{ issues: string[]; plans: Record<string, { key: string; name: string; skipped: boolean; checkpoint: string | null }[]> }>("/workflows/validate", { method: "POST", body: { yaml } }),
  }) };
}
