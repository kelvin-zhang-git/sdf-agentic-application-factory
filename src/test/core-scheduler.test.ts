import { describe,it,expect,vi } from "vitest";
import { cronSignature,verifyCron } from "@/core/scheduler";
describe("cron verification order", () => {
  const raw = new TextEncoder().encode("{}"); const secret = "unit-test-only"; const nonce = "0".repeat(32); const timestamp = "1000";
  it("checks raw bytes and executes only after nonce claim",async () => {
    const signature = await cronSignature(secret,timestamp,nonce,raw); const calls: string[]=[];
    await verifyCron({raw,secret,nonce,timestamp,signature,now:1000,claim:async () => {calls.push("nonce");return true;},execute:async () => {calls.push("execute");}});
    expect(calls).toEqual(["nonce","execute"]);
  });
  it("rejects more than 4096 bytes before nonce or execution",async () => {
    const claim=vi.fn(); const execute=vi.fn(); await expect(verifyCron({raw:new Uint8Array(4097),secret,nonce,timestamp,signature:"",now:1000,claim,execute})).rejects.toMatchObject({code:"PAYLOAD_TOO_LARGE"}); expect(claim).not.toHaveBeenCalled();expect(execute).not.toHaveBeenCalled();
  });
  it("rejects timestamps outside 300 seconds",async () => {
    const claim=vi.fn(); await expect(verifyCron({raw,secret,nonce,timestamp,signature:"",now:1301,claim,execute:vi.fn()})).rejects.toMatchObject({code:"FORBIDDEN"}); expect(claim).not.toHaveBeenCalled();
  });
  it("rejects signatures over different raw bytes",async () => {
    const signature=await cronSignature(secret,timestamp,nonce,raw);const claim=vi.fn();await expect(verifyCron({raw:new TextEncoder().encode("{ }"),secret,nonce,timestamp,signature,now:1000,claim,execute:vi.fn()})).rejects.toMatchObject({code:"FORBIDDEN"});expect(claim).not.toHaveBeenCalled();
  });
  it("rejects replay before execution",async () => {
    const signature=await cronSignature(secret,timestamp,nonce,raw);const execute=vi.fn();await expect(verifyCron({raw,secret,nonce,timestamp,signature,now:1000,claim:async () => false,execute})).rejects.toMatchObject({code:"CONFLICT"});expect(execute).not.toHaveBeenCalled();
  });
});