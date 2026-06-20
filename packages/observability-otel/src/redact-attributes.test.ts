// SPDX-License-Identifier: Apache-2.0
/**
 * OTEL-03 / E3 — the content-free re-redaction boundary at the exporter.
 *
 * `redactAttributes` routes every attribute object / log body through
 * `sanitizeForPersistence` (the single `@comis/observability` chokepoint)
 * BEFORE it reaches an OTel instrument / span / log — independent of whatever
 * upstream scrubbing happened (the additive E3 guarantee). This unit test pins
 * the boundary's two halves, mirroring the `audit-metadata-content-free.test.ts`
 * shape: (1) a planted secret at ≥2 nesting levels is gone, (2) the scrubbed
 * object is still USEFUL (benign scalar ids/counts survive — not an empty husk).
 *
 * LOAD-BEARING: if the `sanitizeForPersistence` call is removed from
 * `redactAttributes`, Test 1 FAILS (the planted secret survives) — proving the
 * assertion is not a tautology.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { redactAttributes } from "./redact-attributes.js";

describe("redactAttributes (OTEL-03 / E3 — the exporter re-redaction boundary)", () => {
  it("Test 1: a planted secret at >=2 nesting levels never survives the boundary", () => {
    const planted = {
      password: "PLANTED",
      token: "sk-PLANTED",
      nested: { secret: "PLANTED2", deeper: { apiKey: "PLANTED3" } },
    };
    const out = redactAttributes(planted);
    const json = JSON.stringify(out);
    for (const leak of ["PLANTED", "sk-PLANTED", "PLANTED2", "PLANTED3"]) {
      expect(json, `planted value '${leak}' must not survive redactAttributes`).not.toContain(leak);
    }
  });

  it("Test 2: the scrubbed object is still USEFUL — benign scalar ids/counts survive", () => {
    const out = redactAttributes({
      password: "PLANTED",
      provider: "anthropic",
      model: "claude-opus",
      attemptCount: 3,
    });
    // Benign content-free labels survive verbatim (the catalog labels are these).
    expect(out["provider"]).toBe("anthropic");
    expect(out["model"]).toBe("claude-opus");
    expect(out["attemptCount"]).toBe(3);
    // The credential value never survives.
    expect(JSON.stringify(out)).not.toContain("PLANTED");
    // Not reduced to an empty husk — the benign fields remain.
    expect(Object.keys(out).length).toBeGreaterThanOrEqual(3);
  });

  it("returns a plain attribute record (a Record<string, unknown>) for an empty input", () => {
    const out = redactAttributes({});
    expect(out).toEqual({});
    expect(typeof out).toBe("object");
  });
});
