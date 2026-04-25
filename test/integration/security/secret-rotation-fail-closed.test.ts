// SPDX-License-Identifier: Apache-2.0
/**
 * Secret-store rotation + fail-closed integration test.
 *
 * Exercises the contract that protects users from silent decryption with
 * a wrong master key. The interaction is:
 *
 *   1. createSecretsCrypto(keyA) + createSqliteSecretStore(path, cryptoA)
 *      establishes a canary row encrypted under keyA.
 *   2. set/get round-trip with cryptoA succeeds.
 *   3. Reopening the same DB with cryptoB (different master key) MUST throw
 *      a DECRYPTION_FAILED error from the canary check -- never silently
 *      decrypts garbage.
 *   4. crypto.decrypt() on a payload encrypted by cryptoA, called via
 *      cryptoB, returns Result.err -- never throws.
 *   5. After "rotation" (new DB, new key), the new store has a fresh
 *      canary and the old ciphertext does not migrate automatically;
 *      old plaintext is unrecoverable from the new store, which is the
 *      expected fail-closed behaviour.
 *
 * Uses an on-disk DB in os.tmpdir() because :memory: cannot be re-opened
 * across crypto instances (the canary requires a persistent file).
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createSecretsCrypto } from "@comis/core";
import { createSqliteSecretStore } from "@comis/memory";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempPath(label: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), `comis-secret-rotation-${label}-`));
  const file = join(dir, "secrets.db");
  return { dir, file };
}

function safeRm(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Secret store -- baseline encrypt/decrypt with the same key", () => {
  let cleanups: string[] = [];
  afterEach(() => {
    for (const dir of cleanups) safeRm(dir);
    cleanups = [];
  });

  it("round-trips a secret through set + getDecrypted", () => {
    const { dir, file } = tempPath("baseline");
    cleanups.push(dir);

    const keyA = randomBytes(32);
    const cryptoA = createSecretsCrypto(keyA);
    const store = createSqliteSecretStore(file, cryptoA);

    const set = store.set("alpha", "hello-secret-value");
    expect(set.ok).toBe(true);

    const got = store.getDecrypted("alpha");
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toBe("hello-secret-value");
  });

  it("encrypted bytes are not equal to plaintext", () => {
    const keyA = randomBytes(32);
    const cryptoA = createSecretsCrypto(keyA);
    const r = cryptoA.encrypt("plain-text-value");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ctxt = r.value.ciphertext.toString("utf8");
    expect(ctxt.includes("plain-text-value")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rotation: open same DB with a different master key
// ---------------------------------------------------------------------------

describe("Secret store -- canary mismatch fails closed on key rotation", () => {
  let cleanups: string[] = [];
  afterEach(() => {
    for (const dir of cleanups) safeRm(dir);
    cleanups = [];
  });

  it("re-opening the same DB with keyB throws DECRYPTION_FAILED", () => {
    const { dir, file } = tempPath("rotation");
    cleanups.push(dir);

    const keyA = randomBytes(32);
    const cryptoA = createSecretsCrypto(keyA);
    const storeA = createSqliteSecretStore(file, cryptoA);
    const seed = storeA.set("alpha", "value-alpha");
    expect(seed.ok).toBe(true);

    // New crypto, different master key. validateCanary must throw.
    const keyB = randomBytes(32);
    const cryptoB = createSecretsCrypto(keyB);
    expect(() => createSqliteSecretStore(file, cryptoB)).toThrow(
      /DECRYPTION_FAILED/,
    );
  });

  it("crypto.decrypt() on cross-keyed ciphertext returns Result.err (no throw)", () => {
    const keyA = randomBytes(32);
    const cryptoA = createSecretsCrypto(keyA);

    const enc = cryptoA.encrypt("alpha-plaintext");
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;

    const keyB = randomBytes(32);
    const cryptoB = createSecretsCrypto(keyB);
    const dec = cryptoB.decrypt(enc.value);
    expect(dec.ok).toBe(false);
  });

  it("a corrupted authTag fails closed", () => {
    const key = randomBytes(32);
    const crypto = createSecretsCrypto(key);
    const enc = crypto.encrypt("alpha");
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;

    const tampered = {
      ciphertext: enc.value.ciphertext,
      iv: enc.value.iv,
      authTag: Buffer.from(enc.value.authTag).fill(0),
      salt: enc.value.salt,
    };
    const dec = crypto.decrypt(tampered);
    expect(dec.ok).toBe(false);
  });

  it("a corrupted IV fails closed", () => {
    const key = randomBytes(32);
    const crypto = createSecretsCrypto(key);
    const enc = crypto.encrypt("alpha");
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;

    const tampered = {
      ciphertext: enc.value.ciphertext,
      iv: Buffer.from(enc.value.iv).fill(0),
      authTag: enc.value.authTag,
      salt: enc.value.salt,
    };
    const dec = crypto.decrypt(tampered);
    expect(dec.ok).toBe(false);
  });

  it("createSecretsCrypto rejects keys shorter than 32 bytes", () => {
    const tooShort = randomBytes(16);
    expect(() => createSecretsCrypto(tooShort)).toThrow(/at least 32 bytes/);
  });
});

// ---------------------------------------------------------------------------
// Post-rotation behaviour: new DB, new key, old data unrecoverable
// ---------------------------------------------------------------------------

describe("Secret store -- post-rotation behaviour", () => {
  let cleanups: string[] = [];
  afterEach(() => {
    for (const dir of cleanups) safeRm(dir);
    cleanups = [];
  });

  it("a freshly rotated store has its own canary and accepts new writes", () => {
    const { dir: dirA, file: fileA } = tempPath("post-A");
    const { dir: dirB, file: fileB } = tempPath("post-B");
    cleanups.push(dirA, dirB);

    // Original store under keyA holds "alpha".
    const keyA = randomBytes(32);
    const storeA = createSqliteSecretStore(fileA, createSecretsCrypto(keyA));
    expect(storeA.set("alpha", "value-alpha").ok).toBe(true);

    // Operator rotates: new keyB + new file. Old plaintext is gone.
    const keyB = randomBytes(32);
    const storeB = createSqliteSecretStore(fileB, createSecretsCrypto(keyB));
    expect(storeB.set("beta", "value-beta").ok).toBe(true);
    const got = storeB.getDecrypted("alpha");
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toBeUndefined();
  });

  it("the same key opens the same file twice (canary stable across opens)", () => {
    const { dir, file } = tempPath("stable");
    cleanups.push(dir);

    const key = randomBytes(32);
    const crypto1 = createSecretsCrypto(key);
    const store1 = createSqliteSecretStore(file, crypto1);
    expect(store1.set("alpha", "value-alpha").ok).toBe(true);

    // Second open with a NEW SecretsCrypto instance but same master key.
    const crypto2 = createSecretsCrypto(key);
    const store2 = createSqliteSecretStore(file, crypto2);
    const got = store2.getDecrypted("alpha");
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toBe("value-alpha");
  });
});
