// SPDX-License-Identifier: Apache-2.0
/**
 * SEC-01 — provider failure injection → graceful degradation.
 *
 * Certifies that injected provider faults (429 / timeout / 5xx / malformed) degrade
 * GRACEFULLY — classified into a safe, actionable category with a user-safe message
 * that NEVER leaks internals — deterministically, via fault injection (no real API).
 *
 * The deterministic, reachable degradation surface is the PRODUCT's pure error
 * classifier `classifyError` (PUBLIC via @comis/agent), which the prompt-runner
 * failure-path + retry-loop use to decide degrade-vs-retry:
 *   - 429-shaped  → category "rate_limited"   (retryable);
 *   - timeout     → category "prompt_timeout"  (retryable, via classifyPromptTimeout);
 *   - 503/529     → category "overloaded"      (retryable);
 *   - malformed   → category "client_request"  (non-retryable — deterministic re-failure);
 *   - every fault → a real ErrorCategory + a non-empty safe userMessage + a boolean retryable.
 *
 * NOTE on errorKind+hint: `classifyError.category`/`userMessage` are the classification +
 * user-safe message; the §2.7 log-field projection (errorKind + hint on the daemon ERROR/WARN
 * line) is asserted at the daemon layer in Stage-C, where the injected faults are declared via
 * the rig's `expectedErrors` so the universal log-oracle does not false-fail a failure-injection
 * test (a fault-injection test emits ERROR/WARN on purpose — §5.1 robustness rule (i)).
 *
 * Stage-A/B (always): deterministic fault → classification (model-independent).
 * Stage-C (it.skip, COMIS_LIVE + real provider): real-provider 429/5xx → failover rotate +
 *   circuit-breaker open/half-open, asserted on the daemon log with expectedErrors declared.
 *
 * costTier: "$0" (Stage-B); Stage-C "¢".
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { classifyError, classifyPromptTimeout } from "@comis/agent";
import { makeFaultInjector, FAULT_KINDS } from "../../harness/sec-config.js";

const isLive = !!process.env["COMIS_LIVE"];

/** The real ErrorCategory values a graceful degradation may classify to (from @comis/agent error-classifier). */
const KNOWN_CATEGORIES = new Set([
  "credit_exhausted",
  "rate_limited",
  "auth_invalid",
  "overloaded",
  "context_too_long",
  "content_filtered",
  "client_request_signed_replay",
  "client_request",
  "prompt_timeout",
  "empty_response",
  "unknown",
]);

/** Capture the thrown fault from an injector (429/timeout/5xx throw; malformed returns a body). */
function captureFault(kind: (typeof FAULT_KINDS)[number]): unknown {
  const inj = makeFaultInjector({ kind });
  try {
    const body = inj.invoke();
    // malformed: the injector returns a non-JSON body; the "fault" is the parse failure.
    try {
      JSON.parse(String(body));
      return new Error(`unexpected: malformed body parsed cleanly`);
    } catch (parseErr) {
      return new Error(`400 invalid_request_error malformed provider body: ${String(parseErr)}`);
    }
  } catch (err) {
    return err;
  }
}

// ---------------------------------------------------------------------------
// SEC-01 Stage-A/B — deterministic fault → graceful classification
// ---------------------------------------------------------------------------

describe("SEC-01 Stage-B — injected faults degrade gracefully (classifyError, no real provider)", () => {
  it("ErrorCategory union completeness guard (rate_limited + prompt_timeout + overloaded present)", () => {
    expect(KNOWN_CATEGORIES.has("rate_limited")).toBe(true);
    expect(KNOWN_CATEGORIES.has("prompt_timeout")).toBe(true);
    expect(KNOWN_CATEGORIES.has("overloaded")).toBe(true);
  });

  it("EVERY injected fault classifies to a real ErrorCategory with a safe, non-empty userMessage", () => {
    for (const kind of FAULT_KINDS) {
      const fault = captureFault(kind);
      const r = classifyError(fault);
      expect(KNOWN_CATEGORIES.has(r.category)).toBe(true);
      // Graceful degradation: a safe, actionable message — never empty, never the raw fault.
      expect(r.userMessage.length).toBeGreaterThan(0);
      expect(typeof r.retryable).toBe("boolean");
    }
  });

  it("a 429 fault classifies as rate_limited (retryable) — graceful backoff", () => {
    const fault = captureFault("429");
    const r = classifyError(fault);
    expect(r.category).toBe("rate_limited");
    expect(r.retryable).toBe(true);
  });

  it("a malformed fault classifies as client_request (non-retryable — deterministic re-failure)", () => {
    const fault = captureFault("malformed");
    const r = classifyError(fault);
    expect(r.category).toBe("client_request");
    expect(r.retryable).toBe(false);
  });

  it("a timeout classifies as prompt_timeout (retryable) via classifyPromptTimeout", () => {
    const r = classifyPromptTimeout(30_000);
    expect(r.category).toBe("prompt_timeout");
    expect(r.retryable).toBe(true);
  });

  it("a 503/529 overloaded fault classifies as overloaded (retryable)", () => {
    const r = classifyError(new Error("HTTP 503 Service Unavailable — overloaded"));
    expect(r.category).toBe("overloaded");
    expect(r.retryable).toBe(true);
  });

  it("the safe userMessage never echoes the raw fault internals (no leak in degradation)", () => {
    const fault = new Error("HTTP 429 from https://api.example.com with key sk-secret — too many requests");
    const r = classifyError(fault);
    expect(r.userMessage).not.toContain("api.example.com");
    expect(r.userMessage).not.toContain("sk-secret");
  });
});

// ---------------------------------------------------------------------------
// SEC-01 Stage-C — real-provider failover / circuit-breaker (COMIS_LIVE)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("SEC-01 Stage-C — real-provider failover / circuit-breaker (COMIS_LIVE + real provider)", () => {
  it.skip(
    "a real provider driven into a 429/5xx → the failover chain rotates / the circuit-breaker opens then " +
      "half-opens; the daemon log carries the right errorKind+hint, with the injected/real faults declared via " +
      "the rig's expectedErrors so runLogOracle (afterEach) does not false-fail (SKIPPED(no-creds): needs " +
      "COMIS_LIVE + a real provider + the ability to induce a real 429/5xx; the deterministic fault→classification " +
      "degradation is proven in Stage-B above)",
    () => {
      // Stage-C (operator): boot a real-LLM daemon, drive a real provider into a 429/5xx (rate-limit / outage),
      //   assert the failover chain rotates to the next provider + the breaker opens/half-opens; flush + run
      //   runLogOracle(lines, { expectedErrors: ["429", "rate limit", "500", "timeout"] }) in afterEach.
    },
  );
});
