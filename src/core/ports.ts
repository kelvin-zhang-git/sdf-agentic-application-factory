// Interfaces the business core depends on. Runtime adapters implement these.
export interface AuditEntry {
  trace_id?: string | undefined;
  actor_id: string | null;
  app_id?: string | null | undefined;
  action: string;
  target_type?: string | undefined;
  target_id?: string | undefined;
  detail?: Record<string, unknown> | undefined;
}

export interface StoredSecret {
  id: string;
  kind: "llm_provider" | "connector_token" | "webhook_secret";
  ciphertext: string;
  last4: string;
  created_by?: string | null;
}
export interface SecretMetadata { id: string; last4: string; updated_at: string }
export interface LlmCallEntry {
  trace_id: string;
  actor_id: string;
  app_id?: string | null;
  provider_id: string;
  task_tier: "fast" | "standard" | "deep";
  model: string;
  status: "success" | "error";
  duration_ms: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  attempt: number;
  redacted?: boolean;
  error_code?: string;
  error_message?: string;
  step_run_id?: string;
}

/** Privileged system operations. Never a generic query surface. */
export interface ServerLogEntry {
  actor_id: string | null; trace_id: string; error_id?: string; level: "info" | "error";
  code: string; path: string; method: string; status: number; duration_ms: number;
  detail?: Record<string, unknown>;
}
export interface ClientErrorEntry {
  actor_id: string; trace_id: string; error_id: string; code: string; path: string;
  detail?: Record<string, unknown>;
}
export interface SystemOps {
  claimCronNonce(nonce: string): Promise<boolean>;
  cleanupLogs(): Promise<void>;
  writeServerLog(entry: ServerLogEntry): Promise<void>;
  writeClientError(entry: ClientErrorEntry): Promise<void>;
  bootstrapAdmin(userId: string): Promise<boolean>;
  isBootstrapped(): Promise<boolean>;
  writeAudit(entry: AuditEntry): Promise<void>;
  createSecret(record: StoredSecret): Promise<void>;
  updateSecret(record: StoredSecret): Promise<void>;
  readSecret(id: string): Promise<StoredSecret | null>;
  secretMetadata(ids: string[]): Promise<SecretMetadata[]>;
  deleteSecret(id: string): Promise<void>;
  writeLlmCall(entry: LlmCallEntry): Promise<void>;
  /** 服务端分配资料编号。普通连接没有 next_code 的执行权限。 */
  nextCode(appId: string, kind: string): Promise<string>;
}

export interface AuthVerifier {
  verify(token: string): Promise<{ userId: string; email: string | null } | null>;
}

export interface Env {
  get(name: string): string | undefined;
}
