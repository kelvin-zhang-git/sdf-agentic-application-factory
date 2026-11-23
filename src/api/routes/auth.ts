import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "@/core/errors";
import { parseJson } from "../validate";
import type { AppEnv } from "../context";
import { checkPassword, hashPassword } from "@/adapters/pg-system";
import { signAccessToken } from "@/adapters/jwt";
import { accountExpired } from "@/core/oem-pack";

export const authRoutes = new Hono<AppEnv>();
const creds = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(8).max(200),
  display_name: z.string().trim().max(50).optional(),
});

authRoutes.post("/signup", async (c) => {
  const input = await parseJson(c.req, creds);
  const email = input.email.toLowerCase();
  const inserted = await insertUser(email, await hashPassword(input.password), input.display_name || email.split("@")[0] || "用户");
  const token = await signAccessToken({ id: inserted.id, email });
  await c.get("deps").sys.writeAudit({ trace_id: c.get("traceId"), actor_id: inserted.id, action: "auth.signup", target_type: "user", target_id: inserted.id });
  return c.json({ access_token: token, needsConfirm: false }, 201);
});

authRoutes.post("/login", async (c) => {
  const input = await parseJson(c.req, creds.pick({ email: true, password: true }));
  const email = input.email.toLowerCase();
  const user = await findUser(email);
  const passwordOk = !!user && await checkPassword(input.password, user.password_hash);
  if (!user || !passwordOk) throw new AppError("AUTH_INVALID", "邮箱或密码不正确");
  if (user.disabled || accountExpired(user.expires_at)) {
    if (accountExpired(user.expires_at)) await disableUser(user.id);
    throw new AppError("AUTH_INVALID", "账号已停用或已到期");
  }
  await touchSignIn(user.id);
  const token = await signAccessToken({ id: user.id, email: user.email });
  await c.get("deps").sys.writeAudit({ trace_id: c.get("traceId"), actor_id: user.id, action: "auth.login", target_type: "user", target_id: user.id });
  return c.json({ access_token: token });
});

interface AuthUser { id: string; email: string; password_hash: string; disabled: boolean; expires_at: string | null }

function jsonbLiteral(value: unknown): string {
  // postgres.js 会把看起来像 JSON 的字符串当成 json，再 ::jsonb 会存成字符串而不是对象
  const tag = `js${crypto.randomUUID().replace(/-/g, "")}`;
  return `$${tag}$${JSON.stringify(value)}$${tag}$::jsonb`;
}

async function insertUser(email: string, passwordHash: string, displayName: string): Promise<{ id: string }> {
  const { serviceQuery } = await import("@/adapters/pg-client");
  try {
    const rows = await serviceQuery()(
      `INSERT INTO auth.users (email, password_hash, raw_user_meta_data)
       VALUES ($1, $2, ${jsonbLiteral({ display_name: displayName })}) RETURNING id`,
      [email, passwordHash],
    );
    const id = String(rows[0]?.["id"] ?? "");
    if (!id) throw new AppError("DB_ERROR", "注册失败");
    return { id };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "23505") throw new AppError("CONFLICT", "该邮箱已注册");
    throw error instanceof AppError ? error : new AppError("DB_ERROR", "注册失败");
  }
}

async function findUser(email: string): Promise<AuthUser | null> {
  const { serviceQuery } = await import("@/adapters/pg-client");
  const query = serviceQuery();
  let rows: Record<string, unknown>[];
  try {
    rows = await query(
      `SELECT u.id, u.email, u.password_hash, u.disabled, p.expires_at
       FROM auth.users u LEFT JOIN public.profiles p ON p.id = u.id WHERE u.email = $1`,
      [email],
    );
  } catch (error) {
    if ((error as { code?: string }).code !== "42703") throw error;
    rows = await query("SELECT id, email, password_hash, disabled FROM auth.users WHERE email = $1", [email]);
  }
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row["id"]), email: String(row["email"]), password_hash: String(row["password_hash"]),
    disabled: row["disabled"] === true, expires_at: row["expires_at"] ? String(row["expires_at"]) : null,
  };
}

async function disableUser(id: string): Promise<void> {
  const { serviceQuery } = await import("@/adapters/pg-client");
  await serviceQuery()("UPDATE auth.users SET disabled = true WHERE id = $1 AND disabled = false", [id]);
}

async function touchSignIn(id: string): Promise<void> {
  const { serviceQuery } = await import("@/adapters/pg-client");
  await serviceQuery()("UPDATE auth.users SET last_sign_in_at = now() WHERE id = $1", [id]);
}
