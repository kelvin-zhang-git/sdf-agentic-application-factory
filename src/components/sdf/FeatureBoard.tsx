import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { analyzeImpact, applyDomainPack, distributeFeatures, featureBoardQuery, sensitiveRouteQuery } from "@/data/oem";
import { downloadFile } from "@/data/download";
import { api } from "@/data/http";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorBox, errorText } from "./common";

const STATUS: Record<string, string> = {
  draft: "草稿", spec_confirmed: "规格已确认", handed_off: "已交接", merged: "已合并", accepted: "已验收",
};

export function FeatureBoard({ appId, canEdit }: { appId: string; canEdit: boolean }) {
  const board = useQuery(featureBoardQuery(appId));
  const route = useQuery(sensitiveRouteQuery(appId));
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["app", appId, "features"] }); };
  const iteration = board.data?.iterations[0]?.id ?? null;
  return (
    <div className="space-y-6">
      <section className="panel-surface space-y-3 rounded-md p-5">
        <h3 className="font-semibold">模型路由</h3>
        <p className="text-sm text-muted-foreground">{route.data?.reason ?? "正在检查可用的模型服务。"}</p>
        {route.data?.blocked && <Badge variant="destructive">机密资料暂不能调用模型</Badge>}
      </section>
      <section className="panel-surface space-y-3 rounded-md p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">功能与版本</h3>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={async () => { try { await applyDomainPack(appId); toast.success("已套用汽车领域包"); refresh(); } catch (e) { setErr(e); } }}>套用汽车领域包</Button>
              <Button size="sm" variant="outline" onClick={async () => { try { const r = await distributeFeatures(appId); toast.success(`已归入 ${r.assigned} 条需求`); refresh(); } catch (e) { setErr(e); } }}>把需求分到功能</Button>
            </div>
          )}
        </div>
        <ErrorBox error={err ?? board.error} />
        <div className="grid gap-3 md:grid-cols-2">
          {(board.data?.items ?? []).map((item) => (
            <article key={item.id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">{item.code}</span>
                <h4 className="font-semibold">{item.name}</h4>
                <Badge variant="outline">{STATUS[item.status] ?? item.status}</Badge>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{item.requirement_count} 条需求</p>
            </article>
          ))}
          {board.data && board.data.items.length === 0 && <p className="text-sm text-muted-foreground">还没有功能。套用汽车领域包后会出现问题登记、指派与整改、复检关闭、试制节点验收条件和供应商协同。</p>}
        </div>
        <div>
          <h4 className="mb-2 text-sm font-semibold">版本</h4>
          <ul className="space-y-1 text-sm">{(board.data?.iterations ?? []).map((item) => <li key={item.id}><span className="font-mono">{item.code}</span> {item.name} · {item.status === "released" ? "已发布" : "进行中"}</li>)}</ul>
        </div>
      </section>
      <section className="panel-surface space-y-3 rounded-md p-5">
        <h3 className="font-semibold">变更影响</h3>
        <p className="text-sm text-muted-foreground">按需求编号列出验收标准、测试、任务和已认领的合并请求，并生成一份待确认的变更。</p>
        {canEdit && (
          <form className="flex flex-wrap gap-2" onSubmit={async (event) => {
            event.preventDefault();
            try { const result = await analyzeImpact(appId, code.trim(), iteration); toast.success(result.summary); setCode(""); refresh(); }
            catch (e) { toast.error(errorText(e)); }
          }}>
            <Input className="w-48" placeholder="例如 REQ-0001" aria-label="需求编号" value={code} onChange={(event) => setCode(event.target.value)} />
            <Button type="submit" size="sm">分析影响</Button>
          </form>
        )}
        <ul className="space-y-2 text-sm">
          {(board.data?.changes ?? []).map((item) => (
            <li key={item.code} className="rounded border p-2">
              <span className="font-mono">{item.code}</span> {item.title}
              <p className="text-muted-foreground">{item.business_summary}</p>
            </li>
          ))}
        </ul>
      </section>
      <section className="panel-surface space-y-3 rounded-md p-5">
        <h3 className="font-semibold">回写与证据</h3>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => downloadFile(`/apps/${appId}/export/requirements.csv`, "requirements.csv", "text/csv").catch((e) => toast.error(errorText(e)))}>需求 CSV</Button>
          <Button size="sm" variant="outline" onClick={() => downloadFile(`/apps/${appId}/export/requirements.reqif`, "requirements.reqif", "application/xml").catch((e) => toast.error(errorText(e)))}>需求 ReqIF</Button>
          <Button size="sm" variant="outline" onClick={() => downloadFile(`/apps/${appId}/export/spec-kit`, "spec-kit.zip", "application/zip").catch((e) => toast.error(errorText(e)))}>Spec Kit</Button>
          <Button size="sm" variant="outline" onClick={() => downloadFile(`/apps/${appId}/export/evidence-pack`, "evidence-pack.zip", "application/zip").catch((e) => toast.error(errorText(e)))}>版本证据包</Button>
          <Button size="sm" variant="outline" onClick={async () => { try { const data = await api<{ users: { name: string }[] }>(`/apps/${appId}/mocks/sso`); toast.success(`统一身份认证模拟：${data.users.map((user) => user.name).join("、")}`); } catch (e) { toast.error(errorText(e)); } }}>查看身份模拟</Button>
          <Button size="sm" variant="outline" onClick={async () => { try { const data = await api<{ vehicles: { code: string }[] }>(`/apps/${appId}/mocks/mes`); toast.success(`制造执行模拟：${data.vehicles.map((vehicle) => vehicle.code).join("、")}`); } catch (e) { toast.error(errorText(e)); } }}>查看车辆模拟</Button>
        </div>
      </section>
    </div>
  );
}
