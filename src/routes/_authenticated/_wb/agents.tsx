import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/data/http";
import { meQuery } from "@/data/sdf";
import { PageHeader } from "@/components/sdf/common";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/_wb/agents")({
  head: () => ({ meta: [
    { title: "智能体 · SDF 智能应用工厂" },
    { name: "description", content: "查看智能体角色、提示词版本和调用统计" },
    { property: "og:title", content: "智能体 · SDF 智能应用工厂" },
    { property: "og:description", content: "查看智能体角色、提示词版本和调用统计" },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  loader: ({ context }) => context.queryClient.ensureQueryData(meQuery()),
  component: AgentsPage,
});

interface AgentRow {
  key: string; name: string; summary: string; prompt: string; version: number; versions: number;
  stats: { calls: number; tokens: number; approved: number; edited: number; rejected: number };
}

function AgentsPage() {
  const me = useQuery(meQuery());
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<{ items: AgentRow[] }>("/agents") });
  const admin = me.data?.global_roles.includes("admin") ?? false;
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="AGENT PERSONA REGISTRY" title="智能体" desc="十个内置专业角色。管理员每次保存系统提示词都会生成可审计新版本，运行时自动注入最新版本。" />
      <ul className="space-y-3">
        {(agents.data?.items ?? []).map((agent) => (
          <li key={agent.key} className="panel-surface rounded-md p-5 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-semibold text-foreground">{agent.name}</span>
                  <span className="rounded-xs border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-primary">
                    {agent.key}
                  </span>
                  <span className="rounded-xs bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-primary tabular-nums">
                    v{agent.version} · 共 {agent.versions} 版
                  </span>
                </div>
                <div className="mt-1.5 text-sm text-muted-foreground">{agent.summary}</div>
              </div>
              <div className="flex flex-wrap items-center gap-3 rounded-sm border border-border bg-background/60 px-3 py-2 font-mono text-xs text-muted-foreground tabular-nums">
                <span>调用 {agent.stats.calls}</span>
                <span className="text-border">|</span>
                <span>{agent.stats.tokens} Token</span>
                <span className="text-border">|</span>
                <span>通过 {agent.stats.approved}</span>
                <span className="text-border">|</span>
                <span>修改通过 {agent.stats.edited}</span>
                <span className="text-border">|</span>
                <span>退回 {agent.stats.rejected}</span>
              </div>
            </div>
            <div className="mt-3">
              <Button size="sm" variant="outline" onClick={() => setOpen(open === agent.key ? null : agent.key)}>
                {open === agent.key ? "收起" : "查看提示词"}
              </Button>
            </div>
            {open === agent.key && <PromptEditor agent={agent} canEdit={admin} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PromptEditor({ agent, canEdit }: { agent: AgentRow; canEdit: boolean }) {
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState(agent.prompt);
  return (
    <form className="mt-4 space-y-2.5 border-t border-border pt-4" onSubmit={async (event) => {
      event.preventDefault();
      try {
        const saved = await api<{ version: number }>(`/agents/${agent.key}/prompts`, { method: "POST", body: { prompt } });
        toast.success(`已保存为第 ${saved.version} 版`);
        await qc.invalidateQueries({ queryKey: ["agents"] });
      } catch (error) { toast.error(error instanceof Error ? error.message : "不能保存"); }
    }}>
      <textarea className="min-h-80 w-full rounded-md border border-input bg-background p-3.5 font-mono text-xs leading-relaxed" value={prompt} onChange={(event) => setPrompt(event.target.value)} readOnly={!canEdit} />
      {canEdit && <Button size="sm" type="submit">保存为新版本</Button>}
    </form>
  );
}
