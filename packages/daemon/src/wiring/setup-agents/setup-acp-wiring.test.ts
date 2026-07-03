// SPDX-License-Identifier: Apache-2.0
/**
 * Composition-root wiring test for the ACP SEP holder.
 *
 * The composition root must create ONE `ExecutionPlanHolder` per agent runtime
 * and thread the SAME instance into BOTH:
 *   - `PiExecutorDeps.executionPlanHolder` (so session-bootstrap publishes the
 *     per-turn SEP ref into it), and
 *   - `AcpServerDeps.executionPlanPort` (so the gateway/ACP plan bridge reads
 *     that same live ref).
 * A second-holder regression (one published-into, a different one read-from)
 * means the plan bridge silently reads an empty port forever.
 *
 * Regression guard for the shared-holder invariant: threading a second holder
 * into either consumer makes the plan bridge read an empty port forever.
 */
import { describe, it, expect, vi } from "vitest";
import { createAcpWiring } from "./setup-acp-wiring.js";
import { TypedEventBus } from "@comis/core";
import type { ExecutionPlanHolder } from "@comis/agent";

// The agent `ExecutionPlan` type is internal (not on the @comis/agent barrel);
// the holder's publish() carries it. Derive the ref shape from the holder so
// the test stays decoupled from the agent's private module path.
type PublishRef = Parameters<ExecutionPlanHolder["publish"]>[0];
type PlanLike = NonNullable<PublishRef["current"]>;

describe("createAcpWiring (one shared SEP holder)", () => {
  it("the agent runtime creates one execution-plan holder and shares the same instance with the ACP server deps", () => {
    const eventBus = new TypedEventBus();
    const activityStreamPort = {
      subscribeForTurn: vi.fn(() => ({ unsubscribe: vi.fn() })),
    };

    const wiring = createAcpWiring({
      eventBus,
      activityStreamPort: activityStreamPort as never,
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      } as never,
    });

    // The object placed on PiExecutorDeps.executionPlanHolder must be the SAME
    // reference as the one placed on AcpServerDeps.executionPlanPort — not two
    // holders.
    expect(wiring.holder).toBe(wiring.acpServerDeps.executionPlanPort);
    // The same shared holder is what the agent runtime publishes into.
    expect(wiring.acpServerDeps.executionPlanPort).toBe(wiring.holder);
    // The event bus + activity stream port are threaded onto the ACP deps so
    // the plan bridge (eventBus-driven) and the activity/approval bridges
    // (activityStreamPort-driven) reach the live sources.
    expect(wiring.acpServerDeps.eventBus).toBe(eventBus);
    expect(wiring.acpServerDeps.activityStreamPort).toBe(activityStreamPort);
  });

  it("the shared holder published by session-bootstrap is the one the plan bridge reads through the ACP port", () => {
    const eventBus = new TypedEventBus();
    const wiring = createAcpWiring({
      eventBus,
      activityStreamPort: undefined,
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      } as never,
    });

    // Simulate session-bootstrap publishing the per-turn ref into the holder.
    const plan: PlanLike = {
      active: true,
      request: "do the thing",
      completedCount: 0,
      steps: [{ index: 1, description: "step one", status: "pending" }],
    };
    const ref: PublishRef = { current: plan };
    wiring.holder.publish(ref);

    // The plan bridge reads through AcpServerDeps.executionPlanPort — and sees
    // exactly the ref's `current` the agent runtime published (live-read seam
    // end to end; proves the SAME instance, not a copy).
    expect(wiring.acpServerDeps.executionPlanPort.getCurrentPlan()).toBe(plan);

    // A SEP-off turn de-publishes via the same shared holder; the port then
    // reads undefined (stale-plan leak guard).
    wiring.holder.clear();
    expect(
      wiring.acpServerDeps.executionPlanPort.getCurrentPlan(),
    ).toBeUndefined();
  });
});
