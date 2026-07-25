// SPDX-License-Identifier: Apache-2.0
/**
 * Regression guard for the secret-elision replay path (comis-daniel 2026-07-09).
 *
 * The daemon does, every turn (pi-executor.ts): open the session file fresh
 * from disk → scrubRedactedToolCalls (in-memory, NOT persisted) →
 * repairOrphanedMessages (branch()+re-append, PERSISTED) → buildSessionContext.
 *
 * This harness runs that exact sequence TWICE from the same on-disk base and
 * asserts the assembled context is byte-identical across the two turns.
 *
 * FINDING (live-verified on comis-moshe 2026-07-09): the ROUTINE single-anomaly
 * path proven here IS byte-stable — it is NOT the prefix-instability oscillator.
 * The live instability ("Unstable prefix detected") reproduced only when
 * repairOrphanedMessages' MID-SESSION Case-4 pass fired ("repaired N consecutive
 * same-role anomalies") and its branch()+re-append DUPLICATED a multi-turn span
 * (same toolCallId ×4), which then churned the cached prefix. That structural
 * fix (in-memory repair vs persisted branch / scrub-avoids-adjacency) is the
 * open REPLAY-PREFIX-INSTABILITY finding — settle-with-user. This guard locks
 * the routine path so a future change there can't silently regress it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { scrubRedactedToolCalls } from "./scrub-redacted-tool-calls.js";
import { repairOrphanedMessages } from "./orphaned-message-repair.js";

let dir: string | undefined;
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; } });

/** Seed a secret-poisoned session on disk (post-sanitizeSessionSecrets state:
 *  the env_set tool_use args carry the "[REDACTED]" placeholder). */
function seedPoisonedSession(): string {
  dir = mkdtempSync(join(tmpdir(), "comis-replay-"));
  const sm = SessionManager.create("/tmp/cwd", dir);
  const path = (sm as unknown as { getSessionPath?: () => string }).getSessionPath?.()
    ?? (sm as unknown as { sessionFile: string }).sessionFile;
  const now = 1_000_000;
  // A realistic secret-install turn sequence + trailing real conversation so the
  // scrubbed turn ages into replayed history (as idx-96 did in production).
  sm.appendMessage({ role: "user", content: "store my weather-api password", timestamp: now } as never);
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "tool_use", id: "tc_env", name: "gateway", input: { action: "env_set", env_key: "WEATHER_API_KEY", env_value: "[REDACTED]" } }],
    api: "messages", provider: "anthropic", model: "test-model",
    usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: now + 1,
  } as never);
  sm.appendMessage({ role: "tool", content: [{ type: "text", text: JSON.stringify({ ok: true }) }], toolCallId: "tc_env", timestamp: now + 2 } as never);
  sm.appendMessage({ role: "user", content: "thanks, now show the system", timestamp: now + 3 } as never);
  sm.appendMessage({
    role: "assistant", content: [{ type: "text", text: "Here is the system." }],
    api: "messages", provider: "anthropic", model: "test-model",
    usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: now + 4,
  } as never);
  sm.appendMessage({ role: "user", content: "and yesterday's trips?", timestamp: now + 5 } as never);
  return path;
}

/** One daemon turn: open fresh from disk → scrub → repair → assemble. Returns
 *  the assembled message array (what the model + the cache see). */
function runTurn(path: string): unknown {
  const sm = SessionManager.open(path);
  scrubRedactedToolCalls(sm);
  repairOrphanedMessages(sm);
  return sm.buildSessionContext().messages;
}

/** Seed a session carrying MID-SESSION consecutive same-role anomalies (the
 *  Case-4 trigger) — e.g. an elevatedReply double assistant-send + a scrub-reroled
 *  tool_result adjacent to a real user turn. This is the live-reproduced shape. */
function seedMultiAnomalySession(): string {
  dir = mkdtempSync(join(tmpdir(), "comis-replay-multi-"));
  const sm = SessionManager.create("/tmp/cwd", dir);
  const path = (sm as unknown as { getSessionPath?: () => string }).getSessionPath?.()
    ?? (sm as unknown as { sessionFile: string }).sessionFile;
  const now = 2_000_000;
  const asst = (t: string, ts: number, extra: Record<string, unknown> = {}) => ({
    role: "assistant", content: [{ type: "text", text: t }, ...(extra.blocks as unknown[] ?? [])],
    api: "messages", provider: "anthropic", model: "test-model",
    usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: extra.stopReason ?? "stop", timestamp: ts,
  });
  sm.appendMessage({ role: "user", content: "install weather mcp with my creds", timestamp: now } as never);
  // A multi-tool-call connect turn + poisoned env_set → the scrub reroles the
  // poisoned result to user, adjacent to real user turns → same-role runs.
  sm.appendMessage(asst("connecting…", now + 1, { blocks: [{ type: "tool_use", id: "tc_env", name: "gateway", input: { action: "env_set", env_key: "WEATHER_API_KEY", env_value: "[REDACTED]" } }], stopReason: "toolUse" }) as never);
  sm.appendMessage({ role: "tool", content: [{ type: "text", text: JSON.stringify({ ok: true }) }], toolCallId: "tc_env", timestamp: now + 2 } as never);
  sm.appendMessage({ role: "user", content: "thanks", timestamp: now + 3 } as never);
  // elevatedReply double-send: two assistant turns in a row (a real same-role anomaly).
  sm.appendMessage(asst("שמרתי את הסודות ✅", now + 4) as never);
  sm.appendMessage(asst("והתחברתי לשרת 🚚", now + 5) as never);
  sm.appendMessage({ role: "user", content: "show the system", timestamp: now + 6 } as never);
  sm.appendMessage(asst("386 vehicles.", now + 7) as never);
  sm.appendMessage({ role: "user", content: "and yesterday?", timestamp: now + 8 } as never);
  return path;
}

describe("secret-elision replay byte-stability", () => {
  it("routine single-anomaly path: BYTE-IDENTICAL across two turns from the same on-disk base (regression guard)", () => {
    const path = seedPoisonedSession();
    const turn1 = JSON.stringify(runTurn(path));
    const turn2 = JSON.stringify(runTurn(path));
    expect(turn2).toBe(turn1);
  });

  it("mid-session multi-anomaly path: assembled context must be BYTE-IDENTICAL + not GROW across turns (the live oscillator)", () => {
    const path = seedMultiAnomalySession();
    const turn1 = runTurn(path) as unknown[];
    const turn2 = runTurn(path) as unknown[];
    const turn3 = runTurn(path) as unknown[];
    // Pre-fix: repairMidSessionAnomalies' branch()+re-append duplicates the span
    // and/or re-fires from the un-rewritten disk base → the assembled array grows
    // and mutates turn-over-turn (the "Unstable prefix detected" churn).
    expect(turn2.length).toBe(turn1.length);
    expect(turn3.length).toBe(turn1.length);
    expect(JSON.stringify(turn2)).toBe(JSON.stringify(turn1));
    expect(JSON.stringify(turn3)).toBe(JSON.stringify(turn1));
  });
});
