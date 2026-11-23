import type { SystemOps, AuthVerifier, Env } from "@/core/ports";
import type { EngineStore } from "@/core/engine/types";
import type { UserDb } from "@/adapters/pg-query";
import type { EngineCommands } from "@/adapters/engine-store";

export interface Deps {
  sys: SystemOps;
  auth: AuthVerifier;
  env: Env;
  userDb: (token: string) => UserDb;
  engine: EngineStore;
  commands: EngineCommands;
  /** Continue engine work after the response (waitUntil on Workers). */
  kick: (origin: string, runId?: string | null) => string | void;
  /** Managed scheduler bearer check; returns a Response on failure. */
  managedCronAuth: (request: Request) => Promise<Response | null>;
  pdfText: (bytes: Uint8Array) => Promise<string>;
}
export type Vars = {
  traceId: string;
  userId: string;
  email: string | null;
  db: UserDb;
  deps: Deps;
};
export type AppEnv = { Variables: Vars };
