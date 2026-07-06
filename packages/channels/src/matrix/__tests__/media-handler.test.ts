// SPDX-License-Identifier: Apache-2.0
/**
 * Real-crypto proof for the encrypted-attachment codec.
 *
 * The WASM `Attachment` engine (a pinned dependency of this package) is exercised
 * in-process, with no homeserver and no mock: a known payload is encrypted and
 * decrypted back byte-identically, a single flipped ciphertext byte fails closed
 * on the SHA-256 integrity check, and the emitted media-encryption info is the
 * Matrix encrypted-file wire shape minus its `url`. Because the engine loads
 * lazily through the module's own boundary (a dynamic import that runs `initAsync`
 * on first use), these calls are the same code path the shipping media flow takes —
 * so the guarantee that path relies on is the thing under test, not a stand-in.
 *
 * Also covers the bounded encrypted-file cache: insertion-ordered eviction once the
 * bound is exceeded, and a miss returning `undefined`.
 */
import { describe, it, expect } from "vitest";
import {
  encryptAttachment,
  decryptAttachment,
  createEncryptedFileCache,
  parseMediaEncryptionInfo,
  type EncryptedFileLike,
} from "../media-handler.js";

const KNOWN_PAYLOAD = Buffer.from("known attachment bytes");
const SOME_MXC = "mxc://example.org/known-attachment";

// The WASM engine loads on first codec use; give that first call generous headroom.
const CRYPTO_TIMEOUT_MS = 30_000;

describe("encrypted-attachment codec", () => {
  it(
    "round-trips a payload back to byte-identical plaintext",
    async () => {
      const { ciphertext, info } = await encryptAttachment(KNOWN_PAYLOAD);
      const decrypted = await decryptAttachment(ciphertext, { ...info, url: SOME_MXC });
      expect(decrypted.equals(KNOWN_PAYLOAD)).toBe(true);
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "emits media-info in the encrypted-file wire shape minus its url",
    async () => {
      const { info } = await encryptAttachment(KNOWN_PAYLOAD);
      expect("url" in info).toBe(false);
      expect(info.v).toBe("v2");
      expect(typeof info.iv).toBe("string");
      expect(typeof info.hashes.sha256).toBe("string");
      expect(info.key).toMatchObject({ alg: "A256CTR", kty: "oct", ext: true });
      expect(Array.isArray(info.key.key_ops)).toBe(true);
      expect(typeof info.key.k).toBe("string");
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "decrypts through the full event shape by stripping url before the codec",
    async () => {
      const { ciphertext, info } = await encryptAttachment(KNOWN_PAYLOAD);
      // The on-event content.file carries `url`; the codec rejects it, so decrypt
      // must strip it internally rather than requiring callers to pre-trim.
      const eventFile: EncryptedFileLike = { ...info, url: SOME_MXC };
      const decrypted = await decryptAttachment(ciphertext, eventFile);
      expect(decrypted.toString()).toBe("known attachment bytes");
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "fails closed on a tampered ciphertext without returning partial plaintext",
    async () => {
      const { ciphertext, info } = await encryptAttachment(KNOWN_PAYLOAD);
      const tampered = Buffer.from(ciphertext);
      tampered[0] ^= 0xff;
      let result: Buffer | undefined;
      let threw = false;
      try {
        result = await decryptAttachment(tampered, { ...info, url: SOME_MXC });
      } catch (error) {
        threw = true;
        expect((error as Error).message).toMatch(/hash mismatch/i);
      }
      expect(threw).toBe(true);
      // Nothing is returned past the integrity check — no partial plaintext leaks.
      expect(result).toBeUndefined();
    },
    CRYPTO_TIMEOUT_MS,
  );
});

describe("parseMediaEncryptionInfo", () => {
  it("throws a meaningful error when the codec returns no media-encryption info", () => {
    // A defensive guard: JSON.parse(undefined) would otherwise throw an opaque
    // SyntaxError; the operator should see WHY (the codec emitted nothing) instead.
    expect(() => parseMediaEncryptionInfo(undefined)).toThrow(/no media-encryption info/i);
    expect(() => parseMediaEncryptionInfo(null)).toThrow(/no media-encryption info/i);
    expect(() => parseMediaEncryptionInfo("")).toThrow(/no media-encryption info/i);
  });

  it("parses a valid media-encryption info JSON string", () => {
    const raw = JSON.stringify({
      v: "v2",
      iv: "iv",
      hashes: { sha256: "h" },
      key: { alg: "A256CTR", key_ops: ["encrypt"], kty: "oct", k: "k", ext: true },
    });
    const info = parseMediaEncryptionInfo(raw);
    expect(info.v).toBe("v2");
    expect(info.key.alg).toBe("A256CTR");
  });
});

describe("bounded encrypted-file cache", () => {
  const fileFor = (mxc: string): EncryptedFileLike => ({
    url: mxc,
    key: { alg: "A256CTR", key_ops: ["encrypt", "decrypt"], kty: "oct", k: "AAAA", ext: true },
    iv: "AAAAAAAAAAA",
    hashes: { sha256: "AAAA" },
    v: "v2",
  });

  it("returns the stored record on a hit and undefined on a miss", () => {
    const cache = createEncryptedFileCache();
    const file = fileFor("mxc://example.org/a");
    cache.set("mxc://example.org/a", file);
    expect(cache.get("mxc://example.org/a")).toBe(file);
    expect(cache.get("mxc://example.org/missing")).toBeUndefined();
  });

  it("evicts the oldest entry once the bound is exceeded", () => {
    const cache = createEncryptedFileCache(2);
    cache.set("a", fileFor("mxc://example.org/a"));
    cache.set("b", fileFor("mxc://example.org/b"));
    cache.set("c", fileFor("mxc://example.org/c")); // exceeds the bound of 2 → evicts "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
  });
});
