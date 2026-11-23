// Exact-rule redaction (plan §7). Applied before any log/diagnostic write.
const SENSITIVE_KEYS = new Set([
  "authorization", "cookie", "set-cookie", "apikey", "api_key", "x-api-key",
  "access_token", "refresh_token", "password", "secret", "client_secret", "private_key",
  "x-sdf-bootstrap-token", "x-sdf-signature", "x-hub-signature-256", "x-gitlab-token",
]);
const VALUE_PATTERNS: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, // JWT
  /\bBearer\s+\S+/g,
  /\bsk-[A-Za-z0-9]{16,}\b/g,
];
const CIPHERTEXT = /^v1:[0-9a-f]{16}:[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]+={0,2}$/;
export const REDACTED = "[已脱敏]";

export function redactString(s: string): string {
  if (CIPHERTEXT.test(s)) return REDACTED;
  let out = s;
  for (const p of VALUE_PATTERNS) out = out.replace(p, REDACTED);
  return out;
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return REDACTED as unknown as T;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? REDACTED : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
