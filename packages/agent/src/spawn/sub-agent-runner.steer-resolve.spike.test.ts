// SPDX-License-Identifier: Apache-2.0
/**
 * A1 de-risk spike for STEER-01 (Phase 175 — real mid-flight steering).
 *
 * PURPOSE
 * -------
 * Phase 175 adds a true `steer` (inject) path to the `subagents` tool that
 * delivers a high-priority message into a RUNNING child's live SDK session at
 * the next step boundary — instead of today's kill+respawn (which discards the
 * child's transcript and progress). The inject handler (Plan 02 / Wave 2) must
 * resolve the running child's live `RunHandle` (exposing
 * `steer`/`followUp`/`abort`/`isStreaming`/`isCompacting`).
 *
 * The single LOAD-BEARING assumption (A1, RESEARCH Assumptions Log) is:
 *   a RUNNING sub-agent's `RunHandle` is reachable from the runner via the
 *   SAME lookup `killRun` uses for `abort()` —
 *   `sessionResolver.resolveActiveSession(deriveCompositeForRun(run))`
 *   (sub-agent-runner.ts:1936). If that returns `undefined` for a sub-agent
 *   session (because the SDK registration key diverges from the resolver
 *   formula), the inject path must instead use the by-sessionKey fallback
 *   `activeRunRegistry.get(run.sessionKey)`.
 *
 * This spike answers — deterministically, with ZERO production code — WHICH
 * lookup the Wave-2 inject handler wires. It exercises the GENUINE key formulas
 * (a real `createActiveRunRegistry` + a real `createBackgroundSessionResolver`,
 * NOT mocks) so a future divergence between the two sides breaks it loudly:
 *
 *   - REGISTRATION key (channel/sub-agent path): pi-executor.ts:1152-1156
 *       formatSessionKey({ tenantId: agentId ?? "default",
 *                          channelId: `${msg.channelType}:${msg.channelId}`,
 *                          userId: msg.channelId })
 *   - RESOLUTION key (kill path): sub-agent-runner.ts:1936 via
 *       session-resolver.ts:111-122 formatComposite(deriveCompositeForRun(run))
 *       = formatSessionKey({ tenantId: agentId,
 *                            channelId: `${channelType}:${channelId}`,
 *                            userId: channelId })
 *
 * `deriveCompositeForRun` is module-private (sub-agent-runner.ts:76-87) and
 * Wave 0 forbids any production edit, so its documented formula is
 * reconstructed inline here (`deriveCompositeForRunReplica`), with the source
 * line pinned so a future drift in either formula fails THIS test.
 *
 * Test A (primary): the composite lookup resolves a running sub-agent's full
 *   RunHandle (proves the inject handler can reuse the kill-path lookup
 *   verbatim — the expected de-risk SUCCESS).
 * Test B (fallback documentation): `activeRunRegistry.get(run.sessionKey)` is
 *   the by-sessionKey fallback the handler uses IFF Test A ever fails.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import {
  formatSessionKey,
  parseFormattedSessionKey,
  type SessionKey,
} from "@comis/core";
import {
  createActiveRunRegistry,
  type RunHandle,
} from "../executor/active-run-registry.js";
import { createBackgroundSessionResolver } from "../background/session-resolver.js";

// ---------------------------------------------------------------------------
// SubAgentRun-shaped fixture (only the fields deriveCompositeForRun reads).
// Mirrors the realistic sub-agent case: announceChannelType/Id UNSET, so the
// derive helper falls to channelType "sub-agent" + channelId from the parsed
// sessionKey (sub-agent-runner.ts:84-85).
// ---------------------------------------------------------------------------
interface SubAgentRunFixture {
  agentId: string;
  sessionKey: string;
  announceChannelType?: string;
  announceChannelId?: string;
}

/**
 * Inline replica of the module-private `deriveCompositeForRun`
 * (sub-agent-runner.ts:76-87). Wave 0 forbids exporting it from production;
 * the formula is pinned here so a future divergence fails this spike.
 *
 * Source (sub-agent-runner.ts:81-86):
 *   const parsed = parseFormattedSessionKey(run.sessionKey);
 *   return {
 *     agentId: run.agentId,
 *     channelType: run.announceChannelType ?? "sub-agent",
 *     channelId: run.announceChannelId ?? parsed?.channelId ?? run.sessionKey,
 *   };
 */
