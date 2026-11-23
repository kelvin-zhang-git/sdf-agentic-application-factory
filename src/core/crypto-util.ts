/** Constant-time string compare (Web standard only). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function newTraceId(): string {
  const r = new Uint8Array(8);
  crypto.getRandomValues(r);
  return "t-" + Array.from(r, (b) => b.toString(16).padStart(2, "0")).join("");
}
