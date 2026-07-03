// SPDX-License-Identifier: Apache-2.0
/**
 * PLAT-01 — interactive terminal driver: the OS-AGNOSTIC governance core (RUNS on macOS).
 *
 * Certifies the pure, infra-free governance functions deterministically:
 *   - decideAutoAnswer: safe-answer per hintPatterns vs the escalate-always auth/destructive/approval gate
 *     that WINS over a hintPattern (the anti-phishing guard);
 *   - createLoopGuard: a normalized re-render loop fires {repeat:true, reason:"loop_detected"}; a sighting
 *     past the window decays out;
 *   - createSessionCaps: the max_requests / max_interactions / wall_clock CapBreach arithmetic;
 *   - config-shape: SkillsConfigSchema (which embeds TerminalDriverConfigSchema) parses a valid allow-set
 *     (autoAnswer default safe-only, consent.acknowledgedRisk literal true) + rejects a typo'd worker key.
 *
 * The actual CLI-driving path is LINUX+bwrap ONLY (bwrap ABSENT on macOS) ⇒ that end-to-end is Stage-C
 * (describe.skipIf(!isLive || !hasBwrap()) + it.skip) with SKIPPED(no-bwrap/linux-only).
 *
 * NOTE: the driver has NO maxHops/maxConcurrentTurns — the real concurrency knob is
 * worker.maxConcurrentAttentionTurns; the per-session caps are limits.{maxInteractions,maxRequestsPerSession,
 * wallClockMs}.
 *
 * costTier: "$0".
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { decideAutoAnswer, createLoopGuard, createSessionCaps } from "@comis/skills/tools";
import { SkillsConfigSchema } from "@comis/core";
import {
  TERMINAL_SCREENS,
  SAFE_HINT_PATTERNS,
  AUTH_HINT_OVERLAP,
  makeValidTerminalConfig,
  hasBwrap,
} from "../../harness/plat-config.js";

const isLive = !!process.env["COMIS_LIVE"];

// ---------------------------------------------------------------------------
// PLAT-01 Stage-B — decideAutoAnswer (safe-answer vs escalate-always)
// ---------------------------------------------------------------------------

describe("PLAT-01 Stage-B — decideAutoAnswer safe-answer / escalate-always", () => {
  it("mode 'none' ⇒ escalate no_safe_match (policy off)", () => {
    const d = decideAutoAnswer("none", TERMINAL_SCREENS.safe, SAFE_HINT_PATTERNS);
    expect(d).toEqual({ action: "escalate", reason: "no_safe_match" });
  });

  it("auth screen ⇒ escalate auth_login", () => {
    const d = decideAutoAnswer("safe-only", TERMINAL_SCREENS.auth, SAFE_HINT_PATTERNS);
    expect(d).toEqual({ action: "escalate", reason: "auth_login" });
  });

  it("destructive screen ⇒ escalate destructive", () => {
    const d = decideAutoAnswer("safe-only", TERMINAL_SCREENS.destructive, SAFE_HINT_PATTERNS);
    expect(d).toEqual({ action: "escalate", reason: "destructive" });
  });

  it("approval screen ⇒ escalate approval", () => {
    const d = decideAutoAnswer("safe-only", TERMINAL_SCREENS.approval, SAFE_HINT_PATTERNS);
    expect(d).toEqual({ action: "escalate", reason: "approval" });
  });

  it("escalate-always WINS: a screen matching BOTH a safe hint AND an auth marker ⇒ escalate auth_login (not answer)", () => {
    const d = decideAutoAnswer("safe-only", AUTH_HINT_OVERLAP, SAFE_HINT_PATTERNS);
    expect(d).toEqual({ action: "escalate", reason: "auth_login" });
  });

  it("a safe screen matching a hintPattern ⇒ answer with a single Enter (source 'hint')", () => {
    const d = decideAutoAnswer("safe-only", TERMINAL_SCREENS.safe, SAFE_HINT_PATTERNS);
    expect(d).toEqual({ action: "answer", source: "hint", keys: ["\r"], matchedPatternIndex: 0 });
  });

  it("no hintPattern match ⇒ escalate no_safe_match (the safe default)", () => {
    const d = decideAutoAnswer("safe-only", "some unrelated benign program output", SAFE_HINT_PATTERNS);
    expect(d).toEqual({ action: "escalate", reason: "no_safe_match" });
  });

  it("narration carrying a destructive WORD but matching NO safe pattern ⇒ no_safe_match, NOT destructive", () => {
    // The escalate-always gate is a VETO scoped to an about-to-auto-answer safe match. A driven CLI
    // that merely NARRATES "delete a todo" with no operator safe pattern is never auto-answered
    // anyway, so the broad markers must NOT fire on it (they used to false-positive and wedge the
    // drive). Still escalated (no keystroke invented) — just with the generic no_safe_match reason.
    const narration = "I built a TODO app: add, list, mark done, delete a todo by id, clear all completed.";
    const d = decideAutoAnswer("safe-only", narration, SAFE_HINT_PATTERNS);
    expect(d).toEqual({ action: "escalate", reason: "no_safe_match" });
  });
});

// ---------------------------------------------------------------------------
// PLAT-01 Stage-B — createLoopGuard (normalized re-render detection)
// ---------------------------------------------------------------------------

describe("PLAT-01 Stage-B — createLoopGuard re-render loop detection", () => {
  it("the SAME logical prompt re-rendered (different spinner/elapsed) ⇒ loop_detected on the 2nd sighting", () => {
    let now = 1000;
    const g = createLoopGuard({ nowMs: () => now });
    expect(g.observe("s", "Building project ⠋ (3s)")).toEqual({ repeat: false });
    // Same logical prompt — only the spinner glyph + elapsed counter differ → normalizes to the same hash.
    expect(g.observe("s", "Building project ⠙ (4s)")).toEqual({
      repeat: true,
      reason: "loop_detected",
    });
  });

  it("two genuinely different prompts ⇒ both repeat:false", () => {
    let now = 1000;
    const g = createLoopGuard({ nowMs: () => now });
    expect(g.observe("s2", "Enter your name:")).toEqual({ repeat: false });
    expect(g.observe("s2", "Choose an option:")).toEqual({ repeat: false });
  });

  it("a sighting older than the window decays out (no false repeat)", () => {
    let now = 1000;
    const g = createLoopGuard({ nowMs: () => now });
    expect(g.observe("s3", "Working...")).toEqual({ repeat: false });
    now += 40_000; // past the default 30s window
    expect(g.observe("s3", "Working...")).toEqual({ repeat: false });
  });
});

// ---------------------------------------------------------------------------
// PLAT-01 Stage-B — createSessionCaps (the hop/concurrency cap arithmetic)
// ---------------------------------------------------------------------------

describe("PLAT-01 Stage-B — createSessionCaps CapBreach arithmetic", () => {
  it("consumeRequest breaches max_requests on the (N+1)th call", () => {
    const now = 0;
    const caps = createSessionCaps({ maxRequestsPerSession: 2 }, () => now);
    expect(caps.consumeRequest("s")).toBeUndefined();
    expect(caps.consumeRequest("s")).toBeUndefined();
    expect(caps.consumeRequest("s")).toEqual({ breach: "max_requests" });
  });

  it("consumeInteraction breaches max_interactions on the (N+1)th call", () => {
    const now = 0;
    const caps = createSessionCaps({ maxInteractions: 1 }, () => now);
    expect(caps.consumeInteraction("s")).toBeUndefined();
    expect(caps.consumeInteraction("s")).toEqual({ breach: "max_interactions" });
  });

  it("checkWallClock breaches wall_clock once the clock advances past the budget", () => {
    let t = 0;
    const caps = createSessionCaps({ wallClockMs: 100 }, () => t);
    // Anchor startedAt at first touch.
    expect(caps.checkWallClock("s")).toBeUndefined();
    t = 200;
    expect(caps.checkWallClock("s")).toEqual({ breach: "wall_clock" });
  });
});

// ---------------------------------------------------------------------------
// PLAT-01 Stage-B — config-shape (via SkillsConfigSchema, which embeds the terminal schema)
// ---------------------------------------------------------------------------

describe("PLAT-01 Stage-B — TerminalDriverConfig shape (via SkillsConfigSchema)", () => {
  it("a valid terminal allow-set parses (autoAnswer default safe-only, consent.acknowledgedRisk literal true)", () => {
    const parsed = SkillsConfigSchema.safeParse({ terminal: makeValidTerminalConfig() });
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error?.issues)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.terminal?.allow[0]?.autoAnswer).toBe("safe-only");
    }
  });

  it("a typo'd worker key inside the terminal block ⇒ strictObject rejection (fail-fast)", () => {
    const valid = makeValidTerminalConfig() as { worker: Record<string, unknown> };
    const withTypo = {
      ...valid,
      worker: { ...valid.worker, typoKey: 1 },
    };
    const parsed = SkillsConfigSchema.safeParse({ terminal: withTypo });
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PLAT-01 Stage-C — driving a real interactive CLI under bwrap (Linux+bwrap only)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive || !hasBwrap())("PLAT-01 Stage-C — drive a real CLI under bwrap (COMIS_LIVE + Linux+bwrap)", () => {
  it.skip("SKIPPED(no-bwrap/linux-only) — drive a real interactive CLI: safe prompt auto-answered (\\r), unsafe prompt escalates (terminal:escalated Notify), loop-guard fires on a re-render loop, caps evict at maxInteractions; bwrap is ABSENT on macOS", () => {
    // Deferred to a Linux+bwrap operator run. The OS-agnostic governance core
    // (decideAutoAnswer / createLoopGuard / createSessionCaps + the config-shape) is covered in Stage-B above.
  });
});
