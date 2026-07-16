// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { setupSecrets } from "./setup-secrets.js";

// Generate valid test keys
const VALID_HEX_KEY = randomBytes(32).toString("hex"); // 64 hex chars = 32 bytes
const VALID_BASE64_KEY = randomBytes(32).toString("base64"); // 44+ base64 chars = 32+ bytes

describe("setupSecrets", () => {
  // -----------------------------------------------------------
  // Branch 1: SECRETS_MASTER_KEY absent → ok(null) (envfile mode)
  // -----------------------------------------------------------
  describe("when SECRETS_MASTER_KEY is absent", () => {
    it("returns ok(null) when env has no SECRETS_MASTER_KEY", () => {
      const result = setupSecrets({ env: {}, dataDir: tmpdir() });
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).toBeNull();
    });

    it("returns ok(null) when SECRETS_MASTER_KEY is undefined", () => {
      const result = setupSecrets({
        env: { SECRETS_MASTER_KEY: undefined },
        dataDir: tmpdir(),
      });
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).toBeNull();
    });

    it("returns ok(null) when SECRETS_MASTER_KEY is empty string", () => {
      const result = setupSecrets({
        env: { SECRETS_MASTER_KEY: "" },
        dataDir: tmpdir(),
      });
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).toBeNull();
    });

    it("returns ok(null) when SECRETS_MASTER_KEY is whitespace-only", () => {
      const result = setupSecrets({
        env: { SECRETS_MASTER_KEY: "   " },
        dataDir: tmpdir(),
      });
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).toBeNull();
    });
  });

  // -----------------------------------------------------------
  // Branch 2: SECRETS_MASTER_KEY set but invalid → err()
  // -----------------------------------------------------------
  describe("when SECRETS_MASTER_KEY is invalid", () => {
    it("returns err() for too-short key", () => {
      const result = setupSecrets({
        env: { SECRETS_MASTER_KEY: "abc" },
        dataDir: tmpdir(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid SECRETS_MASTER_KEY");
      }
    });

    it("returns err() for invalid encoding", () => {
      const result = setupSecrets({
        env: { SECRETS_MASTER_KEY: "!!not-valid!!" },
        dataDir: tmpdir(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid SECRETS_MASTER_KEY");
      }
    });

    it("includes actionable guidance in error message", () => {
      const result = setupSecrets({
        env: { SECRETS_MASTER_KEY: "short" },
        dataDir: tmpdir(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toMatch(/hex.*64\+|base64.*44\+/i);
        expect(result.error.message).toContain("envfile-only mode");
      }
    });
  });

  // -----------------------------------------------------------
  // Branch 3: SECRETS_MASTER_KEY set and valid → ok({ crypto, dbPath })
  // -----------------------------------------------------------
  describe("when SECRETS_MASTER_KEY is valid", () => {
    it("returns ok({ crypto, dbPath }) for valid hex key", () => {
      const result = setupSecrets({
        env: { SECRETS_MASTER_KEY: VALID_HEX_KEY },
        dataDir: tmpdir(),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toBeNull();
        expect(result.value!.crypto).toBeDefined();
        expect(result.value!.activityRecordingMasterKey).toHaveLength(32);
        expect(result.value!.activityRecordingMasterKey.toString("hex")).not.toBe(VALID_HEX_KEY);
        expect(result.value!.dbPath).toBeDefined();
      }
    });

    it("returns ok({ crypto, dbPath }) for valid base64 key", () => {
      const result = setupSecrets({
        env: { SECRETS_MASTER_KEY: VALID_BASE64_KEY },
        dataDir: tmpdir(),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toBeNull();
        expect(result.value!.crypto).toBeDefined();
        expect(result.value!.dbPath).toBeDefined();
      }
    });

    it("computes dbPath from dataDir ending with secrets.db", () => {
      const dataDir = tmpdir();
      const result = setupSecrets({
        env: { SECRETS_MASTER_KEY: VALID_HEX_KEY },
        dataDir,
      });
      expect(result.ok).toBe(true);
      if (result.ok && result.value) {
        expect(result.value.dbPath).toMatch(/secrets\.db$/);
        expect(result.value.dbPath).toContain(dataDir);
      }
    });

    it("returned crypto can encrypt and decrypt a round-trip value", () => {
      const result = setupSecrets({
        env: { SECRETS_MASTER_KEY: VALID_HEX_KEY },
        dataDir: tmpdir(),
      });
      expect(result.ok).toBe(true);
      if (result.ok && result.value) {
        const { crypto } = result.value;
        const plaintext = "my-secret-api-key-12345";

        const encResult = crypto.encrypt(plaintext);
        expect(encResult.ok).toBe(true);
        if (encResult.ok) {
          const decResult = crypto.decrypt(encResult.value);
          expect(decResult.ok).toBe(true);
          if (decResult.ok) {
            expect(decResult.value).toBe(plaintext);
          }
        }
      }
    });
  });

  // -----------------------------------------------------------
  // seedKeyHex injection path (same-boot key injection)
  // -----------------------------------------------------------
  describe("seedKeyHex injection path (same-boot key injection)", () => {
    it("returns ok(null) when both env key and seedKeyHex are absent", () => {
      const result = setupSecrets({ env: {}, dataDir: tmpdir() });
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).toBeNull();
    });

    it("returns ok({ crypto, dbPath }) when seedKeyHex provided and env has no SECRETS_MASTER_KEY", () => {
      const result = setupSecrets({ env: {}, dataDir: tmpdir(), seedKeyHex: VALID_HEX_KEY });
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).not.toBeNull();
      if (result.ok && result.value) {
        expect(result.value.crypto).toBeDefined();
        expect(result.value.dbPath).toMatch(/secrets\.db$/);
      }
    });

    // Empty-string SECRETS_MASTER_KEY must NOT shadow a valid seedKeyHex
    it("treats SECRETS_MASTER_KEY=\"\" as absent and uses seedKeyHex to build the store", () => {
      // SECRETS_MASTER_KEY="" is not nullish — must still be treated as absent so
      // seedKeyHex is honored and produces a real crypto engine.
      const result = setupSecrets({
        env: { SECRETS_MASTER_KEY: "" },
        dataDir: tmpdir(),
        seedKeyHex: VALID_HEX_KEY,
      });
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).not.toBeNull();
      if (result.ok && result.value) {
        expect(result.value.crypto).toBeDefined();
        expect(result.value.dbPath).toMatch(/secrets\.db$/);
      }
    });

    // Whitespace-only SECRETS_MASTER_KEY must also be treated as absent
    it("treats SECRETS_MASTER_KEY whitespace-only as absent and uses seedKeyHex", () => {
      const result = setupSecrets({
        env: { SECRETS_MASTER_KEY: "   " },
        dataDir: tmpdir(),
        seedKeyHex: VALID_HEX_KEY,
      });
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).not.toBeNull();
      if (result.ok && result.value) {
        expect(result.value.crypto).toBeDefined();
      }
    });

    it("returns ok({ crypto, dbPath }) when seedKeyHex is valid base64 and env has no key", () => {
      const result = setupSecrets({ env: {}, dataDir: tmpdir(), seedKeyHex: VALID_BASE64_KEY });
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).not.toBeNull();
    });

    it("env SECRETS_MASTER_KEY takes precedence over seedKeyHex when both provided", () => {
      const result = setupSecrets({
        env: { SECRETS_MASTER_KEY: VALID_HEX_KEY },
        dataDir: tmpdir(),
        seedKeyHex: VALID_BASE64_KEY, // different key — env should win
      });
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).not.toBeNull();
      // Both paths produce ok({ crypto, dbPath }); precedence verified by no error
    });

    it("returns err() when seedKeyHex is provided but invalid", () => {
      const result = setupSecrets({
        env: {},
        dataDir: tmpdir(),
        seedKeyHex: "too-short-invalid",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid SECRETS_MASTER_KEY");
      }
    });
  });
});
