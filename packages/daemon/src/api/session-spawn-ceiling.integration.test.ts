// SPDX-License-Identifier: Apache-2.0
/**
 * Integration contract for the tree-wide
 * spawn ceiling driven through the REAL production spawn path.
 *
 * The unit suites (root-run-semaphore.test.ts, sub-agent-runner.test.ts) prove
 * the semaphore + the runner's ceiling consult in ISOLATION by passing an
 * explicit, SHARED `rootRunId` literal — the exact precondition production
 * VIOLATES. This suite closes that gap: it wires the real `session.spawn`
 * handler → the real `createSubAgentRunner` (with `checkSpawnCeiling` +
 * `releaseSpawnCeiling` bound to a real `createBoundedAutonomy`) → and drives a
 * parent run that spawns children which RE-ENTER `session.spawn` WITHOUT a
 * caller-supplied `rootRunId` (the in-process agent loop / a leased sub-agent
 * calling `sessions_spawn`).
 *
 * It asserts the four ceiling guarantees:
 *   (a) children SHARE the parent's rootRunId (ONE tree, not N size-1 trees),
 *   (b) the concurrency cap actually TRIPS after `maxConcurrentSelfAgents`
 *       (the `for(;;) spawn()` fork-bomb is bounded),
 *   (c) `killByRootRun(parentRoot)` reaches the children (the revoke cascade),
 *   (d) a COMPLETED run RELEASES its slot (a later spawn on the same root is
 *       re-admitted).
 *
 * On the pre-fix code (the daemon callers mint a fresh root per spawn + no
 * releaseSpawn wiring) every one of these fails.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import {
  createDeliveryOrigin,
  createResolvedRequestContext,
  formatSessionKey,
  parseFormattedSessionKey,
  resolveAutonomy,
  runWithContext,
  type SessionKey,
} from "@comis/core";
import type { LeaseManager } from "@comis/infra";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { withHeldCapabilities } from "../../../../test/support/held-capabilities.js";
import { createBoundedAutonomy } from "../autonomy/bounded-autonomy.js";
import { createRootRunIdResolver } from "../wiring/setup-capability-endpoint-boot.js";
import type { BoundedAutonomyBudgetHolder } from "@comis/agent";
import { createSubAgentRunner, type SubAgentRunnerDeps } from "@comis/agent";
import { createSessionHandlers } from "./session-handlers/index.js";
import type { SessionHandlerDeps } from "./session-handlers/index.js";

// A free (local/gateway) model so the per-root budget $-limb never trips — these
// tests exercise the spawn SEMAPHORE, not the budget meter.
const FREE_PROVIDER = "ollama";
const FREE_MODEL = "llama3";

/** Minimal LeaseManager stub — the ceiling path does not drive it. */
function fakeLeaseManager(): LeaseManager {
  return {
    mintLease: () => ({ leaseId: "L", bearer: "b" }),
    validate: () => null,
    renew: () => null,
    revoke: () => {},
    cascadeRevoke: () => {},
    revokeByRootRun: () => ({ revoked: 0 }),
  } as unknown as LeaseManager;
}

/**
 * Stand up the FULL production spawn chain: a real bounded-autonomy composite, a
 * real sub-agent runner wired to its ceiling acquire+release, a real
 * `resolveRootRunId` resolver, and the real `session.spawn` RPC handler over
 * them. `executeAgent` is a deferred-controlled fn so spawned runs stay
 * "running" until the test resolves them (driving the slot-release path).
 */
