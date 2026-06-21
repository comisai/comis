// SPDX-License-Identifier: Apache-2.0
/**
 * OTEL-03 / E3 — the content-free re-redaction boundary at the exporter.
 *
 * `redactAttributes` enforces a CLOSED ALLOWLIST of known attribute keys (the
 * `MetricLabel` union + the known span/log attribute keys + the structural
 * summary keys) and DROPS every other key BEFORE it reaches an OTel instrument /
 * span / log — then routes the allowed values through `sanitizeForPersistence`
 * (the single `@comis/observability` chokepoint) as defense-in-depth. The
 * allowlist is the load-bearing guarantee: an allowed-key secret-value scan
 * (credential-keyed or prefix-patterned) is NOT enough on its own, because a
 * BENIGN-keyed, no-prefix, high-entropy value survives value-scanning verbatim
 * (CR-02 — empirically demonstrated). The allowlist is the only posture that
 * survives a secret VALUE you cannot reliably detect.
 *
 * This unit test pins all three halves: (1) a planted secret at ≥2 nesting
 * levels is gone, (2) the scrubbed object is still USEFUL (the real allowed
 * content-free labels survive — not an empty husk), and (3) a HOSTILE
 * benign-keyed / no-prefix / high-entropy value DOES NOT survive the boundary
 * (it is dropped by the allowlist — value-scanning alone would leak it).
 *
 * LOAD-BEARING: removing the `sanitizeForPersistence` call breaks Test 1;
 * removing the allowlist DROP breaks the CR-02 hostile-value tests (the planted
 * benign-keyed secret survives) — neither assertion is a tautology.
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

  it("Test 2: the scrubbed object is still USEFUL — the real allowed content-free labels survive", () => {
    const out = redactAttributes({
      password: "PLANTED",
      provider: "anthropic",
      model: "claude-opus",
      // `scope` is a real MetricLabel (a closed content-free enum value).
      scope: "agent",
    });
    // Allowlisted content-free labels survive verbatim (the catalog labels are these).
    expect(out["provider"]).toBe("anthropic");
    expect(out["model"]).toBe("claude-opus");
    expect(out["scope"]).toBe("agent");
    // The credential value never survives.
    expect(JSON.stringify(out)).not.toContain("PLANTED");
    // Not reduced to an empty husk — the allowed fields remain.
    expect(Object.keys(out).length).toBeGreaterThanOrEqual(3);
  });

  // ── CR-02: the allowlist is the robust posture — value-scanning is NOT enough ──

  it("CR-02: a benign-keyed, no-prefix, high-entropy value does NOT survive the boundary", () => {
    // These are EXACTLY the values upstream credential-key/prefix scanning lets
    // through: the keys are benign (not in CREDENTIAL_KEYS) and the values have
    // NO credential prefix (no `sk-`/`ghp_`/`Bearer …`), so `sanitizeForPersistence`
    // alone passes them VERBATIM. Only a closed allowlist drops them. This FAILS
    // on the pre-allowlist boundary (the secret survives) and is GREEN after.
    const hostile = {
      // A benign key carrying 32 random chars (a real secret could look exactly
      // like this — an opaque token with no recognisable prefix).
      note: "aZ9kQ2mP7xR4tY6wL1nB8vC3sD5fG0hJ",
      // A benign key carrying a 40-hex value (e.g., a leaked SHA / API token).
      detail: "0123456789abcdef0123456789abcdef01234567",
      // Free text with an embedded no-prefix secret body.
      freeText: "the value is Qx7Zr9Lm2Kp4Nv6Bw8Ty0Hs3Gd5Fj1",
    };
    const out = redactAttributes(hostile);
    const json = JSON.stringify(out);
    for (const leak of [
      "aZ9kQ2mP7xR4tY6wL1nB8vC3sD5fG0hJ",
      "0123456789abcdef0123456789abcdef01234567",
      "Qx7Zr9Lm2Kp4Nv6Bw8Ty0Hs3Gd5Fj1",
    ]) {
      expect(
        json,
        `benign-keyed, no-prefix value '${leak}' must NOT survive the allowlist boundary (CR-02)`,
      ).not.toContain(leak);
    }
    // The benign KEYS themselves are dropped (not in the allowlist). NOTE: the
    // `reason` key IS an allowed MetricLabel — its VALUE is bounded to the known
    // cache-break-reason set at the metric-mapping emit site (MD-02), NOT here;
    // these keys (note/detail/freeText) are not labels at all, so they are
    // dropped outright by the closed allowlist.
    expect(out["note"]).toBeUndefined();
    expect(out["detail"]).toBeUndefined();
    expect(out["freeText"]).toBeUndefined();
  });

  it("CR-02: an unknown attribute key with an innocuous value is still dropped (closed allowlist, not blocklist)", () => {
    const out = redactAttributes({
      // Not a metric label, not a known span/log attr — dropped even though the
      // value is harmless. A future careless attribute addition cannot leak.
      newCarelessAttribute: "innocuous",
      // A known allowed label survives alongside it.
      outcome: "success",
    });
    expect(out["newCarelessAttribute"]).toBeUndefined();
    expect(out["outcome"]).toBe("success");
  });

  it("CR-02: the known span attribute keys (comis.trace_id / gen_ai.* / structural summaries) survive the allowlist", () => {
    // These are the keys the span path (traces.ts) legitimately emits through
    // the boundary; the allowlist MUST NOT drop them.
    const out = redactAttributes({
      "comis.trace_id": "11111111-2222-3333-4444-555555555555",
      "comis.duration_ms": 1200,
      "gen_ai.provider.name": "anthropic",
      "gen_ai.system": "anthropic",
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "claude-opus",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 50,
      // The structural message-summary keys (count + roles) the content-free
      // span summary builds and passes THROUGH redactAttributes.
      count: 2,
      roles: ["user", "assistant"],
      // The system-instruction summary keys.
      present: true,
      length: 42,
    });
    expect(out["comis.trace_id"]).toBe("11111111-2222-3333-4444-555555555555");
    expect(out["gen_ai.provider.name"]).toBe("anthropic");
    expect(out["gen_ai.request.model"]).toBe("claude-opus");
    expect(out["count"]).toBe(2);
    expect(out["roles"]).toEqual(["user", "assistant"]);
    expect(out["present"]).toBe(true);
    expect(out["length"]).toBe(42);
  });

  it("returns a plain attribute record (a Record<string, unknown>) for an empty input", () => {
    const out = redactAttributes({});
    expect(out).toEqual({});
    expect(typeof out).toBe("object");
  });
});
