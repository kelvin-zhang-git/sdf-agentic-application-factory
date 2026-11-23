import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/data/http";
import { errorText } from "@/components/sdf/common";
import { Button } from "@/components/ui/button";

interface TokenRow { id: string; name: string; token_prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }

export function TokenPanel() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => api<{ items: TokenRow[] }>("/tokens") });
  const [name, setName] = useState("命令行");
  const [fresh, setFresh] = useState("");
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">令牌以 sdf_pat_ 开头，只在创建时显示一次。命令行和编码工具用它访问本人能看到的任务。MCP 地址是 /api/mcp，请求头写 Authorization: Bearer 加上完整令牌。</p>
      <form className="flex flex-wrap items-center gap-2" onSubmit={async (event) => {
        event.preventDefault();
        try {
          const created = await api<{ token: string }>("/tokens", { method: "POST", body: { name } });
          setFresh(created.token);
          await qc.invalidateQueries({ queryKey: ["tokens"] });
        } catch (error) { toast.error(errorText(error)); }
      }}>
        <input className="h-9 rounded-md border bg-background px-3 text-sm" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} aria-label="令牌名称" />
        <Button type="submit" size="sm">签发令牌</Button>
      </form>
      {fresh ? <pre className="overflow-auto rounded-lg border bg-muted p-3 font-mono text-xs">{fresh}</pre> : null}
      <ul className="space-y-2 text-sm">
        {(tokens.data?.items ?? []).map((item) => (
          <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2">
            <span>{item.name} <span className="font-mono text-xs text-muted-foreground">{item.token_prefix}…</span> {item.revoked_at ? "已吊销" : item.last_used_at ? "已使用" : "未使用"}</span>
            {!item.revoked_at && <Button size="sm" variant="outline" onClick={async () => {
              try { await api(`/tokens/${item.id}/revoke`, { method: "POST" }); setFresh(""); await qc.invalidateQueries({ queryKey: ["tokens"] }); }
              catch (error) { toast.error(errorText(error)); }
            }}>吊销</Button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
