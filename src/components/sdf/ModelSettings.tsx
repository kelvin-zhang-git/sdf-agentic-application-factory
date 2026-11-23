import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  appsQuery,
  createModelRoute,
  createProvider,
  deleteModelRoute,
  deleteProvider,
  discoverProviderModels,
  invokeModel,
  modelCallsQuery,
  modelConfigQuery,
  testProvider,
  updateProvider,
} from "@/data/sdf";
import type { LlmInvokeResult, LlmProvider, ModelConfig, ModelRouteInput, ProviderInput, TaskTier } from "@/data/types";
import { CLASS_LABEL } from "@/data/types";
import { ErrorBox, errorText, Mono } from "./common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

const TIER_LABEL: Record<TaskTier, string> = { fast: "快速", standard: "标准", deep: "深度" };
const STATUS_LABEL = { untested: "未测试", success: "连接成功", error: "连接失败" } as const;

export function ModelSettings() {
  const config = useQuery(modelConfigQuery());
  const calls = useQuery(modelCallsQuery());
  const qc = useQueryClient();
  const [editing, setEditing] = useState<LlmProvider | "new" | null>(null);
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["admin", "models"] }),
      qc.invalidateQueries({ queryKey: ["admin", "model-calls"] }),
      qc.invalidateQueries({ queryKey: ["audit"] }),
    ]);
  };
  const run = async (action: () => Promise<unknown>, success: string) => {
    try { await action(); await refresh(); toast.success(success); }
    catch (error) { await refresh(); toast.error(errorText(error)); }
  };

  return (
    <div className="space-y-10">
      <ErrorBox error={config.error} />
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">LiteLLM / OpenAI 兼容模型服务</h3>
            <p className="mt-1 text-sm text-muted-foreground">地址和模型 ID 均从数据库读取；密钥加密保存，界面只显示后 4 位。</p>
          </div>
          <Button onClick={() => setEditing("new")}>添加模型服务</Button>
        </div>
        {editing && (
          <ProviderForm
            key={editing === "new" ? "new" : editing.id}
            initial={editing === "new" ? undefined : editing}
            onCancel={() => setEditing(null)}
            onSaved={async () => { setEditing(null); await refresh(); }}
          />
        )}
        <div className="space-y-3">
          {(config.data?.providers ?? []).map((provider) => (
            <article key={provider.id} className="rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="font-medium">{provider.name}</h4>
                    <Badge variant={provider.enabled ? "default" : "outline"}>{provider.enabled ? "已启用" : "已停用"}</Badge>
                    <Badge variant="outline">{STATUS_LABEL[provider.last_status]}</Badge>
                    {provider.allowed_for_sensitive && <Badge variant="secondary">允许敏感数据</Badge>}
                  </div>
                  <Mono>{provider.base_url}</Mono>
                  <div className="flex flex-wrap gap-1">
                    {provider.models.map((model) => <Badge key={model} variant="outline">{model}</Badge>)}
                    {!provider.models.length && <span className="text-sm text-muted-foreground">尚未配置模型 ID</span>}
                  </div>
                  <p className="text-xs text-muted-foreground">密钥：••••{provider.key_last4 ?? "无法读取"} · 优先级：{provider.priority}</p>
                  {provider.last_error && <p className="text-sm text-destructive">{provider.last_error}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={!provider.models.length} onClick={() => { const model = provider.models[0]; if (model) void run(() => testProvider(provider.id, model), "连接测试成功"); }}>测试连接</Button>
                  <Button size="sm" variant="outline" onClick={() => run(() => discoverProviderModels(provider.id), "已读取模型列表")}>获取模型列表</Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(provider)}>编辑</Button>
                  <Button size="sm" variant="destructive" onClick={() => {
                    if (!window.confirm(`确定删除模型服务「${provider.name}」及其路由吗？`)) return;
                    void run(() => deleteProvider(provider.id), "模型服务已删除");
                  }}>删除</Button>
                </div>
              </div>
            </article>
          ))}
          {config.data && !config.data.providers.length && !editing && (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">尚未配置模型。添加服务后才能进行真实模型调用。</div>
          )}
        </div>
      </section>

      {config.data && <RoutesSection config={config.data} run={run} />}
      <InvokeSection run={run} />
      <section className="space-y-3">
        <div>
          <h3 className="font-semibold">最近模型调用</h3>
          <p className="text-sm text-muted-foreground">只记录用量、状态与错误，不保存提示词和返回正文。</p>
        </div>
        <ErrorBox error={calls.error} />
        <Table>
          <TableHeader><TableRow><TableHead>时间</TableHead><TableHead>档位 / 模型</TableHead><TableHead>结果</TableHead><TableHead>Token</TableHead><TableHead>用时</TableHead><TableHead>追踪编号</TableHead></TableRow></TableHeader>
          <TableBody>
            {(calls.data ?? []).slice(0, 20).map((call) => (
              <TableRow key={call.id}>
                <TableCell className="whitespace-nowrap">{new Date(call.created_at).toLocaleString()}</TableCell>
                <TableCell>{TIER_LABEL[call.task_tier]} / {call.model}{call.attempt > 1 ? ` · 第 ${call.attempt} 次` : ""}</TableCell>
                <TableCell><span className={call.status === "error" ? "text-destructive" : "text-muted-foreground"}>{call.status === "success" ? "成功" : `${call.error_code ?? "失败"}：${call.error_message ?? ""}`}</span></TableCell>
                <TableCell>{call.total_tokens}</TableCell><TableCell>{call.duration_ms} ms</TableCell><TableCell><Mono>{call.trace_id}</Mono></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}

function ProviderForm({ initial, onCancel, onSaved }: { initial?: LlmProvider | undefined; onCancel: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? "");
  const [models, setModels] = useState(initial?.models.join("\n") ?? "");
  const [apiKey, setApiKey] = useState("");
  const [allowed, setAllowed] = useState(initial?.allowed_for_sensitive ?? false);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [priority, setPriority] = useState(initial?.priority ?? 100);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async () => {
    setPending(true); setError(null);
    const input: ProviderInput = {
      name, base_url: baseUrl, models: models.split(/[\n,，]+/).map((x) => x.trim()).filter(Boolean),
      allowed_for_sensitive: allowed, enabled, priority,
      ...(apiKey ? { api_key: apiKey } : {}),
    };
    try {
      if (initial) await updateProvider(initial.id, input);
      else await createProvider({ ...input, api_key: apiKey });
      toast.success(initial ? "模型服务已保存" : "模型服务已添加");
      await onSaved();
    } catch (e) { setError(e); }
    finally { setPending(false); }
  };
  return (
    <div className="space-y-4 rounded-lg border bg-muted/30 p-4">
      <h4 className="font-medium">{initial ? "编辑模型服务" : "添加模型服务"}</h4>
      <ErrorBox error={error} />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="provider-name">名称</Label><Input id="provider-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：团队 LiteLLM" /></div>
        <div className="space-y-2"><Label htmlFor="provider-url">接口根地址</Label><Input id="provider-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://litellm.example.com/v1" /></div>
        <div className="space-y-2"><Label htmlFor="provider-models">模型 ID（每行一个）</Label><Textarea id="provider-models" value={models} onChange={(e) => setModels(e.target.value)} rows={4} placeholder="从 LiteLLM 配置中复制模型 ID" /></div>
        <div className="space-y-2"><Label htmlFor="provider-key">API Key{initial ? "（留空则保持不变）" : ""}</Label><Input id="provider-key" type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={initial ? "••••••••" : "仅提交给服务端加密保存"} /><Label htmlFor="provider-priority">优先级</Label><Input id="provider-priority" type="number" min={1} value={priority} onChange={(e) => setPriority(Number(e.target.value))} /></div>
      </div>
      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm"><Switch checked={enabled} onCheckedChange={setEnabled} />启用此服务</label>
        <label className="flex items-center gap-2 text-sm"><Switch checked={allowed} onCheckedChange={setAllowed} />允许用于敏感 / 机密应用</label>
      </div>
      <div className="flex gap-2"><Button disabled={pending || !name || !baseUrl || (!initial && !apiKey)} onClick={submit}>{pending ? "保存中…" : "保存"}</Button><Button variant="outline" onClick={onCancel}>取消</Button></div>
    </div>
  );
}

function RoutesSection({ config, run }: { config: ModelConfig; run: (action: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [tier, setTier] = useState<TaskTier>("standard");
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [order, setOrder] = useState(1);
  const provider = config.providers.find((p) => p.id === providerId);
  const add = async () => {
    if (!providerId || !model) { toast.error("请选择模型服务和模型 ID"); return; }
    const input: ModelRouteInput = { task_tier: tier, provider_id: providerId, model, fallback_order: order };
    await run(() => createModelRoute(input), "模型路由已添加");
  };
  return (
    <section className="space-y-4">
      <div><h3 className="font-semibold">三档任务与备用顺序</h3><p className="text-sm text-muted-foreground">顺序 1 为主模型，失败后依次尝试后续模型；敏感应用不会使用未授权服务。</p></div>
      <div className="grid items-end gap-3 rounded-lg border bg-muted/30 p-4 md:grid-cols-5">
        <div className="space-y-2"><Label>任务档</Label><Select value={tier} onValueChange={(v) => setTier(v as TaskTier)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(TIER_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-2"><Label>模型服务</Label><Select value={providerId} onValueChange={(v) => { setProviderId(v); setModel(""); }}><SelectTrigger><SelectValue placeholder="选择服务" /></SelectTrigger><SelectContent>{config.providers.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-2"><Label>模型 ID</Label><Select value={model} onValueChange={setModel} disabled={!provider}><SelectTrigger><SelectValue placeholder="从数据库配置选择" /></SelectTrigger><SelectContent>{provider?.models.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-2"><Label htmlFor="route-order">备用顺序</Label><Input id="route-order" type="number" min={1} max={100} value={order} onChange={(e) => setOrder(Number(e.target.value))} /></div>
        <Button onClick={add}>添加路由</Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {(Object.keys(TIER_LABEL) as TaskTier[]).map((t) => (
          <div key={t} className="rounded-lg border p-4">
            <h4 className="mb-3 font-medium">{TIER_LABEL[t]}任务</h4>
            <div className="space-y-2">
              {config.routes.filter((r) => r.task_tier === t).map((route) => (
                <div key={route.id} className="flex items-center justify-between gap-2 rounded-md bg-muted/50 p-2 text-sm">
                  <div><span className="mr-2 font-mono">{route.fallback_order}.</span>{route.model}<div className="text-xs text-muted-foreground">{config.providers.find((p) => p.id === route.provider_id)?.name ?? "已删除服务"}</div></div>
                  <Button size="sm" variant="ghost" onClick={() => run(() => deleteModelRoute(route.id), "路由已删除")}>移除</Button>
                </div>
              ))}
              {!config.routes.some((r) => r.task_tier === t) && <p className="text-sm text-muted-foreground">尚未配置</p>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function InvokeSection({ run }: { run: (action: () => Promise<unknown>, success: string) => Promise<void> }) {
  const apps = useQuery(appsQuery());
  const [appId, setAppId] = useState("");
  const [tier, setTier] = useState<TaskTier>("standard");
  const [prompt, setPrompt] = useState("请用一句中文回答：模型调用链已连通。");
  const [result, setResult] = useState<LlmInvokeResult | null>(null);
  const app = apps.data?.find((a) => a.id === appId);
  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div><h3 className="font-semibold">调用链验收</h3><p className="text-sm text-muted-foreground">使用所选应用的密级和脱敏设置，实际调用数据库路由中的模型，不生成模拟结果。</p></div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2"><Label>应用</Label><Select value={appId} onValueChange={setAppId}><SelectTrigger><SelectValue placeholder="选择应用" /></SelectTrigger><SelectContent>{apps.data?.map((a) => <SelectItem key={a.id} value={a.id}>{a.name} · {CLASS_LABEL[a.classification]}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-2"><Label>任务档</Label><Select value={tier} onValueChange={(v) => setTier(v as TaskTier)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(TIER_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select></div>
      </div>
      <div className="space-y-2"><Label htmlFor="invoke-prompt">测试提示词</Label><Textarea id="invoke-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} /></div>
      <Button disabled={!appId || !prompt} onClick={async () => {
        setResult(null);
        await run(async () => {
          const value = await invokeModel({ app_id: appId, task_tier: tier, messages: [{ role: "user", content: prompt }] });
          setResult(value);
        }, "模型调用成功");
      }}>执行真实调用</Button>
      {app?.redact_before_llm && <p className="text-xs text-muted-foreground">此应用已开启发送前脱敏。</p>}
      {result && <div className="space-y-2 rounded-md bg-muted/50 p-3"><div className="text-xs text-muted-foreground">{result.provider_name} / {result.model} · 第 {result.attempt} 次 · {result.usage.total_tokens} Token</div><p className="whitespace-pre-wrap text-sm">{result.content}</p></div>}
    </section>
  );
}