function makeHarness(autonomyOverrides?: Parameters<typeof resolveAutonomy>[0]) {
  const clock = createFakeClock(1_000);
  const timers = createFakeTimers(1_000);
  const logger = createMockLogger();
  const config = resolveAutonomy(autonomyOverrides);

  const boundedAutonomy = createBoundedAutonomy({
    clock,
    timers,
    leaseManager: fakeLeaseManager(),
    config,
    logger,
  });

  // The session→rootRunId resolver, over the SAME holder the daemon late-binds.
  const holder: BoundedAutonomyBudgetHolder = {
    current: {
      reserveBudget: (rootRunId, provider, model, estUsd, estTokens) =>
        boundedAutonomy.reserveBudget(rootRunId, provider, model, estUsd, estTokens),
      registerRoot: (rootRunId, leaseId, parentLeaseId) =>
        boundedAutonomy.registerRoot(rootRunId, leaseId, parentLeaseId),
    },
  };
  const rootRunIdIndex = new Map<string, string>();
  const resolveRootRunId = createRootRunIdResolver({ holder, index: rootRunIdIndex });

  // Deferred control over each run's completion (keyed by call order).
  const pendingResolvers: Array<(v: unknown) => void> = [];
  const executeAgent = vi.fn().mockImplementation(
    () => new Promise((resolve) => { pendingResolvers.push(resolve as (v: unknown) => void); }),
  );

  const runnerDeps: SubAgentRunnerDeps = {
    sessionStore: { save: vi.fn(), delete: vi.fn(), loadByFormattedKey: vi.fn() },
    executeAgent: executeAgent as unknown as SubAgentRunnerDeps["executeAgent"],
    sendToChannel: vi.fn().mockResolvedValue(true),
    eventBus: { emit: vi.fn() } as unknown as SubAgentRunnerDeps["eventBus"],
    config: {
      enabled: true,
      maxPingPongTurns: 3,
      allowAgents: [],
      subAgentRetentionMs: 3_600_000,
      waitTimeoutMs: 60_000,
      subAgentMaxSteps: 50,
      subAgentToolGroups: ["coding"],
    },
    tenantId: "default",
    clock,
    timers,
    // The runner consults the real composite at the spawn chokepoint…
    checkSpawnCeiling: (rootRunId, depth, fanout) =>
      boundedAutonomy.tryAcquireSpawn(rootRunId, depth, fanout),
    // …and releases the reserved slot on every run completion.
    releaseSpawnCeiling: (rootRunId) => boundedAutonomy.releaseSpawn(rootRunId),
  };
  const subAgentRunner = createSubAgentRunner(runnerDeps);

  const sessionHandlerDeps: SessionHandlerDeps = {
    defaultAgentId: "default",
    agents: { default: { name: "Test", model: "test-model" } as SessionHandlerDeps["agents"][string] },
    costTrackers: new Map(),
    stepCounters: new Map(),
    defaultWorkspaceDir: "/tmp/ws",
    sessionStore: {
      listDetailed: () => [],
      loadByFormattedKey: () => undefined,
      deleteByFormattedKey: () => false,
      saveByFormattedKey: vi.fn(),
    },
    crossSessionSender: { send: vi.fn() } as never,
    subAgentRunner,
    securityConfig: { agentToAgent: { enabled: true, waitTimeoutMs: 5000 } },
    tenantId: "default",
    logger: createMockLogger(),
    // The session→rootRunId resolver the handler threads so a
    // top-level (operator) spawn shares the session's stable root.
    resolveRootRunId,
  };
  const handlers = withHeldCapabilities(createSessionHandlers(sessionHandlerDeps));

  /** Drive the production `session.spawn` RPC for a given caller session. */
  async function spawnViaHandler(args: {
    task: string;
    callerSessionKey: string;
    callerAgentId?: string;
  }): Promise<{ runId: string }> {
    // Advance the clock between spawns so the runner's last-resort
    // `root-<agentId>-<now>` mint produces a DISTINCT id each call. Without
    // this, two same-ms spawns collide to the SAME minted root and (a)/(b)/(c)
    // pass spuriously on the broken (no-propagation) code — a masking
    // artifact. A correct fix propagates the tree
    // root EXPLICITLY, so it must hold even when every mint would differ.
    clock.advance(1_000);
    const parsedCaller = parseFormattedSessionKey(args.callerSessionKey);
    if (parsedCaller === undefined) throw new Error("Test caller session must be valid");
    const callerAgentId = args.callerAgentId ?? "default";
    const deliveryOrigin = createDeliveryOrigin({
      tenantId: parsedCaller.tenantId,
      userId: parsedCaller.userId,
      channelType: "gateway",
      channelId: "ch",
    });
    const callerContext = createResolvedRequestContext({
      tenantId: parsedCaller.tenantId,
      userId: parsedCaller.userId,
      sessionKey: { ...parsedCaller, agentId: callerAgentId },
      agentId: callerAgentId,
      traceId: "50000000-0000-4000-8000-000000000005",
      startedAt: clock.now(),
      trustLevel: "user",
      channelType: "gateway",
      deliveryOrigin,
    });
    if (!callerContext.ok) throw callerContext.error;
    const res = (await runWithContext(callerContext.value, () => handlers["session.spawn"]!({
        task: args.task,
        _agentId: callerAgentId,
        _callerSessionKey: args.callerSessionKey,
        _callerChannelType: "gateway",
        _callerChannelId: "ch",
      }))) as { runId: string };
    return res;
  }

  return {
    clock,
    timers,
    boundedAutonomy,
    subAgentRunner,
    resolveRootRunId,
    spawnViaHandler,
    pendingResolvers,
    /** Resolve the Nth-launched run's executeAgent so it transitions to completed. */
    completeRun(index: number): void {
      pendingResolvers[index]?.({
        response: "done",
        tokensUsed: { total: 10 },
        cost: { total: 0 },
        finishReason: "stop",
        stepsExecuted: 1,
      });
    },
  };
}

const OPERATOR_SESSION = formatSessionKey({ tenantId: "default", userId: "user1", channelId: "ch1" } as SessionKey);