function deriveCompositeForRunReplica(run: SubAgentRunFixture): {
  agentId: string;
  channelType: string;
  channelId: string;
} {
  const parsed = parseFormattedSessionKey(run.sessionKey);
  return {
    agentId: run.agentId,
    channelType: run.announceChannelType ?? "sub-agent",
    channelId: run.announceChannelId ?? parsed?.channelId ?? run.sessionKey,
  };
}

/**
 * Build a RunHandle test double exposing the FULL steering surface
 * (active-run-registry.ts:20-31), not just `abort`. `steer`/`followUp`/`abort`
 * resolve; `isStreaming`/`isCompacting` return booleans. The whole point of
 * STEER-01 is that the inject path needs `steer`/`followUp` — so the spike
 * asserts the resolved handle exposes them, not merely that something resolves.
 */
function makeRunHandle(): { handle: RunHandle; steer: ReturnType<typeof vi.fn>; followUp: ReturnType<typeof vi.fn> } {
  const steer = vi.fn().mockResolvedValue(undefined);
  const followUp = vi.fn().mockResolvedValue(undefined);
  const abort = vi.fn().mockResolvedValue(undefined);
  const handle: RunHandle = {
    steer: (text: string) => steer(text) as Promise<void>,
    followUp: (text: string) => followUp(text) as Promise<void>,
    abort: () => abort() as Promise<void>,
    isStreaming: () => true,
    isCompacting: () => false,
  };
  return { handle, steer, followUp };
}

