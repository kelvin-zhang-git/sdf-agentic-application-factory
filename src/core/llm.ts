// OpenAI-compatible model selection and HTTP calls. No vendor SDK or runtime imports.
import { AppError } from "./errors";

export type TaskTier = "fast" | "standard" | "deep";
export type Classification = "public" | "internal" | "sensitive" | "confidential";
export interface LlmProvider {
  id: string;
  name: string;
  base_url: string;
  models: string[];
  secret_id: string;
  allowed_for_sensitive: boolean;
  enabled: boolean;
  priority: number;
}
export interface ModelRoute {
  id: string;
  task_tier: TaskTier;
  provider_id: string;
  model: string;
  fallback_order: number;
}
export interface LlmMessage { role: "system" | "user" | "assistant"; content: string }
export interface LlmUsage { prompt_tokens: number; completion_tokens: number; total_tokens: number }
export interface ChatResult { content: string; usage: LlmUsage }

export function normalizeProviderBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new AppError("VALIDATION", "模型服务地址不是有效的 URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new AppError("VALIDATION", "模型服务地址只支持 HTTP 或 HTTPS");
  if (url.username || url.password) throw new AppError("VALIDATION", "模型服务地址不能包含账号或密码");
  if (url.search || url.hash) throw new AppError("VALIDATION", "模型服务地址不能包含查询参数或锚点");
  if (/\/(chat\/completions|models)\/?$/.test(url.pathname)) throw new AppError("VALIDATION", "请填写接口根地址，不要包含 /chat/completions 或 /models");
  return value.trim().replace(/\/+$/, "");
}

export function selectModelCandidates(
  tier: TaskTier,
  classification: Classification,
  providers: LlmProvider[],
  routes: ModelRoute[],
): { provider: LlmProvider; route: ModelRoute }[] {
  const tierRoutes = routes.filter((r) => r.task_tier === tier);
  if (!tierRoutes.length) throw new AppError("LLM_NOT_CONFIGURED", "该任务档尚未配置模型，请先在管理 → 模型中设置");
  const byId = new Map(providers.map((p) => [p.id, p]));
  const enabled = tierRoutes.flatMap((route) => {
    const provider = byId.get(route.provider_id);
    return provider?.enabled ? [{ provider, route }] : [];
  });
  if (!enabled.length) throw new AppError("LLM_NOT_CONFIGURED", "该任务档没有已启用的模型服务");
  const restricted = classification === "sensitive" || classification === "confidential";
  const eligible = restricted ? enabled.filter((x) => x.provider.allowed_for_sensitive) : enabled;
  if (!eligible.length) throw new AppError("LLM_SENSITIVE_FORBIDDEN", "敏感或机密应用没有可用的已授权模型，已拒绝调用");
  return eligible.sort((a, b) => a.route.fallback_order - b.route.fallback_order || a.provider.priority - b.provider.priority);
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 17 位标准车辆识别代号（不含 I/O/Q），且要求同时包含字母与数字，避免误伤纯英文词或纯数字编号。
const VIN_PATTERN = /\b(?=[A-HJ-NPR-Z0-9]{17}\b)(?=[A-HJ-NPR-Z0-9]*[A-HJ-NPR-Z])(?=[A-HJ-NPR-Z0-9]*\d)[A-HJ-NPR-Z0-9]{17}\b/g;
// 常见企业内网 IPv4（10.0.0.0/8、172.16.0.0/12、192.168.0.0/16）
const PRIVATE_IP_PATTERN = /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g;

export function redactPii(text: string, customTerms?: readonly string[]): string {
  let out = text
    .replace(/(?<![0-9Xx])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?![0-9Xx])/g, "[身份证号已脱敏]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[邮箱已脱敏]")
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[手机号已脱敏]")
    .replace(/(?<!\d)\d{16,19}(?!\d)/g, "[银行卡号已脱敏]")
    .replace(VIN_PATTERN, "[VIN已脱敏]")
    .replace(PRIVATE_IP_PATTERN, "[内网IP已脱敏]");

  if (customTerms?.length) {
    // 按长度降序替换，避免短词抢先破坏长词匹配；忽略少于 2 个字符的词避免误伤正文。
    const terms = Array.from(new Set(customTerms.map((t) => t.trim()).filter((t) => t.length >= 2)))
      .sort((a, b) => b.length - a.length);
    for (const term of terms) {
      out = out.replace(new RegExp(escapeRegExp(term), "gi"), "[专有词已脱敏]");
    }
  }
  return out;
}

export function redactMessages(messages: LlmMessage[], customTerms?: readonly string[]): LlmMessage[] {
  return messages.map((m) => ({ ...m, content: redactPii(m.content, customTerms) }));
}

function httpError(status: number): AppError {
  if (status === 401 || status === 403) return new AppError("LLM_HTTP", `模型服务拒绝了访问密钥（HTTP ${status}），请重新填写`);
  if (status === 404) return new AppError("LLM_HTTP", "模型接口或模型 ID 不存在（HTTP 404），请检查地址和配置");
  if (status === 429) return new AppError("LLM_HTTP", "模型服务请求过于频繁或额度不足（HTTP 429）", { http_status: 429 });
  return new AppError("LLM_HTTP", `模型服务返回错误（HTTP ${status}），请检查服务配置`, { http_status: status });
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, fetchImpl: typeof fetch): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new AppError("LLM_TIMEOUT", "模型响应超时，请稍后重试");
    throw new AppError("LLM_UNAVAILABLE", "无法连接模型服务，请检查地址和网络");
  } finally {
    clearTimeout(timer);
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export async function callChatCompletion(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: LlmMessage[];
  maxTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<ChatResult> {
  const response = await fetchWithTimeout(`${options.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      max_tokens: options.maxTokens ?? 512,
      temperature: 0,
      stream: false,
    }),
  }, options.timeoutMs ?? 20_000, options.fetchImpl ?? fetch);
  if (!response.ok) throw httpError(response.status);
  const body = await response.json().catch(() => null) as {
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
  } | null;
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new AppError("LLM_RESPONSE_INVALID", "模型返回内容不符合 OpenAI 兼容格式");
  const usage = {
    prompt_tokens: numberOrZero(body?.usage?.prompt_tokens),
    completion_tokens: numberOrZero(body?.usage?.completion_tokens),
    total_tokens: numberOrZero(body?.usage?.total_tokens),
  };
  return { content, usage };
}

export async function listOpenAiModels(options: {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const response = await fetchWithTimeout(`${options.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${options.apiKey}` },
  }, options.timeoutMs ?? 15_000, options.fetchImpl ?? fetch);
  if (!response.ok) throw httpError(response.status);
  const body = await response.json().catch(() => null) as { data?: { id?: unknown }[] } | null;
  if (!Array.isArray(body?.data)) throw new AppError("LLM_RESPONSE_INVALID", "模型列表不符合 OpenAI 兼容格式");
  return Array.from(new Set(body.data.flatMap((x) => typeof x.id === "string" && x.id.trim() ? [x.id.trim()] : []))).sort();
}
