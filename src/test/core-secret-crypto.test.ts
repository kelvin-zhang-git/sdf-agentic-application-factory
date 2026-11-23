import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/core/secret-crypto";

const key = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));
const otherKey = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 2)));
const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("AES-GCM secret envelopes", () => {
  it("round-trips a credential and binds the storage format to the key fingerprint", async () => {
    const encrypted = await encryptSecret("test-api-key-1234", key, id, "llm_provider");
    expect(encrypted.ciphertext).toMatch(/^v1:[0-9a-f]{16}:[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]+={0,2}$/);
    expect(encrypted.last4).toBe("1234");
    expect(encrypted.ciphertext).not.toContain("test-api-key");
    await expect(decryptSecret(encrypted.ciphertext, key, id, "llm_provider")).resolves.toBe("test-api-key-1234");
  });

  it("uses a fresh random IV for each encryption", async () => {
    const a = await encryptSecret("same-key", key, id, "llm_provider");
    const b = await encryptSecret("same-key", key, id, "llm_provider");
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("rejects a different key and a different secret id through AAD", async () => {
    const encrypted = await encryptSecret("same-key", key, id, "llm_provider");
    await expect(decryptSecret(encrypted.ciphertext, otherKey, id, "llm_provider")).rejects.toMatchObject({ code: "SECRET_DECRYPT_FAILED" });
    await expect(decryptSecret(encrypted.ciphertext, key, "7c9e6679-7425-40de-944b-e07fc1f90ae7", "llm_provider")).rejects.toMatchObject({ code: "SECRET_DECRYPT_FAILED" });
  });

  it("requires exactly 32 bytes in canonical Base64", async () => {
    await expect(encryptSecret("same-key", "not-base64", id, "llm_provider")).rejects.toMatchObject({ code: "SECRET_KEY_INVALID" });
    const shortKey = btoa("too-short");
    await expect(encryptSecret("same-key", shortKey, id, "llm_provider")).rejects.toMatchObject({ code: "SECRET_KEY_INVALID" });
  });
});
