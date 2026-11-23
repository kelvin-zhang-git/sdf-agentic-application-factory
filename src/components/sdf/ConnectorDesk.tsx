import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/data/http";
import { appsQuery } from "@/data/sdf";
import { Button } from "@/components/ui/button";

const VENDORS = [
  ["gitea", "Gitea"], ["github", "GitHub"], ["gitlab", "GitLab"], ["jira", "Jira"], ["ado", "Azure DevOps"],
  ["wecom", "企业微信"], ["dingtalk", "钉钉"], ["feishu", "飞书"], ["webhook", "Webhook"],
] as const;
const CAPABILITIES = [["code_repo", "代码仓"], ["work_item", "工作项"], ["notify", "通知"]] as const;
const STATUS_LABEL: Record<string, string> = { untested: "还没测试", success: "可以连接", error: "连接失败" };

interface ConnectorRow {
  id: string; name: string; vendor: string; capability: string; status: string; last_error: string | null;
  app_id: string | null; app_name: string | null;
  config: { base_url?: string; owner?: string; repo?: string } | string | null;
  binding: { base_url?: string; owner?: string; repo?: string } | string | null;
}

function readConfig(value: ConnectorRow["config"]): { base_url?: string; owner?: string; repo?: string } {
  if (!value) return {};
  if (typeof value === "string") {
    try { return JSON.parse(value) as { base_url?: string; owner?: string; repo?: string }; }
    catch { return {}; }
  }
  return value;
}

/** 创建连接器并绑到应用。令牌只提交一次，列表不回显。 */
export function ConnectorDesk({ appId }: { appId?: string }) {
  const qc = useQueryClient();
  const apps = useQuery({ ...appsQuery(), enabled: !appId });
  const listed = useQuery({ queryKey: ["connectors"], queryFn: () => api<{ items: ConnectorRow[] }>("/connectors") });
  const [vendor, setVendor] = useState<(typeof VENDORS)[number][0]>("gitea");
  const [capability, setCapability] = useState<(typeof CAPABILITIES)[number][0]>("code_repo");
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const rows = (listed.data?.items ?? []).filter((row) => !appId || row.app_id === appId);

  return (
    <div className="space-y-6">
      <form className="grid max-w-3xl gap-3 rounded-lg border bg-card p-4 text-sm" onSubmit={async (event) => {
        event.preventDefault();
        // React 异步回调后 SyntheticEvent.currentTarget 会置空，必须先缓存表单 DOM 引用
        const formEl = event.currentTarget;
        const form = new FormData(formEl);
        const token = String(form.get("token") ?? "");
        const hook = String(form.get("webhook_secret") ?? "").trim();
        setBusy(true);
        try {
          await api("/connectors", {
            method: "POST",
            body: {
              app_id: appId ?? String(form.get("app_id") ?? ""),
              name: String(form.get("name") ?? ""),
              vendor, capability,
              base_url: String(form.get("base_url") ?? ""),
              token,
              webhook_secret: hook || undefined,
              owner: String(form.get("owner") ?? ""),
              repo: String(form.get("repo") ?? ""),
              default_branch: String(form.get("default_branch") ?? "main"),
            },
          });
          formEl.reset();
          toast.success("已保存。令牌只留在服务器，页面不再显示");
          await qc.invalidateQueries({ queryKey: ["connectors"] });
          if (appId) await qc.invalidateQueries({ queryKey: ["app", appId, "connectors"] });
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "保存失败");
        } finally {
          setBusy(false);
        }
      }}>
        <h3 className="font-semibold">新建并绑定</h3>
        {!appId && (
          <label className="grid gap-1">应用
            <select className="h-9 rounded border px-2" name="app_id" required>
              <option value="">选择应用</option>
              {(apps.data ?? []).map((app) => <option key={app.id} value={app.id}>{app.name}</option>)}
            </select>
          </label>
        )}
        <label className="grid gap-1">名称<input className="h-9 rounded border px-2" name="name" required maxLength={100} placeholder="例如 vm-9 Gitea" /></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1">产品
            <select className="h-9 rounded border px-2" value={vendor} onChange={(event) => setVendor(event.target.value as typeof vendor)}>
              {VENDORS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          <label className="grid gap-1">用途
            <select className="h-9 rounded border px-2" value={capability} onChange={(event) => setCapability(event.target.value as typeof capability)}>
              {CAPABILITIES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
        </div>
        <label className="grid gap-1">地址<input className="h-9 rounded border px-2" name="base_url" required type="url" placeholder="http://git.example.com:3002" /></label>
        <label className="grid gap-1">访问令牌<input className="h-9 rounded border px-2" name="token" required type="password" autoComplete="off" minLength={4} /></label>
        <label className="grid gap-1">回调密钥（可选）<input className="h-9 rounded border px-2" name="webhook_secret" type="password" autoComplete="off" /></label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1">组织或项目<input className="h-9 rounded border px-2" name="owner" placeholder="sdf" /></label>
          <label className="grid gap-1">仓库<input className="h-9 rounded border px-2" name="repo" placeholder="replenish" /></label>
          <label className="grid gap-1">默认分支<input className="h-9 rounded border px-2" name="default_branch" defaultValue="main" /></label>
        </div>
        <Button type="submit" disabled={busy}>{busy ? "正在保存…" : "保存连接器"}</Button>
      </form>
      <section className="space-y-2">
        <h3 className="font-semibold">已绑定</h3>
        <ul className="space-y-2">
          {rows.map((row) => {
            const config = readConfig(row.config);
            const bound = readConfig(row.binding);
            const owner = bound.owner || config.owner;
            const repo = bound.repo || config.repo;
            return (
              <li key={`${row.id}-${row.app_id ?? "none"}`} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border bg-card p-3 text-sm">
                <div className="min-w-0 space-y-0.5">
                  <div className="font-medium">{row.name} · {VENDORS.find(([key]) => key === row.vendor)?.[1] ?? row.vendor}</div>
                  <div className="text-muted-foreground">{row.app_name || "未绑定应用"} · {CAPABILITIES.find(([key]) => key === row.capability)?.[1] ?? row.capability} · {STATUS_LABEL[row.status] ?? row.status}</div>
                  <div className="text-muted-foreground">{[config.base_url, owner, repo].filter(Boolean).join(" / ")}</div>
                  {row.last_error && <div className="text-destructive">{row.last_error}</div>}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={testingId === row.id}
                  onClick={async () => {
                    setTestingId(row.id);
                    try {
                      await api(`/connectors/${row.id}/test`, { method: "POST" });
                      toast.success("连接测试通过");
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : "连接测试未通过");
                    } finally {
                      setTestingId(null);
                      await qc.invalidateQueries({ queryKey: ["connectors"] });
                    }
                  }}
                >
                  {testingId === row.id ? "测试中…" : "测试连接"}
                </Button>
              </li>
            );
          })}
          {!rows.length && <li className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">还没有可查看的连接器</li>}
        </ul>
      </section>
    </div>
  );
}
