// SPDX-License-Identifier: Apache-2.0
/**
 * SEC-04 — secret-residency scan (THE load-bearing binding-constraint gate).
 *
 * Binding constraint: "no secret ever reaches a report, ledger, or log."
 * This certifies it deterministically:
 *
 *   1. POSITIVE CONTROL (FIRST, mandatory): the rig's expectNoSecretLeak / assertNoSecrets
 *      DOES catch a planted sk-shaped canary. Without this, a green zero-residency result
 *      could be a SILENTLY-BROKEN scanner (a false negative — the worst failure for a leak gate).
 *
 *   2. PRODUCT-REDACTION → RESIDENCY chain: the product's REAL redaction primitives —
 *      redactSecretsInText (the free-form pass the Pino log transport runs over every line)
 *      and scrubSecretsFromText (the egress scrubber at delivery/memory/write boundaries) —
 *      scrub the canary, and the residency scanner confirms the scrubbed output is canary-free.
 *      This is the deterministic proof that the redaction layer protecting every persisted
 *      stream removes a secret before it can land in a stream/report/ledger.
 *
 *   3. REPORT / LEDGER zero residency: a representative report + ledger string is secret-free
 *      (scanned as additionalProbes), and a report containing the canary WOULD be caught.
 *
 * Stage-C (it.skip, COMIS_LIVE + real provider): the full real-LLM, REDACTION-ON multi-stream
 *   sweep — a real completion populates daemon.1.log + cache-trace + session-index + config-audit;
 *   plant the canary as a real provider credential; scan ALL streams → zero residency. (The rig's
 *   in-process ConversationDriver boots with disableRedaction:true to OBSERVE raw payloads, so it
 *   is NOT suitable for a residency=0 assertion — that proof requires a redaction-ON daemon and is
 *   deferred to the operator. Asserting residency=0 on a disableRedaction'd stream would
 *   be a rigged pass and is deliberately avoided here.)
 *
 * costTier: "$0" (Stage-B); Stage-C "¢" (one real completion).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { redactSecretsInText } from "@comis/observability";
import { scrubSecretsFromText } from "@comis/core";
import { expectNoSecretLeak } from "../../assert/observe.js";
import { assertNoSecrets } from "../../cost.js";
import { SECRET_CANARY } from "../../harness/sec-config.js";

const isLive = !!process.env["COMIS_LIVE"];

// ---------------------------------------------------------------------------
// SEC-04 Stage-B — POSITIVE CONTROL (mandatory, FIRST)
//
// Without this, a zero-residency pass could be a false negative — a silently-broken
// scanner. This proves the scanner actually fires on the canary. MANDATORY.
// ---------------------------------------------------------------------------

describe("SEC-04 Stage-B — positive control (the scanner catches the canary)", () => {
  it("assertNoSecrets THROWS on a buffer containing the canary", () => {
    expect(() => assertNoSecrets(`config secret = ${SECRET_CANARY}`)).toThrow(/SECRET LEAK/);
  });

  it("expectNoSecretLeak REJECTS on a stream line containing the canary", async () => {
    await expect(expectNoSecretLeak([`{"msg":"boot","note":"${SECRET_CANARY}"}`])).rejects.toThrow(
      /SECRET LEAK/,
    );
  });

  it("the failure message REDACTS the canary (the scan itself cannot leak it)", () => {
    try {
      assertNoSecrets(SECRET_CANARY);
      throw new Error("expected assertNoSecrets to throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("REDACTED");
      expect(msg).not.toContain(SECRET_CANARY);
    }
  });
});

// ---------------------------------------------------------------------------
// SEC-04 Stage-B — product redaction → residency chain (deterministic, non-rigged)
//
// The REAL redaction primitives scrub the canary; the residency scanner confirms the
// scrubbed output is clean. This is the redaction layer that protects every persisted stream.
// ---------------------------------------------------------------------------

describe("SEC-04 Stage-B — product redaction removes the canary before any stream", () => {
  it("redactSecretsInText (the Pino transport free-form pass) scrubs the canary → residency clean", async () => {
    const rawLine = JSON.stringify({
      level: 30,
      msg: "provider configured",
      note: `apiKey = ${SECRET_CANARY}`,
    });
    // Sanity: the RAW line contains the canary (so the scrub is doing real work).
    expect(rawLine).toContain(SECRET_CANARY);

    const redacted = redactSecretsInText(rawLine);
    expect(redacted).not.toContain(SECRET_CANARY);
    // The residency scanner confirms the redacted line is secret-free.
    await expectNoSecretLeak([redacted]);
  });

  it("scrubSecretsFromText (the egress/memory/write scrubber) scrubs the canary → residency clean", async () => {
    const raw = `Here is the credential: ${SECRET_CANARY} — keep it safe.`;
    const { text: scrubbed, redactions } = scrubSecretsFromText(raw);
    expect(redactions).toBeGreaterThan(0);
    expect(scrubbed).not.toContain(SECRET_CANARY);
    await expectNoSecretLeak([scrubbed]);
  });
});

// ---------------------------------------------------------------------------
// SEC-04 Stage-B — report / ledger zero residency
// ---------------------------------------------------------------------------

describe("SEC-04 Stage-B — report/ledger have zero secret residency", () => {
  it("a secret-free report + ledger pass the residency scan (additionalProbes)", async () => {
    const report = JSON.stringify({
      mode: "sec",
      results: [{ id: "SEC-04", status: "pass", provider: "none", tokens: 0 }],
      cost_usd: 0,
    });
    const ledger = "date,sha,category,verdict\n2026-06-06,abc1234,security,CERTIFIED\n";
    await expectNoSecretLeak([], [report, ledger]);
  });

  it("a report containing the canary WOULD be caught (the report scan is wired)", async () => {
    const leakyReport = JSON.stringify({ mode: "sec", debug: SECRET_CANARY });
    await expect(expectNoSecretLeak([], [leakyReport])).rejects.toThrow(/SECRET LEAK/);
  });
});

// ---------------------------------------------------------------------------
// SEC-04 Stage-C — full real-LLM, REDACTION-ON multi-stream residency sweep
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)(
  "SEC-04 Stage-C — full real-LLM redaction-ON multi-stream residency sweep (COMIS_LIVE + real provider)",
  () => {
    it.skip(
      "plant the canary as a real provider credential, run a real completion (populates daemon.1.log + " +
        "cache-trace + session-index + config-audit + obs.billing), then expectNoSecretLeak over EVERY persisted " +
        "stream + report + ledger → zero residency (SKIPPED(no-creds): needs COMIS_LIVE + a real provider AND a " +
        "redaction-ON daemon — the in-process rig forces disableRedaction:true for raw-payload observation, so the " +
        "production-true residency=0 proof is deferred to the operator; the deterministic redaction→" +
        "residency chain + positive control + report/ledger scan are proven in Stage-B above)",
      () => {
        // Stage-C (operator): boot a redaction-ON daemon, plant the canary as a provider key, drive one real
        //   completion, then read logs/daemon.1.log + logs/cache-trace.jsonl + logs/session-index.*.jsonl +
        //   logs/config-audit.jsonl + the report + the ledger, and expectNoSecretLeak(allLines, [report, ledger]).
      },
    );
  },
);
