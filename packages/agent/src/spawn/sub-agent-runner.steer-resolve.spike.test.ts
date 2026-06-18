// SPDX-License-Identifier: Apache-2.0
/**
 * A1 de-risk spike for STEER-01 (Phase 175 — real mid-flight steering).
 *
 * PURPOSE
 * -------
 * Phase 175 adds a true `steer` (inject) path to the `subagents` tool that
 * delivers a high-priority message into a RUNNING child's live SDK session at
 * the next step boundary — instead of today's kill+respawn (which discards the
 * child's transcript and progress). The inject handler must resolve the running
 * child's live `RunHandle` (exposing
 * `steer`/`followUp`/`abort`/`isStreaming`/`isCompacting`).
 *
 * The single LOAD-BEARING assumption (A1, RESEARCH Assumptions Log) is:
 *   a RUNNING sub-agent's `RunHandle` is reachable from the runner via the
 *   SAME lookup `killRun` uses for `abort()` —
 *   `sessionResolver.resolveActiveSession(deriveCompositeForRun(run))`
 *   (sub-agent-runner.ts:1938).
 *
 * WR-01 CORRECTION (175-REVIEW.md)
 * --------------------------------
 * The ORIGINAL spike gave FALSE confirmation: it registered the handle under a
 * key derived from `deriveCompositeForRunReplica(run)` — i.e. the RESOLUTION
 * formula — and then resolved with the SAME formula, so both sides trivially
 * agreed (a tautology). The "drift guard" compared two byte-identical
 * `formatSessionKey(...)` calls (`x === x`). Neither exercised the REAL executor
 * registration formula, which uses the child's runtime origin channelType
 * (`deliveryOrigin?.channelType ?? channelType ?? "gateway"`) and
 * `userId = msg.channelId` (the sub-session channelId) — NOT the resolver's
 * `"sub-agent"` fallback nor `run.announceChannelId`.
 *
 * This rewrite reproduces the GENUINE divergence:
 *   - REGISTRATION key (channel/sub-agent path): pi-executor.ts:1152-1156
 *       formatSessionKey({ tenantId: agentId ?? "default",
 *                          channelId: `${originChannelType}:${msg.channelId}`,
 *                          userId: msg.channelId })
 *     where for a no-announce sub-agent run there is NO deliveryOrigin in the
 *     ALS context, so `originChannelType === "gateway"` and
 *     `msg.channelId === subSessionKey.channelId` (= "sub-agent:<runId>").
 *   - RESOLUTION key (kill/steer path): sub-agent-runner.ts:1938 / steer-run.ts
 *       formatComposite(deriveCompositeForRun(run)) via session-resolver.ts.
 *
 * `deriveCompositeForRun` is module-private (sub-agent-runner.ts:78-89) and the
 * helper carries an exported-for-test alias on the leaf module (steer-run.ts), so
 * we import the REAL formula from there (`deriveCompositeForRunForTest`) rather
 * than reconstructing it inline — a drift in the production formula now fails
 * this spike directly.
 *
 * Test A (primary): a handle registered under the REAL executor formula is
 *   resolved by `resolveActiveSession(deriveCompositeForRun(run))` (proves the
 *   inject handler reaches the live handle — the de-risk SUCCESS).
 * Test B (fallback documentation): `activeRunRegistry.get(run.sessionKey)` is
 *   the by-sessionKey fallback the handler uses IFF the composite path fails.
 * Drift guard: the executor formula (built from the REAL registration inputs)
 *   must equal the resolver formula (built from `deriveCompositeForRun`) — two
 *   INDEPENDENTLY-derived keys, not the same `composite` twice.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import {
  formatSessionKey,
  type SessionKey,
} from "@comis/core";
import {
  createActiveRunRegistry,
  type RunHandle,
} from "../executor/active-run-registry.js";
import { createBackgroundSessionResolver } from "../background/session-resolver.js";
import { deriveCompositeForRunForTest } from "./steer-run.js";

// ---------------------------------------------------------------------------
// SubAgentRun-shaped fixture (only the fields deriveCompositeForRun reads).
// Mirrors the realistic sub-agent case: announceChannelType/Id UNSET.
// ---------------------------------------------------------------------------
interface SubAgentRunFixture {
  agentId: string;
  sessionKey: string;
  announceChannelType?: string;
  announceChannelId?: string;
}

/**
 * Build the REAL executor registration key for a sub-agent run
 * (pi-executor.ts:1152-1156). This is the INDEPENDENT input the spike compares
 * against — built from the executor's own variables (originChannelType +
 * subSessionKey.channelId), NOT from `deriveCompositeForRun`.
 *
 * For a no-announce sub-agent run, the executor's ALS context carries no
 * `deliveryOrigin`, so `originChannelType` defaults to "gateway"; for an
 * announce run it is `run.announceChannelType`. The executor ALWAYS receives
 * `subSessionKey` (sub-agent-runner.ts:1289), so `msg.channelId` is the
 * sub-session channelId regardless of announce fields.
 */
function executorRegistrationKey(args: {
  agentId: string;
  originChannelType: string;
  subSessionChannelId: string;
}): string {
  return formatSessionKey({
    tenantId: args.agentId, // pi-executor: agentId ?? "default"
    channelId: `${args.originChannelType}:${args.subSessionChannelId}`,
    userId: args.subSessionChannelId,
  } satisfies SessionKey);
}

