import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { createSecretsCrypto, parseMasterKey } from "./secret-crypto.js";

describe("SecretsCrypto", () => {
  const masterKey = randomBytes(32);
  const crypto = createSecretsCrypto(masterKey);

  it("encrypts and decrypts round-trip", () => {
    const plaintext = "sk-abc123-secret-value";
    const encResult = crypto.encrypt(plaintext);
    expect(encResult.ok).toBe(true);
    if (!encResult.ok) return;

    const decResult = crypto.decrypt(encResult.value);
    expect(decResult.ok).toBe(true);
    if (!decResult.ok) return;
    expect(decResult.value).toBe(plaintext);
  });

  it("handles empty string", () => {
    const encResult = crypto.encrypt("");
    expect(encResult.ok).toBe(true);
    if (!encResult.ok) return;

    const decResult = crypto.decrypt(encResult.value);
    expect(decResult.ok).toBe(true);
    if (!decResult.ok) return;
    expect(decResult.value).toBe("");
  });

  it("handles unicode content", () => {
    const plaintext = "Hello World! Emoji test: \u{1F680}\u{1F30D}\u{2764}\uFE0F CJK: \u4F60\u597D\u4E16\u754C \u3053\u3093\u306B\u3061\u306F";
    const encResult = crypto.encrypt(plaintext);
    expect(encResult.ok).toBe(true);
    if (!encResult.ok) return;

    const decResult = crypto.decrypt(encResult.value);
    expect(decResult.ok).toBe(true);
    if (!decResult.ok) return;
    expect(decResult.value).toBe(plaintext);
  });

  it("produces different ciphertexts for same plaintext (random nonce)", () => {
    const encResult1 = crypto.encrypt("same-value");
    const encResult2 = crypto.encrypt("same-value");
    expect(encResult1.ok && encResult2.ok).toBe(true);
    if (!encResult1.ok || !encResult2.ok) return;

    expect(encResult1.value.iv).not.toEqual(encResult2.value.iv);
    expect(encResult1.value.ciphertext).not.toEqual(encResult2.value.ciphertext);
  });

  it("returns err() with wrong master key", () => {
    const wrongCrypto = createSecretsCrypto(randomBytes(32));
    const encResult = crypto.encrypt("secret");
    expect(encResult.ok).toBe(true);
    if (!encResult.ok) return;

    const decResult = wrongCrypto.decrypt(encResult.value);
    expect(decResult.ok).toBe(false);
  });

  it("returns err() with corrupted auth tag", () => {
    const encResult = crypto.encrypt("secret");
    expect(encResult.ok).toBe(true);
    if (!encResult.ok) return;

    // Corrupt the auth tag by flipping a byte
    const corrupted = { ...encResult.value };
    const corruptedTag = Buffer.from(corrupted.authTag);
    corruptedTag[0] = corruptedTag[0]! ^ 0xff;
    corrupted.authTag = corruptedTag;

    const decResult = crypto.decrypt(corrupted);
    expect(decResult.ok).toBe(false);
  });

  it("throws on master key shorter than 32 bytes", () => {
    expect(() => createSecretsCrypto(randomBytes(16))).toThrow(
      "Master key must be at least 32 bytes",
    );
  });

  it("defensive copy: caller buffer mutation does not affect encryption", () => {
    const mutableKey = Buffer.alloc(32, 0xaa);
    const cryptoEngine = createSecretsCrypto(mutableKey);

    // Encrypt with original key
    const encResult = cryptoEngine.encrypt("test-value");
    expect(encResult.ok).toBe(true);
    if (!encResult.ok) return;

    // Mutate the caller's buffer after creation
    mutableKey.fill(0x00);

    // Decryption should still work (engine has its own copy)
    const decResult = cryptoEngine.decrypt(encResult.value);
    expect(decResult.ok).toBe(true);
    if (!decResult.ok) return;
    expect(decResult.value).toBe("test-value");
  });
});

describe("parseMasterKey", () => {
  it("parses hex string", () => {
    const original = randomBytes(32);
    const hex = original.toString("hex");
    const parsed = parseMasterKey(hex);
    expect(parsed).toEqual(original);
    expect(parsed.length).toBe(32);
  });

  it("parses base64 string", () => {
    const original = randomBytes(32);
    const b64 = original.toString("base64");
    const parsed = parseMasterKey(b64);
    expect(parsed).toEqual(original);
    expect(parsed.length).toBe(32);
  });

  it("rejects short key", () => {
    const short = randomBytes(16).toString("hex"); // 32 hex chars = 16 bytes
    expect(() => parseMasterKey(short)).toThrow(
      "Master key must be at least 32 bytes",
    );
  });
});
