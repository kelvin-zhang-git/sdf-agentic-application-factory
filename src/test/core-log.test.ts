import { describe, expect, it, vi } from "vitest";
import { safeLog, diagnosticBundle } from "@/core/log";
describe("bounded diagnostic logging", () => {
  it("writes once and falls back once without recursion on failure", async () => {
    const write = vi.fn(async () => { throw new Error("private provider exception"); }); const fallback = vi.fn();
    await safeLog(write,fallback); expect(write).toHaveBeenCalledTimes(1); expect(fallback).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fallback.mock.calls)).not.toContain("private provider exception");
  });
  it("times out without waiting forever", async () => {
    const fallback = vi.fn(); await safeLog(() => new Promise(() => {}),fallback,5); expect(fallback).toHaveBeenCalledTimes(1);
  });
  it("removes credentials and ciphertext from diagnostics while retaining counts", () => {
    const result = diagnosticBundle({ authorization:"Bearer test",token_count:45 },[{api_key:"test-private", ciphertext:"v1:0123456789abcdef:AAAAAAAAAAAAAAAA:Zm9vYmFy"}],[],[]);
    expect(JSON.stringify(result)).not.toContain("test-private"); expect(JSON.stringify(result)).not.toContain("v1:0123456789abcdef");
    expect(result.meta).toEqual({authorization:"[已脱敏]",token_count:45});
  });
});