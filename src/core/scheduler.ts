import { AppError } from "./errors";
import { timingSafeEqualStr } from "./crypto-util";
const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer),(b) => b.toString(16).padStart(2,"0")).join("");
export async function cronSignature(secret: string, timestamp: string, nonce: string, raw: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const digest = hex(await crypto.subtle.digest("SHA-256",Uint8Array.from(raw)));
  return hex(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${timestamp}\n${nonce}\n${digest}`)));
}
export async function verifyCron(input: { raw: Uint8Array; timestamp: string; nonce: string; signature: string; secret: string; now: number; claim: (nonce: string) => Promise<boolean>; execute: () => Promise<void> }) {
  if (input.raw.byteLength > 4096) throw new AppError("PAYLOAD_TOO_LARGE","定时请求内容过大");
  if (!/^(0|[1-9]\d{0,11})$/.test(input.timestamp) || Math.abs(input.now - Number(input.timestamp)) > 300) throw new AppError("FORBIDDEN","定时请求已过期或时间戳不正确");
  if (!/^[0-9a-f]{32}$/.test(input.nonce) || !/^[0-9a-f]{64}$/.test(input.signature) || !timingSafeEqualStr(input.signature,await cronSignature(input.secret,input.timestamp,input.nonce,input.raw))) throw new AppError("FORBIDDEN","定时请求签名不正确");
  if (!(await input.claim(input.nonce))) throw new AppError("CONFLICT","定时请求重复");
  await input.execute();
}