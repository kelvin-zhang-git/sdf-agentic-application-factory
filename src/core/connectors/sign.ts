import { createHmac, timingSafeEqual } from "node:crypto";

export function signHex(secret: string, raw: string): string {
  return createHmac("sha256", secret).update(raw).digest("hex");
}

export function verifyHexSignature(secret: string, raw: string, header: string | undefined): boolean {
  if (!header) return false;
  const given = header.trim().replace(/^sha256=/i, "");
  const expected = signHex(secret, raw);
  const left = Buffer.from(given);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyConstantToken(secret: string, header: string | undefined): boolean {
  if (!header) return false;
  const left = Buffer.from(header);
  const right = Buffer.from(secret);
  return left.length === right.length && timingSafeEqual(left, right);
}