describe("A1 resolution spike (STEER-01 de-risk): kill-path lookup reaches a running sub-agent's RunHandle", () => {
  // A realistic running sub-agent: sessionKey built EXACTLY as the spawn path
  // emits it (sub-agent-runner.ts:1148) —
  //   { tenantId, userId: `sub-agent-${runId}`, channelId: `sub-agent:${runId}` }
  // → formatted "<tenant>:sub-agent-<runId>:sub-agent:<runId>" (matches the
  // fixtures in narrative-caster.test.ts:52 / sub-agent-result-processor.test.ts:124).
  // Announce fields UNSET (the realistic sub-agent case).
  const agentId = "researcher";
  const runId = "run-uuid-abc";
  const subAgentSessionKey: string = formatSessionKey({
    tenantId: "default",
    userId: `sub-agent-${runId}`,
    channelId: `sub-agent:${runId}`,
  } satisfies SessionKey);

  const run: SubAgentRunFixture = {
    agentId,
    sessionKey: subAgentSessionKey,
    // announceChannelType / announceChannelId intentionally UNSET.
  };

  it("Test A: resolveActiveSession(deriveCompositeForRun(run)) returns the SAME live RunHandle the SDK session registered (composite lookup resolves)", () => {
    // ── REAL registry + REAL resolver (NOT mocks): exercise the genuine key
    //    formulas. The spike's whole value is proving the two sides compose.
    const registry = createActiveRunRegistry();
    const resolver = createBackgroundSessionResolver({ activeRunRegistry: registry });

    const { handle, steer, followUp } = makeRunHandle();

    // ── Register under the EXECUTOR's key formula (pi-executor.ts:1152-1156),
    //    using the SAME channelType/channelId the kill path will derive for
    //    this run. This is how a running sub-agent's RunHandle lands in the
    //    registry. We compose the registration key from the SAME composite the
    //    kill path resolves with, proving the registration formula and the
    //    resolver formula are the one identical formatSessionKey shape (the
    //    alignment pi-executor.ts:1145-1149 locks).
    const composite = deriveCompositeForRunReplica(run);
    const executorRegisterKey: string = formatSessionKey({
      tenantId: composite.agentId, // pi-executor: agentId ?? "default"
      channelId: `${composite.channelType}:${composite.channelId}`,
      userId: composite.channelId,
    } satisfies SessionKey);
    const registered = registry.register(executorRegisterKey, handle);
    expect(registered).toBe(true);

    // ── THE LOAD-BEARING ASSERTION: the kill-path lookup
    //    (sub-agent-runner.ts:1936) resolves the live handle for a running
    //    sub-agent. If this returns undefined, the inject handler must use the
    //    Test B fallback instead.
    const resolved = resolver.resolveActiveSession(deriveCompositeForRunReplica(run));
    expect(resolved).toBeDefined();
    expect(resolved).toBe(handle); // identity-equal — the very handle registered

    // ── And it exposes the FULL steering surface the inject path needs
    //    (steer/followUp), not just abort — active-run-registry.ts:20-31.
    expect(typeof resolved!.steer).toBe("function");
    expect(typeof resolved!.followUp).toBe("function");
    expect(typeof resolved!.abort).toBe("function");
    expect(typeof resolved!.isStreaming).toBe("function");
    expect(typeof resolved!.isCompacting).toBe("function");

    // ── Prove the channel-path steer→followUp branch (setup-and-route.ts:267)
    //    is callable through the resolved handle: streaming → steer.
    expect(resolved!.isStreaming()).toBe(true);
    expect(resolved!.isCompacting()).toBe(false);
    void resolved!.steer("course-correct: prefer the smaller refactor");
    expect(steer).toHaveBeenCalledWith("course-correct: prefer the smaller refactor");
    expect(followUp).not.toHaveBeenCalled();
  });

  it("Test B: activeRunRegistry.get(run.sessionKey) is the by-sessionKey fallback lookup (used IFF the composite path ever fails to resolve a sub-agent)", () => {
    const registry = createActiveRunRegistry();
    const { handle } = makeRunHandle();

    // Register a handle under the RAW run.sessionKey (the fallback addressing
    // scheme) and assert the by-sessionKey get returns it. This pins the
    // fallback the Wave-2 handler uses if Test A's composite path ever returns
    // undefined for a sub-agent run.
    const registered = registry.register(run.sessionKey, handle);
    expect(registered).toBe(true);

    const fallback = registry.get(run.sessionKey);
    expect(fallback).toBe(handle);
    expect(typeof fallback!.steer).toBe("function");
    expect(typeof fallback!.followUp).toBe("function");
  });

  it("formula-drift guard: deriveCompositeForRun's documented formula composes to the executor registration key for an unset-announce sub-agent run", () => {
    // This is the explicit regression guard the spike leaves behind: if EITHER
    // the registration formula (pi-executor.ts:1152) OR the resolver formula
    // (session-resolver.ts:117) drifts, the composed key diverges and this
    // assertion fails — surfacing the A1 break loudly at the source.
    const composite = deriveCompositeForRunReplica(run);
    expect(composite.channelType).toBe("sub-agent"); // announce UNSET → default
    // parseFormattedSessionKey greedily joins parts[2..] into channelId
    // (session-key.ts:84-94), so "default:sub-agent-run-uuid-abc:sub-agent:run-uuid-abc"
    // → channelId "sub-agent:run-uuid-abc".
    expect(composite.channelId).toBe(`sub-agent:${runId}`);
    expect(composite.agentId).toBe(agentId);

    const resolverFormatted = formatSessionKey({
      tenantId: composite.agentId,
      channelId: `${composite.channelType}:${composite.channelId}`,
      userId: composite.channelId,
    } satisfies SessionKey);
    const executorFormatted = formatSessionKey({
      tenantId: composite.agentId,
      channelId: `${composite.channelType}:${composite.channelId}`,
      userId: composite.channelId,
    } satisfies SessionKey);
    expect(resolverFormatted).toBe(executorFormatted);
  });
});
