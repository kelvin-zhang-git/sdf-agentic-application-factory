import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { serviceQuery } from "./pg-client";

export async function issueApiToken(userId: string, name: string): Promise<{ id: string; token: string; prefix: string }> {
  const token = `sdf_pat_${randomBytes(24).toString("hex")}`;
  const prefix = token.slice(0, 16);
  const hash = await bcrypt.hash(token, 12);
  const rows = await serviceQuery()(
    `INSERT INTO public.api_tokens(user_id, name, token_prefix, token_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [userId, name, prefix, hash],
  );
  const id = String(rows[0]?.["id"] ?? "");
  return { id, token, prefix };
}

export async function listApiTokens(userId: string): Promise<Record<string, unknown>[]> {
  return serviceQuery()(
    `SELECT id, name, token_prefix, created_at, last_used_at, revoked_at
     FROM public.api_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
}

export async function revokeApiToken(userId: string, id: string): Promise<boolean> {
  const rows = await serviceQuery()(
    `UPDATE public.api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
    [id, userId],
  );
  return rows.length > 0;
}

export async function userFromApiToken(token: string): Promise<{ userId: string; email: string | null } | null> {
  if (!token.startsWith("sdf_pat_") || token.length < 24) return null;
  let rows: Record<string, unknown>[];
  try {
    rows = await serviceQuery()(
      `SELECT t.id, t.token_hash, t.user_id, u.email
       FROM public.api_tokens t
       JOIN auth.users u ON u.id = t.user_id
       LEFT JOIN public.profiles p ON p.id = u.id
       WHERE t.token_prefix = $1 AND t.revoked_at IS NULL AND u.disabled = false
         AND (p.expires_at IS NULL OR p.expires_at > now())`,
      [token.slice(0, 16)],
    );
  } catch (error) {
    if ((error as { code?: string }).code !== "42703") throw error;
    rows = await serviceQuery()(
      `SELECT t.id, t.token_hash, t.user_id, u.email
       FROM public.api_tokens t JOIN auth.users u ON u.id = t.user_id
       WHERE t.token_prefix = $1 AND t.revoked_at IS NULL AND u.disabled = false`,
      [token.slice(0, 16)],
    );
  }
  for (const row of rows) {
    if (await bcrypt.compare(token, String(row["token_hash"]))) {
      await serviceQuery()(`UPDATE public.api_tokens SET last_used_at = now() WHERE id = $1`, [row["id"]]);
      return { userId: String(row["user_id"]), email: row["email"] ? String(row["email"]) : null };
    }
  }
  return null;
}
