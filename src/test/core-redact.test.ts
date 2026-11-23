import { describe, expect, it } from "vitest";
import { redact, REDACTED } from "@/core/redact";
import { timingSafeEqualStr } from "@/core/crypto-util";

describe("redact", () => {
  it("removes exact sensitive keys case-insensitively", () => {
    const r = redact({ Authorization: "Bearer abc", password: "p", "X-SDF-Bootstrap-Token": "t" });
    expect(r).toEqual({ Authorization: REDACTED, password: REDACTED, "X-SDF-Bootstrap-Token": REDACTED });
  });
  it("keeps ordinary fields like token_count and key_id", () => {
    expect(redact({ token_count: 12, key_id: "abcd" })).toEqual({ token_count: 12, key_id: "abcd" });
  });
  it("masks JWT and sk- keys inside strings", () => {
    expect(redact("x eyJhbGciOi.eyJzdWIiOjF9.sig y")).toBe(`x ${REDACTED} y`);
    expect(redact("key sk-ABCDEFGHIJKLMNOPQRST")).toBe(`key ${REDACTED}`);
  });
  it("masks stored ciphertext format", () => {
    expect(redact("v1:0123456789abcdef:AAAAAAAAAAAAAAAA:Zm9vYmFy")).toBe(REDACTED);
  });
});

describe("timingSafeEqualStr", () => {
  it("compares exactly", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
  });
});
