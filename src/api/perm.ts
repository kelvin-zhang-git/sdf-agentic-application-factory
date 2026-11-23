import type { Context } from "hono";
import { AppError } from "@/core/errors";
import { dbFail } from "./middleware";
import type { AppEnv } from "./context";

export interface AppAccess { isAdmin: boolean; roles: string[] }
/** Membership as seen through the caller's own RLS client; non-visible apps are 404. */
export async function appAccess(c: Context<AppEnv>, appId: string): Promise<AppAccess> {
  const db = c.get("db");
  const [app, admin, mine] = await Promise.all([
    db.from("apps").select("id").eq("id", appId).maybeSingle(),
    db.rpc("is_admin"),
    db.from("app_members").select("role").eq("app_id", appId).eq("user_id", c.get("userId")),
  ]);
  dbFail(app.error); dbFail(admin.error); dbFail(mine.error);
  if (!app.data) throw new AppError("NOT_FOUND", "应用不存在或您没有访问权限");
  return { isAdmin: admin.data === true, roles: (mine.data ?? []).map((x) => x.role) };
}
export function requireRole(a: AppAccess, roles: string[], msg = "您在本应用中没有执行此操作的角色") {
  if (!a.isAdmin && !a.roles.some((r) => roles.includes(r))) throw new AppError("FORBIDDEN", msg);
}
/** 只担任业务方的人不能读任务、接口、数据模型和扫描结果。 */
export function rejectBusiness(a: AppAccess) {
  if (!a.isAdmin && a.roles.length > 0 && a.roles.every((role) => role === "business")) throw new AppError("FORBIDDEN", "业务门户不提供这项内容");
}
export const originOf = (c: Context<AppEnv>) => new URL(c.req.url).origin;
