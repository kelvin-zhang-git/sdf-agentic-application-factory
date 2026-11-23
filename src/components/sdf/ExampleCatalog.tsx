import { useState } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { catalogQuery } from "@/data/examples";
import { api } from "@/data/http";
import { meQuery } from "@/data/sdf";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function ExampleCatalog({ kind }: { kind: "block" | "agent" }) {
  const { data } = useSuspenseQuery(catalogQuery(kind));
  const me = useQuery(meQuery());
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const admin = kind === "block" && (me.data?.global_roles.includes("admin") ?? false);
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40">
            <TableHead className="w-24">编号</TableHead>
            <TableHead>名称</TableHead>
            <TableHead className="w-32">阶段</TableHead>
            <TableHead className="w-32">状态</TableHead>
            {admin && <TableHead className="w-24 text-right">启用</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((item) => (
            <TableRow key={item.id}>
              <TableCell className="font-mono text-xs font-medium text-primary">{item.id}</TableCell>
              <TableCell className="font-medium text-foreground">
                <span>{item.name}</span>
                {item.status !== "implemented" && <Badge variant="outline" className="ml-2">示例数据</Badge>}
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {item.batch === "future" ? "后续规划" : `批次 ${item.batch}`}
              </TableCell>
              <TableCell>
                {item.status === "implemented" ? (
                  <span className="inline-flex items-center rounded-sm bg-success/12 px-2 py-0.5 text-xs font-medium text-success">
                    已实施
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-sm bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    尚未实施
                  </span>
                )}
              </TableCell>
              {admin && (
                <TableCell className="text-right">
                  <Switch
                    checked={item.enabled !== false}
                    disabled={item.status !== "implemented" || busy === item.id}
                    aria-label={`${item.enabled === false ? "启用" : "停用"} ${item.id}`}
                    onCheckedChange={async (on) => {
                      setBusy(item.id);
                      try {
                        await api(`/catalog/${item.id}`, { method: "PATCH", body: { enabled: on } });
                        await client.invalidateQueries({ queryKey: ["catalog", kind] });
                        toast.success(on ? `${item.id} 已启用` : `${item.id} 已停用，新运行会跳过它`);
                      } catch (error) {
                        toast.error(error instanceof Error ? error.message : "启停失败");
                      } finally {
                        setBusy(null);
                      }
                    }}
                  />
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
