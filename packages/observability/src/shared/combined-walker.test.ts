// SPDX-License-Identifier: Apache-2.0
/**
 * `combinedWalk` snapshot-parity corpus + LM-1 / LM-2 ordering pins.
 *
 * RED test: drives the GREEN implementation of
 * `packages/observability/src/shared/combined-walker.ts` (DUP-CONS-02).
 *
 * Four parity configurations:
 *   1. {boundCheck: only}    ≡ pre-fusion `limitPayloadValue`
 *   2. {sanitizeNode: only}  ≡ pre-fusion `sanitizeDiagnosticPayload`
 *   3. {redactNode: only}    ≡ pre-fusion `redactSecrets`
 *   4. {all three}           ≡ pre-fusion `redactSecrets(sanitizeDiagnosticPayload(limitPayloadValue(value)))`
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import {
  combinedWalk,
  boundCheckHook,
  sanitizeNodeHook,
  redactNodeHook,
  type WalkerHooks,
} from "./combined-walker.js";
import {
  limitPayloadValue,
  BOUNDED_PAYLOAD_REASONS,
  type PayloadBoundsOverrides,
} from "./bounded-payload.js";
import { sanitizeDiagnosticPayload } from "./sanitize-diagnostic-payload.js";
import {
  redactSecrets,
  sanitizeForPersistence,
} from "../redact/redact-secrets.js";

// --- Configuration 1: boundCheck-only parity with limitPayloadValue --------

describe("combinedWalk — parity with limitPayloadValue (boundCheck-only configuration)", () => {
  const hooks: WalkerHooks = { boundCheck: boundCheckHook };
  const cases: Array<[string, unknown]> = [
    ["primitive string", "hello"],
    ["small object", { a: 1, b: 2 }],
    ["nested object", { outer: { inner: { leaf: "x" } } }],
    ["small array", [1, 2, 3]],
    ["mixed array", [{ a: 1 }, "b", 42]],
  ];

  for (const [name, payload] of cases) {
    it(`matches limitPayloadValue for: ${name}`, () => {
      expect(combinedWalk(payload, hooks)).toEqual(limitPayloadValue(payload));
    });
  }

  it("matches limitPayloadValue for oversize string (field-size-limit sentinel)", () => {
    const huge = "x".repeat(32 * 1024 + 1);
    expect(combinedWalk(huge, hooks)).toEqual(limitPayloadValue(huge));
  });

  it("matches limitPayloadValue with PayloadBoundsOverrides exemption", () => {
    const big = "x".repeat(50_000);
    const payload = { system: big, other: big };
    const overrides: PayloadBoundsOverrides = {
      stringFieldExempt: new Set(["system"]),
    };
    expect(combinedWalk(payload, hooks, overrides)).toEqual(
      limitPayloadValue(payload, overrides),
    );
  });
});

// --- Configuration 2: sanitizeNode-only parity with sanitizeDiagnosticPayload -

describe("combinedWalk — parity with sanitizeDiagnosticPayload (sanitizeNode-only configuration)", () => {
  const hooks: WalkerHooks = { sanitizeNode: sanitizeNodeHook };
  const cases: Array<[string, unknown]> = [
    ["object with credential key", { apiKey: "sk-1234567890abcdef0", user: "alice" }],
    ["nested credentials", { outer: { inner: { token: "abc123def456" } } }],
    ["name/value pair", { name: "apiKey", value: "sk-1234567890abcdef0" }],
    [
      "image object",
      {
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==",
      },
    ],
    ["benign object", { user: "alice", count: 42 }],
  ];

  for (const [name, payload] of cases) {
    it(`matches sanitizeDiagnosticPayload for: ${name}`, () => {
      expect(combinedWalk(payload, hooks)).toEqual(
        sanitizeDiagnosticPayload(payload),
      );
    });
  }

  it("matches sanitizeDiagnosticPayload for free-text Authorization header", () => {
    const payload = { msg: "Authorization: Bearer sk-aaaaaaaaaaaaaaaaaaaa rejected" };
    expect(combinedWalk(payload, hooks)).toEqual(
      sanitizeDiagnosticPayload(payload),
    );
  });
});

// --- Configuration 3: redactNode-only parity with redactSecrets ------------

describe("combinedWalk — parity with redactSecrets (redactNode-only configuration)", () => {
  const hooks: WalkerHooks = { redactNode: redactNodeHook };
  const cases: Array<[string, unknown]> = [
    ["object with credential key string", { apiKey: "sk-1234567890abcdef0", user: "alice" }],
    ["object with credential key non-string", { apiKey: 12345, user: "alice" }],
    ["free-text Authorization header", { msg: "Authorization: Bearer sk-aaaaaaaaaaaaaaaaaaaa" }],
    ["nested credentials", { outer: { secret: "sk-deeply-nested-1234567890" } }],
    [
      "array of credentials",
      [{ apiKey: "sk-1234567890abcdef0" }, "Authorization: Bearer xyz"],
    ],
  ];

  for (const [name, payload] of cases) {
    it(`matches redactSecrets for: ${name}`, () => {
      expect(combinedWalk(payload, hooks)).toEqual(redactSecrets(payload));
    });
  }

  it("matches redactSecrets for cyclic object (returns '[Circular]' without boundCheck)", () => {
    const a: Record<string, unknown> = { label: "root" };
    a["self"] = a;
    // Build identical cycle for redactSecrets comparison:
    const b: Record<string, unknown> = { label: "root" };
    b["self"] = b;
    expect(combinedWalk(a, hooks)).toEqual(redactSecrets(b));
  });
});

// --- Configuration 4: all-three parity (the strongest gate) ----------------

describe("sanitizeForPersistence — snapshot parity against pre-fusion 3-walk composition (combined-walker GREEN)", () => {
  // Each tuple is [name, payload, expectedOutput]. expectedOutput is the canonical
  // post-pipeline shape — committed values + computed values from pre-fusion semantics.
  const cases: Array<[string, unknown, unknown]> = [
    ["primitive passthrough — string", "hello", "hello"],
    ["primitive passthrough — number", 42, 42],
    ["primitive passthrough — null", null, null],
    ["primitive passthrough — boolean", true, true],
    ["benign nested object", { user: "alice", count: 42 }, { user: "alice", count: 42 }],
    ["benign array", [1, 2, 3], [1, 2, 3]],
    // Credential drop (sanitize stage):
    [
      "object with credential key drops apiKey",
      { apiKey: "sk-1234567890abcdef0", user: "alice" },
      { user: "alice" },
    ],
    // Nested credentials:
    [
      "deeply nested credential drops apiKey",
      { outer: { inner: { apiKey: "sk-1234567890abcdef0" } } },
      { outer: { inner: {} } },
    ],
    // Name/value pair masking (sanitize stage):
    [
      "name/value pair masks value",
      { name: "apiKey", value: "sk-1234567890abcdef0" },
      { name: "apiKey", value: "<redacted>" },
    ],
    // Free-text Authorization (sanitize + redact stages compose).
    // Computed against pre-fusion semantics at TDD-RED time:
    [
      "free-text Authorization header is masked",
      { msg: "Authorization: Bearer sk-aaaaaaaaaaaaaaaaaaaa" },
      (() =>
        redactSecrets(
          sanitizeDiagnosticPayload({
            msg: "Authorization: Bearer sk-aaaaaaaaaaaaaaaaaaaa",
          }),
        ))(),
    ],
  ];
  for (const [name, payload, expected] of cases) {
    it(`produces byte-identical output for: ${name}`, () => {
      expect(sanitizeForPersistence(payload)).toEqual(expected);
    });
  }

  it("preserves image-object rewrite shape", () => {
    const payload = {
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==",
    };
    const out = sanitizeForPersistence(payload) as Record<string, unknown>;
    expect(out["mimeType"]).toBe("image/png");
    const data = out["data"] as Record<string, unknown>;
    expect(data).toHaveProperty("placeholder", "<redacted>");
    expect(data).toHaveProperty("bytes");
    expect(data).toHaveProperty("sha256");
    expect(typeof data["sha256"]).toBe("string");
  });
});

// --- Oversize inputs (bounding stage) --------------------------------------

describe("sanitizeForPersistence — oversize inputs (bounding stage)", () => {
  it("returns bounded-sentinel for oversize string", () => {
    const big = "x".repeat(50 * 1024); // > 32 KB cap
    const out = sanitizeForPersistence({ msg: big }) as Record<string, unknown>;
    expect(out["msg"]).toMatchObject({
      __bounded__: BOUNDED_PAYLOAD_REASONS.fieldSizeLimit,
    });
  });

  it("returns bounded-sentinel for oversize array", () => {
    const big = Array.from({ length: 100 }, (_, i) => i); // > 64 cap
    const out = sanitizeForPersistence({ items: big }) as Record<string, unknown>;
    expect(out["items"]).toMatchObject({
      __bounded__: BOUNDED_PAYLOAD_REASONS.arrayLengthLimit,
    });
  });

  it("returns bounded-sentinel for oversize object key count", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 80; i++) big[`k${i}`] = i;
    const out = sanitizeForPersistence({ nested: big }) as Record<string, unknown>;
    expect(out["nested"]).toMatchObject({
      __bounded__: BOUNDED_PAYLOAD_REASONS.objectKeyLimit,
    });
  });
});

// --- LM-1 / LM-2 ordering pins (security-relevant) -------------------------

describe("sanitizeForPersistence — security-relevant ordering pins", () => {
  it("LM-1: bounds BEFORE redacts — oversize credential string drops apiKey, NOT a partial mask", () => {
    const oversizeCred = "x".repeat(50 * 1024); // 50 KB > 32 KB cap
    const out = sanitizeForPersistence({ apiKey: oversizeCred }) as Record<
      string,
      unknown
    >;
    // sanitizeDiagnosticPayload's hook drops credential-keyed slots entirely.
    // The combined walker MUST drop the apiKey key — NOT leave a partial-mask string.
    expect(Object.prototype.hasOwnProperty.call(out, "apiKey")).toBe(false);
    // And no partial mask of the 50 KB string can be present anywhere:
    const serialized = JSON.stringify(out);
    expect(serialized).not.toMatch(/x{4}\.\.\.x{4}/);
    // Also assert the edge-keeping mask glyph (U+2026 ellipsis) is absent —
    // any leakage via maskToken would produce that sequence:
    expect(serialized).not.toMatch(/x{4}…x{4}/);
  });

  it("LM-2: preserves bounded-payload record-shape cycle sentinel via sanitizeForPersistence", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic["self"] = cyclic;
    const out = sanitizeForPersistence(cyclic) as Record<string, unknown>;
    // First back-edge via boundCheck → record-shape sentinel wins over string "[Circular]":
    expect(out["self"]).toEqual({
      __bounded__: BOUNDED_PAYLOAD_REASONS.cycleDetected,
    });
  });
});

// --- PayloadBoundsOverrides threading --------------------------------------

describe("sanitizeForPersistence — overrides slot exemption", () => {
  it("threads PayloadBoundsOverrides through combinedWalk", () => {
    const big = "x".repeat(50 * 1024);
    const overrides: PayloadBoundsOverrides = {
      stringFieldExempt: new Set(["system"]),
    };
    const out = sanitizeForPersistence({ system: big }, overrides) as Record<
      string,
      unknown
    >;
    // Exempt key → string passes through unchanged (bounded cap waived):
    expect(out["system"]).toBe(big);
  });
});
