// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for `checkLegacyConfigKeys` — the pre-Zod migration guard (REQ-02).
 *
 * These tests cover detection of the three legacy config patterns:
 * - `oauth.storage` field at the root of the config object
 * - `security.secrets.enabled` boolean field
 * - Mixed-mode: both present with disagreeing implied modes
 *
 * RED+GREEN committed together per AGENTS.md §2.10:
 * The test file imports `checkLegacyConfigKeys` from `migration-guard.ts`,
 * which did not exist before this commit. A RED-only commit cannot compile.
 * Both the test and its implementation are committed together; the RED
 * rationale is that all tests in this file would have failed against
 * pre-patch code (function undefined).
 */

import { describe, it, expect } from "vitest";
import { checkLegacyConfigKeys } from "./migration-guard.js";

describe("checkLegacyConfigKeys (REQ-02 migration guard)", () => {
  // ------------------------------------------------------------------
  // Clean configs — must pass the guard
  // ------------------------------------------------------------------

  it("returns ok for a clean config using security.storage", () => {
    const result = checkLegacyConfigKeys({ security: { storage: "encrypted" } });
    expect(result.ok).toBe(true);
  });

  it("returns ok for an empty config object (no legacy keys)", () => {
    const result = checkLegacyConfigKeys({});
    expect(result.ok).toBe(true);
  });

  it("returns ok when oauth section is absent entirely", () => {
    const result = checkLegacyConfigKeys({ security: { logRedaction: true } });
    expect(result.ok).toBe(true);
  });

  it("returns ok when oauth section exists but has no storage field", () => {
    // e.g. a future oauth section that does not use the legacy key
    const result = checkLegacyConfigKeys({ oauth: { someOtherField: true } });
    expect(result.ok).toBe(true);
  });

  // ------------------------------------------------------------------
  // Single legacy key: oauth.storage
  // ------------------------------------------------------------------

  it("fails with MIGRATION_ERROR when oauth.storage is present", () => {
    const result = checkLegacyConfigKeys({
      oauth: { storage: "file" },
      security: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MIGRATION_ERROR");
      expect(result.error.message).toContain("security.storage");
      expect(result.error.message).toContain("oauth.storage");
    }
  });

  it("fails with MIGRATION_ERROR for oauth.storage: encrypted", () => {
    const result = checkLegacyConfigKeys({
      oauth: { storage: "encrypted" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MIGRATION_ERROR");
      expect(result.error.message).toContain("security.storage");
    }
  });

  // ------------------------------------------------------------------
  // Single legacy key: security.secrets.enabled
  // ------------------------------------------------------------------

  it("fails with MIGRATION_ERROR when security.secrets.enabled: false is present", () => {
    const result = checkLegacyConfigKeys({
      security: { secrets: { enabled: false } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MIGRATION_ERROR");
      expect(result.error.message).toContain("security.storage");
      expect(result.error.message).toContain("security.secrets.enabled");
    }
  });

  it("fails with MIGRATION_ERROR when security.secrets.enabled: true is present", () => {
    const result = checkLegacyConfigKeys({
      security: { secrets: { enabled: true } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MIGRATION_ERROR");
      expect(result.error.message).toContain("security.storage");
    }
  });

  // ------------------------------------------------------------------
  // Mixed-mode: both legacy keys present, disagreeing modes
  // ------------------------------------------------------------------

  it("fails with MIGRATION_ERROR naming stranded store for oauth.storage: file + secrets.enabled: true", () => {
    // oauth says file, secrets.enabled: true implies encrypted — they disagree
    const result = checkLegacyConfigKeys({
      oauth: { storage: "file" },
      security: { secrets: { enabled: true } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MIGRATION_ERROR");
      // Must mention the conflict and stranding (message uses "strand" or "stranded")
      expect(result.error.message).toMatch(/strand(ed)?/);
      expect(result.error.message).toContain("security.storage");
    }
  });

  it("fails with MIGRATION_ERROR naming stranded store for oauth.storage: encrypted + secrets.enabled: false", () => {
    // oauth says encrypted, secrets.enabled: false implies env — they disagree
    const result = checkLegacyConfigKeys({
      oauth: { storage: "encrypted" },
      security: { secrets: { enabled: false } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MIGRATION_ERROR");
      expect(result.error.message).toMatch(/strand(ed)?/);
    }
  });

  // ------------------------------------------------------------------
  // Both legacy keys present but agreeing modes — still an error
  // (legacy keys must be replaced even if they agree)
  // ------------------------------------------------------------------

  it("fails with MIGRATION_ERROR when both legacy keys present and agree (oauth.storage: encrypted + secrets.enabled: true)", () => {
    const result = checkLegacyConfigKeys({
      oauth: { storage: "encrypted" },
      security: { secrets: { enabled: true } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MIGRATION_ERROR");
      expect(result.error.message).toContain("security.storage");
    }
  });

  it("fails with MIGRATION_ERROR when both legacy keys present and agree (oauth.storage: file + secrets.enabled: false)", () => {
    // oauth says file, secrets.enabled: false implies env — these disagree actually
    // but test the case where both are file-ish
    const result = checkLegacyConfigKeys({
      oauth: { storage: "file" },
      security: { secrets: { enabled: false } },
    });
    // Both present → always an error (even if both point to same implied mode conceptually)
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MIGRATION_ERROR");
    }
  });

  // ------------------------------------------------------------------
  // Edge cases
  // ------------------------------------------------------------------

  it("ignores security.secrets section when enabled is not a boolean", () => {
    // schema validation will catch type errors; migration guard ignores non-booleans
    const result = checkLegacyConfigKeys({
      security: { secrets: { enabled: "false" } }, // string, not boolean
    });
    expect(result.ok).toBe(true);
  });

  it("ignores oauth section when storage is not a string", () => {
    const result = checkLegacyConfigKeys({
      oauth: { storage: 42 }, // number, not string
    });
    expect(result.ok).toBe(true);
  });

  it("does not throw on null or non-object nested values", () => {
    expect(() => checkLegacyConfigKeys({ oauth: null as unknown as Record<string, unknown> })).not.toThrow();
    expect(() => checkLegacyConfigKeys({ security: null as unknown as Record<string, unknown> })).not.toThrow();
    expect(() => checkLegacyConfigKeys({ security: { secrets: null as unknown } })).not.toThrow();
  });
});
