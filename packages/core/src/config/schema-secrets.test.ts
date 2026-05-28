// SPDX-License-Identifier: Apache-2.0
/**
 * Schema-level tests for SecretsConfigSchema defaults.
 *
 * Pins the contract that an omitted `security.secrets` block in YAML
 * yields `enabled: false` after schema parsing — the encrypted secrets
 * store is opt-in. The daemon honors the same value at boot:
 * `writeMasterKeyIfAbsent` and `bootstrapSecretsAndEnv` are skipped
 * unless the operator explicitly sets `security.secrets.enabled: true`
 * (or sets it implicitly via a layered overlay).
 */

import { describe, it, expect } from "vitest";
import { SecretsConfigSchema } from "./schema-secrets.js";

describe("SecretsConfigSchema defaults pin encrypted-store opt-in contract", () => {
  it("parses an empty object to enabled=false (store is opt-in; daemon will not bootstrap it)", () => {
    const parsed = SecretsConfigSchema.parse({});
    expect(parsed.enabled).toBe(false);
  });

  it("parses an empty object to dbPath='secrets.db' (default relative path under dataDir)", () => {
    const parsed = SecretsConfigSchema.parse({});
    expect(parsed.dbPath).toBe("secrets.db");
  });

  it("preserves an explicit enabled=false (idempotent with the default)", () => {
    const parsed = SecretsConfigSchema.parse({ enabled: false });
    expect(parsed.enabled).toBe(false);
  });

  it("preserves an explicit enabled=true as the opt-in toggle", () => {
    const parsed = SecretsConfigSchema.parse({ enabled: true });
    expect(parsed.enabled).toBe(true);
  });
});
