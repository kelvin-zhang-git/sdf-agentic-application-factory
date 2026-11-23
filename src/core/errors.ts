// Unified error model (spec §12.2). Pure TS, no runtime deps.
export type ErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "BOOTSTRAP_CLOSED"
  | "BOOTSTRAP_TOKEN_INVALID"
  | "BOOTSTRAP_NOT_CONFIGURED"
  | "SECRET_KEY_INVALID"
  | "SECRET_DECRYPT_FAILED"
  | "LLM_NOT_CONFIGURED"
  | "LLM_SENSITIVE_FORBIDDEN"
  | "LLM_UNAVAILABLE"
  | "LLM_HTTP"
  | "LLM_TIMEOUT"
  | "LLM_RESPONSE_INVALID"
  | "LLM_BAD_FORMAT"
  | "BLOCKERS_OPEN"
  | "LEASE_LOST"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "DB_ERROR"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  AUTH_REQUIRED: 401,
  AUTH_INVALID: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  BOOTSTRAP_CLOSED: 410,
  BOOTSTRAP_TOKEN_INVALID: 403,
  BOOTSTRAP_NOT_CONFIGURED: 503,
  SECRET_KEY_INVALID: 503,
  SECRET_DECRYPT_FAILED: 500,
  LLM_NOT_CONFIGURED: 503,
  LLM_SENSITIVE_FORBIDDEN: 400,
  LLM_UNAVAILABLE: 502,
  LLM_HTTP: 502,
  LLM_TIMEOUT: 504,
  LLM_RESPONSE_INVALID: 502,
  LLM_BAD_FORMAT: 502,
  BLOCKERS_OPEN: 409,
  LEASE_LOST: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  TIMEOUT: 504,
  DB_ERROR: 500,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

/** Error number shown to users: E-<yyyymmdd>-<6 hex>, also stored with trace logs. */
export function newErrorId(now = new Date()): string {
  const d = now.toISOString().slice(0, 10).replace(/-/g, "");
  const r = new Uint8Array(3);
  crypto.getRandomValues(r);
  return `E-${d}-${Array.from(r, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; error_id: string; trace_id: string; details?: unknown };
}
