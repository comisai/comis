// SPDX-License-Identifier: Apache-2.0
/**
 * Schema-level tests for SecretsConfigSchema defaults.
 *
 * Pins the contract that an omitted `security.secrets` block in YAML
 * yields `enabled: true` after schema parsing — matching the daemon's
 * secure-by-default boot behavior (writeMasterKeyIfAbsent +
 * bootstrapSecretsAndEnv run unless explicitly opted out).
 *
 * Pre-fix, the schema default was `false` while the daemon ignored the
 * field entirely; the lie surfaced in the web UI toggle reading OFF
 * while the store was actually live. Schema must agree with daemon.
 */

import { describe, it, expect } from "vitest";
import { SecretsConfigSchema } from "./schema-secrets.js";
import { checkLegacyConfigKeys } from "./migration-guard.js";

describe("SecretsConfigSchema defaults agree with daemon secure-by-default behavior", () => {
  it("parses an empty object to dbPath='secrets.db' (default relative path under dataDir)", () => {
    const parsed = SecretsConfigSchema.parse({});
    expect(parsed.dbPath).toBe("secrets.db");
  });
});

// ---------------------------------------------------------------------------
// SecretsConfigSchema.enabled removal — RED test (added before production patch)
// ---------------------------------------------------------------------------

describe("SecretsConfigSchema no longer has an enabled field", () => {
  it("SecretsConfigSchema no longer has an enabled field after legacy removal", () => {
    expect("enabled" in SecretsConfigSchema.shape).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Plan 02-02: dbPath dead-knob removal — RED tests
// These tests fail until:
//   1. SecretsConfigSchema no longer has a dbPath field (empty strictObject)
//   2. checkLegacyConfigKeys detects security.secrets.dbPath → MIGRATION_ERROR
// ---------------------------------------------------------------------------

describe("SecretsConfigSchema no longer has a dbPath field (02-02 dead-knob removal)", () => {
  it("SecretsConfigSchema.parse({}) succeeds and result has no dbPath property", () => {
    const parsed = SecretsConfigSchema.parse({});
    // After dbPath removal the schema is z.strictObject({}) and
    // parsing {} produces {} — no dbPath field.
    expect("dbPath" in parsed).toBe(false);
  });

  it("SecretsConfigSchema.shape has no dbPath key", () => {
    expect("dbPath" in SecretsConfigSchema.shape).toBe(false);
  });
});

describe("checkLegacyConfigKeys detects security.secrets.dbPath (02-02 migration guard)", () => {
  it("returns MIGRATION_ERROR when security.secrets.dbPath is present in raw config", () => {
    const result = checkLegacyConfigKeys({
      security: { secrets: { dbPath: "custom/path/secrets.db" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MIGRATION_ERROR");
      expect(result.error.message).toContain("security.secrets.dbPath");
      expect(result.error.message).toContain("security.storage");
    }
  });

  it("returns MIGRATION_ERROR when security.secrets.dbPath is the default 'secrets.db'", () => {
    const result = checkLegacyConfigKeys({
      security: { secrets: { dbPath: "secrets.db" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MIGRATION_ERROR");
      expect(result.error.message).toContain("security.secrets.dbPath");
    }
  });

  it("returns ok when security.secrets is absent (no dbPath concern)", () => {
    const result = checkLegacyConfigKeys({ security: { storage: "encrypted" } });
    expect(result.ok).toBe(true);
  });

  it("returns ok when security.secrets exists but has no dbPath key", () => {
    // After dbPath removal, an empty security.secrets block is fine
    const result = checkLegacyConfigKeys({ security: { secrets: {} } });
    expect(result.ok).toBe(true);
  });
});
