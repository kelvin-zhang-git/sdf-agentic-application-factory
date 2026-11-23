import type { MiddlewareHandler, ErrorHandler } from "hono";
import { AppError, newErrorId, type ErrorBody } from "@/core/errors";
import { newTraceId } from "@/core/crypto-util";
import { userFromApiToken } from "@/adapters/api-tokens";
import type { AppEnv, Deps } from "./context";

const TRACE_RE = /^[A-Za-z0-9_-]{6,64}$/;

export const traceMw = (deps: Deps): MiddlewareHandler<AppEnv> => async (c, next) => {
  const incoming = c.req.header("x-trace-id");
  const traceId = incoming && TRACE_RE.test(incoming) ? incoming : newTraceId();
  c.set("traceId", traceId);
  c.set("deps", deps);
  const started = Date.now();
  await next();
  c.header("X-Trace-Id", traceId);
  if (c.get("userId") && c.res.status < 400 && c.req.path !== "/api/client-errors") {
    // 非阻塞落库，避免每次成功请求额外等待数据库写 RTT
    void deps.sys.writeServerLog({ actor_id: c.get("userId") ?? null, trace_id: traceId, level: "info", code: "REQUEST_OK", path: c.req.path, method: c.req.method, status: c.res.status, duration_ms: Date.now() - started }).catch(() => undefined);
  }
};

export const bodyLimitMw = (maxBytes: number): MiddlewareHandler<AppEnv> => async (c, next) => {
  const len = Number(c.req.header("content-length") ?? "0");
  if (len > maxBytes) throw new AppError("PAYLOAD_TOO_LARGE", `请求内容过大（上限 ${Math.round(maxBytes / 1024)} KB）`);
  await next();
};

export const authMw: MiddlewareHandler<AppEnv> = async (c, next) => {
  const h = c.req.header("authorization");
  const queryToken = c.req.path.endsWith("/events") ? c.req.query("token") : undefined;
  const token = h?.startsWith("Bearer ") ? h.slice(7).trim() : queryToken?.trim();
  if (!token) throw new AppError("AUTH_REQUIRED", "请先登录");
  const deps = c.get("deps");
  const user = token.startsWith("sdf_pat_") ? await userFromApiToken(token) : await deps.auth.verify(token);
  if (!user) throw new AppError("AUTH_INVALID", "登录已过期，请重新登录");
  c.set("userId", user.userId);
  c.set("email", user.email);
  c.set("db", deps.userDb(user.userId));
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { data, error } = await c.get("db").rpc("is_admin");
  if (error) throw new AppError("DB_ERROR", "权限检查失败", { db: error.message });
  if (data !== true) throw new AppError("FORBIDDEN", "仅管理员可访问");
  await next();
};

export const onError: ErrorHandler<AppEnv> = async (err, c) => {
  const traceId = c.get("traceId") ?? newTraceId();
  const errorId = newErrorId();
  const e = err instanceof AppError ? err : new AppError("INTERNAL", "服务器内部错误，请凭错误编号联系管理员");
  // No request bodies, exception text or headers: arbitrary credentials cannot enter logs.
  if (c.get("userId")) await c.get("deps").sys.writeServerLog({ actor_id: c.get("userId"), trace_id: traceId, error_id: errorId, level: "error", code: e.code, path: c.req.path, method: c.req.method, status: e.status, duration_ms: 0 });
  const body: ErrorBody = {
    error: { code: e.code, message: e.message, error_id: errorId, trace_id: traceId,
      details: e.status < 500 ? e.details : undefined },
  };
  c.header("X-Trace-Id", traceId);
  return c.json(body, e.status as 400);
};

export function dbFail(error: { message: string; code?: string } | null, msg = "数据库操作失败"): void {
  if (!error) return;
  if (error.code === "42501") throw new AppError("FORBIDDEN", "没有权限执行此操作");
  if (error.code === "23505") throw new AppError("CONFLICT", "记录已存在");
  throw new AppError("DB_ERROR", msg, { db: error.message, db_code: error.code });
}
