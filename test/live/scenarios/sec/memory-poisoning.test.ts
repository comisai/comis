// SPDX-License-Identifier: Apache-2.0
/**
 * SEC-03 — memory-poisoning pre-storage validation (validateMemoryWrite).
 *
 * Certifies the pre-storage security scan that prevents memory-poisoning attacks
 * (adversary stores a prompt-injection / exec payload in memory for later RAG
 * retrieval + execution):
 *   - dangerous-command content (rm -rf / exec command= / elevated=true / delete all)
 *     ⇒ severity "critical" (storage BLOCKED) — the keystone safety guarantee;
 *   - jailbreak/role poisoning ⇒ severity "warn" (trust DOWNGRADED, not blocked);
 *   - a planted secret ⇒ severity "critical" via the secret-egress-guard (scanned FIRST);
 *   - benign content ⇒ severity "clean" (no false-positive block).
 *
 * Deterministic, no daemon/key/network — validateMemoryWrite is a pure function.
 * SEC-03 is fully covered in Stage-B (no real provider involved → no Stage-C).
 *
 * costTier: "$0".
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { validateMemoryWrite } from "@comis/core";
import {
  DANGEROUS_COMMAND_FIXTURES,
  POISONING_FIXTURES,
  CLEAN_FIXTURE,
  SECRET_CANARY,
} from "../../harness/sec-config.js";

// ---------------------------------------------------------------------------
// SEC-03 Stage-B — dangerous-command CRITICAL block (the keystone)
// ---------------------------------------------------------------------------

describe("SEC-03 Stage-B — dangerous-command CRITICAL block (storage blocked)", () => {
  for (const fixture of DANGEROUS_COMMAND_FIXTURES) {
    it(`blocks (critical) ${JSON.stringify(fixture)}`, () => {
      const r = validateMemoryWrite(fixture);
      expect(r.severity).toBe("critical");
      expect(r.criticalPatterns.length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// SEC-03 Stage-B — poisoning WARN downgrade
// ---------------------------------------------------------------------------

describe("SEC-03 Stage-B — poisoning WARN downgrade (trust downgraded, not blocked)", () => {
  for (const fixture of POISONING_FIXTURES) {
    it(`downgrades (warn) ${JSON.stringify(fixture.slice(0, 40))}`, () => {
      const r = validateMemoryWrite(fixture);
      expect(r.severity).toBe("warn");
      expect(r.patterns.length).toBeGreaterThan(0);
      expect(r.criticalPatterns.length).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// SEC-03 Stage-B — planted-secret critical + clean passthrough + ordering
// ---------------------------------------------------------------------------

describe("SEC-03 Stage-B — planted-secret critical + clean passthrough", () => {
  it("blocks a planted secret as critical via the secret-egress-guard", () => {
    const r = validateMemoryWrite(SECRET_CANARY);
    expect(r.severity).toBe("critical");
    expect(r.patterns).toEqual(["secret-egress-guard"]);
  });

  it("passes benign content through as clean (no false-positive block)", () => {
    const r = validateMemoryWrite(CLEAN_FIXTURE);
    expect(r).toEqual({ severity: "clean", patterns: [], criticalPatterns: [] });
  });

  it("scans for secrets FIRST — a secret+dangerous-command string classifies via the secret path", () => {
    const r = validateMemoryWrite(`${SECRET_CANARY} && rm -rf /tmp/x`);
    expect(r.severity).toBe("critical");
    expect(r.patterns).toEqual(["secret-egress-guard"]);
  });
});
