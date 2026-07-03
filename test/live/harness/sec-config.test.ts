// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for the SEC shared harness `sec-config.ts`.
 *
 * Proves each fixture has its INTENDED effect against the REAL product primitives
 * (validateMemoryWrite, detectSuspiciousPatterns) + the rig's secret scanner
 * (assertNoSecrets) — so the SEC scenarios can rely on "this fixture WILL
 * fire the callback / WILL classify critical" without re-deriving it.
 *
 * Pure: no daemon, no key, no network.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { validateMemoryWrite, detectSuspiciousPatterns } from "@comis/core";
import { assertNoSecrets } from "../cost.js";
import {
  makeFaultInjector,
  FAULT_KINDS,
  INJECTION_FIXTURES,
  POISONING_FIXTURES,
  DANGEROUS_COMMAND_FIXTURES,
  CLEAN_FIXTURE,
  SECRET_CANARY,
  EXTERNAL_CONTENT_SOURCES,
} from "./sec-config.js";

// ---------------------------------------------------------------------------
// EXTERNAL_CONTENT_SOURCES — the 13-value source enumeration
// ---------------------------------------------------------------------------

describe("sec-config — EXTERNAL_CONTENT_SOURCES", () => {
  it("lists exactly the 13 real ExternalContentSource values", () => {
    expect([...EXTERNAL_CONTENT_SOURCES]).toEqual([
      "email",
      "webhook",
      "api",
      "channel_metadata",
      "web_search",
      "web_fetch",
      "document",
      "voice_transcription",
      "vision",
      "video_description",
      "mcp_tool",
      "mcp_resource",
      "unknown",
    ]);
  });

  it("has an INJECTION_FIXTURE for every source", () => {
    for (const source of EXTERNAL_CONTENT_SOURCES) {
      expect(typeof INJECTION_FIXTURES[source]).toBe("string");
      expect(INJECTION_FIXTURES[source].length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// INJECTION_FIXTURES — every fixture trips detectSuspiciousPatterns
// ---------------------------------------------------------------------------

describe("sec-config — INJECTION_FIXTURES trip the real suspicious-pattern detector", () => {
  for (const source of EXTERNAL_CONTENT_SOURCES) {
    it(`INJECTION_FIXTURES[${source}] matches >=1 suspicious pattern`, () => {
      const matches = detectSuspiciousPatterns(INJECTION_FIXTURES[source]);
      expect(matches.length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// POISONING / DANGEROUS / CLEAN — validateMemoryWrite classification
// ---------------------------------------------------------------------------

describe("sec-config — POISONING_FIXTURES classify as WARN (trust downgrade)", () => {
  for (const f of POISONING_FIXTURES) {
    it(`validateMemoryWrite warns on ${JSON.stringify(f.slice(0, 32))}`, () => {
      const r = validateMemoryWrite(f);
      expect(r.severity).toBe("warn");
      expect(r.patterns.length).toBeGreaterThan(0);
      expect(r.criticalPatterns.length).toBe(0);
    });
  }
});

describe("sec-config — DANGEROUS_COMMAND_FIXTURES classify as CRITICAL (storage blocked)", () => {
  for (const f of DANGEROUS_COMMAND_FIXTURES) {
    it(`validateMemoryWrite blocks (critical) on ${JSON.stringify(f.slice(0, 32))}`, () => {
      const r = validateMemoryWrite(f);
      expect(r.severity).toBe("critical");
      expect(r.criticalPatterns.length).toBeGreaterThan(0);
    });
  }
});

describe("sec-config — CLEAN_FIXTURE classifies as clean", () => {
  it("validateMemoryWrite returns clean with no patterns", () => {
    const r = validateMemoryWrite(CLEAN_FIXTURE);
    expect(r).toEqual({ severity: "clean", patterns: [], criticalPatterns: [] });
  });
});

// ---------------------------------------------------------------------------
// SECRET_CANARY — detectable by the rig + blocked by validateMemoryWrite
// ---------------------------------------------------------------------------

describe("sec-config — SECRET_CANARY", () => {
  it("is a sk-shaped value the rig's secret scanner catches (assertNoSecrets throws)", () => {
    expect(() => assertNoSecrets(`config secret = ${SECRET_CANARY}`)).toThrow(/SECRET LEAK/);
  });

  it("the thrown message REDACTS the canary (the scan cannot leak it)", () => {
    try {
      assertNoSecrets(SECRET_CANARY);
      throw new Error("expected assertNoSecrets to throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("REDACTED");
      expect(msg).not.toContain(SECRET_CANARY);
    }
  });

  it("validateMemoryWrite blocks it as critical via the secret-egress-guard (scanned first)", () => {
    const r = validateMemoryWrite(SECRET_CANARY);
    expect(r.severity).toBe("critical");
    expect(r.patterns).toEqual(["secret-egress-guard"]);
  });
});

// ---------------------------------------------------------------------------
// makeFaultInjector — the deterministic fault source
// ---------------------------------------------------------------------------

describe("sec-config — makeFaultInjector", () => {
  it("FAULT_KINDS lists the 4 fault kinds", () => {
    expect([...FAULT_KINDS]).toEqual(["429", "timeout", "5xx", "malformed"]);
  });

  it("429/timeout/5xx injectors throw a recognizable fault", () => {
    for (const kind of ["429", "timeout", "5xx"] as const) {
      const inj = makeFaultInjector({ kind });
      expect(inj.kind).toBe(kind);
      expect(() => inj.invoke()).toThrow();
    }
  });

  it("malformed injector returns a non-JSON / shape-violating body (does not throw)", () => {
    const inj = makeFaultInjector({ kind: "malformed" });
    expect(inj.kind).toBe("malformed");
    const body = inj.invoke();
    expect(() => JSON.parse(String(body))).toThrow();
  });
});
