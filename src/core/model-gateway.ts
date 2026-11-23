// ModelGateway: the only way blocks reach a model. Single implementation: OpenAI-compatible HTTP.
// Provider address, model IDs and keys come from stored configuration; no vendor SDK or names here.
import type { z } from "zod";
import { AppError } from "./errors";
import { callChatCompletion, redactMessages, selectModelCandidates, type Classification, type LlmMessage, type LlmProvider, type LlmUsage, type ModelRoute, type TaskTier } from "./llm";

export interface GatewayResult { content: string; usage: LlmUsage; model: string }
export interface ModelGateway {
  complete(tier: TaskTier, messages: LlmMessage[], maxTokens?: number): Promise<GatewayResult>;
  json<T extends z.ZodTypeAny>(tier: TaskTier, schema: T, messages: LlmMessage[], maxTokens?: number): Promise<{ data: z.infer<T>; usage: LlmUsage; model: string; calls: number }>;
}
export interface GatewayConfig {
  classification: Classification; redact: boolean;
  redactTerms?: readonly string[] | undefined;
  providers: LlmProvider[]; routes: ModelRoute[];
  /** 当前智能体角色的最新系统提示词（来自 agent_prompt_versions），注入在步骤任务契约之前。 */
  rolePrompt?: string | undefined;
  apiKey(provider: LlmProvider): Promise<string>;
  record(e: { provider_id: string; tier: TaskTier; model: string; ok: boolean; ms: number; usage?: LlmUsage; attempt: number; code?: string; message?: string }): Promise<void>;
  fetchImpl?: typeof fetch;
}

/** 将角色级系统提示词与积木步骤级输出契约合并为单条前导 system 消息，避免重试时重复拼接。 */
export function mergeRolePrompt(messages: LlmMessage[], rolePrompt?: string): LlmMessage[] {
  const prefix = rolePrompt?.trim();
  if (!prefix) return messages;
  if (messages[0]?.role === "system") {
    if (messages[0].content.startsWith(prefix)) return messages;
    return [
      { role: "system", content: `${prefix}\n\n---\n【当前步骤任务与输出契约（必须严格遵守）】\n${messages[0].content}` },
      ...messages.slice(1),
    ];
  }
  return [{ role: "system", content: prefix }, ...messages];
}

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error("no json");
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  return JSON.parse(body.slice(start, end + 1));
}

export class OpenAICompatibleGateway implements ModelGateway {
  constructor(private cfg: GatewayConfig) {}
  async complete(tier: TaskTier, messages: LlmMessage[], maxTokens = 2048): Promise<GatewayResult> {
    const candidates = selectModelCandidates(tier, this.cfg.classification, this.cfg.providers, this.cfg.routes);
    const withRole = mergeRolePrompt(messages, this.cfg.rolePrompt);
    const msgs = this.cfg.redact ? redactMessages(withRole, this.cfg.redactTerms) : withRole;
    let last: AppError | null = null; let attempt = 0;
    for (const { provider, route } of candidates) {
      attempt += 1; const t = Date.now();
      try {
        const key = await this.cfg.apiKey(provider);
        const r = await callChatCompletion({ baseUrl: provider.base_url, apiKey: key, model: route.model, messages: msgs, maxTokens, timeoutMs: 120_000, ...(this.cfg.fetchImpl ? { fetchImpl: this.cfg.fetchImpl } : {}) });
        await this.cfg.record({ provider_id: provider.id, tier, model: route.model, ok: true, ms: Date.now() - t, usage: r.usage, attempt });
        return { ...r, model: route.model };
      } catch (e) {
        last = e instanceof AppError ? e : new AppError("LLM_UNAVAILABLE", "模型调用失败");
        await this.cfg.record({ provider_id: provider.id, tier, model: route.model, ok: false, ms: Date.now() - t, attempt, code: last.code, message: last.message });
      }
    }
    throw last ?? new AppError("LLM_UNAVAILABLE", "模型调用失败");
  }
  async json<T extends z.ZodTypeAny>(tier: TaskTier, schema: T, messages: LlmMessage[], maxTokens = 4096) {
    const usage: LlmUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let msgs = [...messages, { role: "system" as const, content: "只输出一个 JSON 对象，不要输出任何解释或 Markdown。" }];
    let model = "";
    for (let i = 0; i < 2; i++) {
      const r = await this.complete(tier, msgs, maxTokens);
      model = r.model; usage.prompt_tokens += r.usage.prompt_tokens; usage.completion_tokens += r.usage.completion_tokens; usage.total_tokens += r.usage.total_tokens;
      let problem: string;
      try {
        const parsed = schema.safeParse(extractJson(r.content));
        if (parsed.success) return { data: parsed.data as z.infer<T>, usage, model, calls: i + 1 };
        problem = parsed.error.issues.slice(0, 5).map((x) => `${x.path.join(".")}: ${x.message}`).join("; ");
      } catch { problem = "不是有效的 JSON"; }
      msgs = [...msgs, { role: "assistant", content: r.content.slice(0, 4000) }, { role: "user", content: `上次输出格式不符合要求：${problem}。请严格按要求重新输出 JSON。` }];
    }
    throw new AppError("LLM_BAD_FORMAT", "模型连续两次返回的格式不符合要求", { model });
  }
}