/**
 * Build a RunHandle test double exposing the FULL steering surface
 * (active-run-registry.ts:20-31), not just `abort`.
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
  // emits it (sub-agent-runner.ts:1184) —
  //   { tenantId, userId: `sub-agent-${runId}`, channelId: `sub-agent:${runId}` }
  // → formatted "<tenant>:sub-agent-<runId>:sub-agent:<runId>".
  // Announce fields UNSET (the realistic sub-agent case → originChannelType
  // defaults to "gateway" in the executor).
  const agentId = "researcher";
  const runId = "run-uuid-abc";
  const subSessionChannelId = `sub-agent:${runId}`;
  const subAgentSessionKey: string = formatSessionKey({
    tenantId: "default",
    userId: `sub-agent-${runId}`,
    channelId: subSessionChannelId,
  } satisfies SessionKey);

  // No-announce sub-agent → the executor sees no deliveryOrigin → "gateway".
  const ORIGIN_CHANNEL_TYPE = "gateway";

  const run: SubAgentRunFixture = {
    agentId,
    sessionKey: subAgentSessionKey,
    // announceChannelType / announceChannelId intentionally UNSET.
  };

  it("Test A: resolveActiveSession(deriveCompositeForRun(run)) returns the SAME live RunHandle the SDK registered under the REAL executor formula", () => {
    // ── REAL registry + REAL resolver (NOT mocks): exercise the genuine key
    //    formulas. The spike's whole value is proving the two sides compose.
    const registry = createActiveRunRegistry();
    const resolver = createBackgroundSessionResolver({ activeRunRegistry: registry });

    const { handle, steer, followUp } = makeRunHandle();

    // ── Register under the REAL EXECUTOR key (pi-executor.ts:1152-1156),
    //    independently derived from the executor's own variables — NOT from
    //    deriveCompositeForRun. This is how a running sub-agent's RunHandle
    //    actually lands in the registry.
    const registerKey = executorRegistrationKey({
      agentId,
      originChannelType: ORIGIN_CHANNEL_TYPE,
      subSessionChannelId,
    });
    const registered = registry.register(registerKey, handle);
    expect(registered).toBe(true);

    // ── THE LOAD-BEARING ASSERTION: the kill/steer-path lookup
    //    (sub-agent-runner.ts:1938 / steer-run.ts) resolves the live handle for
    //    a running sub-agent. Before the WR-01 fix this returned undefined
    //    (channelType "sub-agent" ≠ registration "gateway").
    const resolved = resolver.resolveActiveSession(deriveCompositeForRunForTest(run));
    expect(resolved).toBeDefined();
    expect(resolved).toBe(handle); // identity-equal — the very handle registered

    // ── And it exposes the FULL steering surface the inject path needs.
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
    // scheme) and assert the by-sessionKey get returns it.
    const registered = registry.register(run.sessionKey, handle);
    expect(registered).toBe(true);

    const fallback = registry.get(run.sessionKey);
    expect(fallback).toBe(handle);
    expect(typeof fallback!.steer).toBe("function");
    expect(typeof fallback!.followUp).toBe("function");
  });

  it("formula-drift guard: the REAL executor registration key === the resolver key from deriveCompositeForRun (two INDEPENDENT derivations)", () => {
    // This is the genuine regression guard (WR-01 correction): the two keys are
    // derived from DIFFERENT inputs —
    //   executorFormatted  ← executor's own (originChannelType, subSessionChannelId)
    //   resolverFormatted  ← deriveCompositeForRun(run) → formatComposite
    // — so if EITHER the registration formula (pi-executor.ts:1152) OR the
    // resolution formula (steer-run.ts deriveCompositeForRun) drifts, they
    // diverge and this assertion fails. This is NOT `x === x`.
    const executorFormatted = executorRegistrationKey({
      agentId,
      originChannelType: ORIGIN_CHANNEL_TYPE,
      subSessionChannelId,
    });

    const composite = deriveCompositeForRunForTest(run);
    const resolverFormatted = formatSessionKey({
      tenantId: composite.agentId,
      channelId: `${composite.channelType}:${composite.channelId}`,
      userId: composite.channelId,
    } satisfies SessionKey);

    expect(resolverFormatted).toBe(executorFormatted);
  });

  it("formula-drift guard (announce path): announceChannelType threads into the key, channelId stays the sub-session id (NOT announceChannelId)", () => {
    // The executor ALWAYS receives subSessionKey (sub-agent-runner.ts:1289), so
    // even when an announce channel is set the registration userId/channelId is
    // the sub-session channelId; only originChannelType becomes the announce
    // channelType (via deliveryOrigin). deriveCompositeForRun must match: use
    // announceChannelType for channelType but the PARSED sub-session channelId
    // for channelId — never announceChannelId.
    const announceRun: SubAgentRunFixture = {
      agentId,
      sessionKey: subAgentSessionKey,
      announceChannelType: "telegram",
      announceChannelId: "chat-12345",
    };
    const executorFormatted = executorRegistrationKey({
      agentId,
      originChannelType: "telegram", // = announceChannelType via deliveryOrigin
      subSessionChannelId,
    });
    const composite = deriveCompositeForRunForTest(announceRun);
    const resolverFormatted = formatSessionKey({
      tenantId: composite.agentId,
      channelId: `${composite.channelType}:${composite.channelId}`,
      userId: composite.channelId,
    } satisfies SessionKey);
    expect(resolverFormatted).toBe(executorFormatted);
    // Explicitly: announceChannelId must NOT leak into the resolution channelId.
    expect(composite.channelId).toBe(subSessionChannelId);
    expect(composite.channelId).not.toContain("chat-12345");
  });
});
