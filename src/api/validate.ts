import type { z } from "zod";
import { AppError } from "@/core/errors";
export async function parseJson<T extends z.ZodTypeAny>(req: { json(): Promise<unknown> }, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new AppError("VALIDATION", "请求内容不是有效的 JSON"); }
  const r = schema.safeParse(raw);
  if (!r.success) throw new AppError("VALIDATION", "填写的内容不符合要求", r.error.flatten());
  return r.data;
}
export function parseUuid(v: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(v)) throw new AppError("VALIDATION", "编号格式不正确");
  return v;
}
