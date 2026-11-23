import { createSecretKey } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

function secret() {
  const value = process.env["SDF_JWT_SECRET"];
  if (!value) throw new Error("缺少环境变量 SDF_JWT_SECRET");
  // 用 KeyObject，避免测试页面环境和 Node 各有一份 Uint8Array 时 jose 拒绝签名
  return createSecretKey(Buffer.from(value, "utf8"));
}

export async function signAccessToken(user: { id: string; email: string }): Promise<string> {
  return await new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(secret());
}

export async function verifyAccessToken(token: string): Promise<{ userId: string; email: string | null } | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    if (!payload.sub) return null;
    const email = payload["email"];
    return { userId: payload.sub, email: typeof email === "string" ? email : null };
  } catch {
    return null;
  }
}