describe("tree-wide spawn ceiling — driven through the REAL session.spawn path", () => {
  it("(a) children that re-enter session.spawn WITHOUT a rootRunId inherit the parent's tree root", async () => {
    const h = makeHarness();

    // Top-level (operator) spawn → mints/uses the session's stable root.
    const parent = await h.spawnViaHandler({ task: "parent", callerSessionKey: OPERATOR_SESSION });
    const parentRun = h.subAgentRunner.getRunStatus(parent.runId);
    expect(parentRun?.rootRunId).toBeTruthy();
    const parentRoot = parentRun!.rootRunId;

    // The parent's sub-agent runs under its own child session key. When IT calls
    // sessions_spawn, the dispatcher injects that key as _callerSessionKey.
    const parentChildSession = parentRun!.sessionKey;
    expect(parentChildSession.length).toBeGreaterThan(0);

    const child = await h.spawnViaHandler({ task: "child", callerSessionKey: parentChildSession });
    const childRun = h.subAgentRunner.getRunStatus(child.runId);

    // ONE tree → ONE id. A fresh-root-per-spawn defect fails here.
    expect(childRun?.rootRunId).toBe(parentRoot);
  });

  it("(b) a for(;;) spawn() fork-bomb under one caller is bounded by maxConcurrentSelfAgents", async () => {
    // Cap concurrency at 2 and lift the per-caller children gate ABOVE it so the
    // TREE-WIDE semaphore (not the per-caller fanout gate) is the binding bound.
    const CAP = 2;
    const h = makeHarness({ spawn: { maxConcurrentSelfAgents: CAP, maxChildrenPerAgent: 50, maxSpawnDepth: 10 } });

    // A `for(;;) spawn()` storm, ALL from the same operator session — the
    // production fork-bomb shape. Each spawn re-enters the real handler with NO
    // caller-supplied rootRunId; on the broken code each mints a FRESH root and
    // every iteration is admitted (unbounded). A correct fix shares ONE root so
    // the cap binds the whole tree.
    let admitted = 0;
    let rejected = 0;
    const STORM = 8;
    for (let i = 0; i < STORM; i++) {
      try {
        await h.spawnViaHandler({ task: `storm-${i}`, callerSessionKey: OPERATOR_SESSION });
        admitted++;
      } catch {
        rejected++;
      }
    }

    // Bounded: admits never exceed the cap; the rest are rejected. On the
    // fresh-root-per-spawn defect, admitted === STORM (the fork-bomb runs free).
    expect(admitted).toBe(CAP);
    expect(rejected).toBe(STORM - CAP);

    // And exactly CAP runs are actually live under the shared tree root.
    const running = h.subAgentRunner.listRuns().filter((r) => r.status === "running");
    expect(running).toHaveLength(CAP);
    const roots = new Set(running.map((r) => r.rootRunId));
    expect(roots.size).toBe(1); // ONE tree, not CAP size-1 trees
  });

  it("(c) killByRootRun(parentRoot) reaches children spawned through the handler", async () => {
    const h = makeHarness({ spawn: { maxConcurrentSelfAgents: 10, maxChildrenPerAgent: 50, maxSpawnDepth: 10 } });

    const parent = await h.spawnViaHandler({ task: "parent", callerSessionKey: OPERATOR_SESSION });
    const parentRun = h.subAgentRunner.getRunStatus(parent.runId)!;
    const parentRoot = parentRun.rootRunId;

    // Two children re-enter through the handler under the parent's session.
    const c1 = await h.spawnViaHandler({ task: "c1", callerSessionKey: parentRun.sessionKey });
    const c2 = await h.spawnViaHandler({ task: "c2", callerSessionKey: parentRun.sessionKey });

    const killed = h.subAgentRunner.killByRootRun(parentRoot);

    // The whole tree (parent + 2 children) is reached — not just the parent.
    expect(killed.killed).toBe(3);
    expect(h.subAgentRunner.getRunStatus(parent.runId)?.status).toBe("failed");
    expect(h.subAgentRunner.getRunStatus(c1.runId)?.status).toBe("failed");
    expect(h.subAgentRunner.getRunStatus(c2.runId)?.status).toBe("failed");
  });

  it("(d) a completed run RELEASES its slot so a later spawn on the same root is re-admitted", async () => {
    const h = makeHarness({ spawn: { maxConcurrentSelfAgents: 1, maxChildrenPerAgent: 50, maxSpawnDepth: 10 } });

    // First spawn consumes the single slot.
    const first = await h.spawnViaHandler({ task: "first", callerSessionKey: OPERATOR_SESSION });
    const root = h.subAgentRunner.getRunStatus(first.runId)!.rootRunId;

    // With the slot held, a second spawn under the same root is rejected.
    await expect(
      h.spawnViaHandler({ task: "second-while-full", callerSessionKey: OPERATOR_SESSION }),
    ).rejects.toThrow(/ceiling|concurrency/i);

    // Complete the first run → its finally must release the slot.
    h.completeRun(0);
    await vi.waitFor(() =>
      expect(h.subAgentRunner.getRunStatus(first.runId)?.status).toBe("completed"),
    );

    // The slot is free again: a fresh spawn on the same root succeeds.
    const third = await h.spawnViaHandler({ task: "third-after-release", callerSessionKey: OPERATOR_SESSION });
    expect(h.subAgentRunner.getRunStatus(third.runId)?.status).toBe("running");
    expect(h.subAgentRunner.getRunStatus(third.runId)?.rootRunId).toBe(root);
  });
});
