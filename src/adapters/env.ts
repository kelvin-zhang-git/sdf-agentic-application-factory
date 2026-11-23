import type { Env } from "@/core/ports";
// Read per request (Workers inject env per request).
export const processEnv: Env = { get: (n) => (typeof process !== "undefined" ? process.env[n] : undefined) };
