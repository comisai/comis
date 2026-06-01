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
