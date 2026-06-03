// SPDX-License-Identifier: Apache-2.0
/**
 * ACP composition-root holder wiring.
 *
 * The composition root must create ONE `ExecutionPlanHolder` per agent runtime
 * and thread the SAME instance into BOTH the agent executor and the gateway:
 *   - `PiExecutorDeps.executionPlanHolder` — session-bootstrap publishes the
 *     per-turn SEP ref into it (SEP-on) / clears it (SEP-off);
 *   - `AcpServerDeps.executionPlanPort` — the gateway/ACP plan bridge reads that
 *     same live ref (the holder IS a `@comis/core` `ExecutionPlanPort`).
 *
 * A second holder (one published-into, a different one read-from) would make
 * the plan bridge read an empty port forever; this helper is the single seam
 * that guarantees the shared instance.
 *
 * Hexagonal boundary: this file (the daemon composition root) is the ONE place
 * allowed to import BOTH `@comis/agent` (for the holder factory) and
 * `@comis/gateway` (for the `AcpServerDeps` shape). The gateway itself never
 * imports `@comis/agent` — it consumes the holder as a `@comis/core`
 * `ExecutionPlanPort`. Lives in a sibling file (not setup-agents-runtime.ts) to
 * respect the ≤600-line subdir cap.
 *
 * @module
 */

import { createExecutionPlanHolder } from "@comis/agent";
import type { ExecutionPlanHolder } from "@comis/agent";
import type { AcpServerDeps } from "@comis/gateway";
import type {
  ActivityStreamPort,
  ComisLogger,
  TypedEventBus,
} from "@comis/core";

/** Inputs the composition root already has when building an agent runtime. */
export interface CreateAcpWiringDeps {
  /** Agent event bus — threaded onto AcpServerDeps for the SEP plan bridge. */
  readonly eventBus: TypedEventBus;
  /**
   * Orchestrator-facing redacted activity stream port. Threaded onto
   * AcpServerDeps so startAcpServer constructs the activity + approval bridges.
   * Optional — absent in runtimes without an activity stream.
   */
  readonly activityStreamPort?: ActivityStreamPort;
  /** Bound logger. */
  readonly logger: ComisLogger;
}

/**
 * The shared-holder wiring result. `holder` is threaded into
 * `PiExecutorDeps.executionPlanHolder`; `acpServerDeps` carries the SAME holder
 * as `executionPlanPort` (plus the bus + activity port the bridges need) and is
 * spread into the full `AcpServerDeps` at the gateway construction site.
 */
export interface AcpWiring {
  /** The single ExecutionPlanHolder for this agent runtime. */
  readonly holder: ExecutionPlanHolder;
  /**
   * The ACP-bridge slice of `AcpServerDeps`: the read-only port (the SAME holder
   * instance), the agent event bus, and the redacted activity stream port. The
   * gateway construction site merges this with `executeAgent` + `logger` to form
   * the full `AcpServerDeps`.
   */
  readonly acpServerDeps: Pick<
    AcpServerDeps,
    "executionPlanPort" | "eventBus" | "activityStreamPort"
  >;
}

/**
 * Create the one ExecutionPlanHolder for an agent runtime and the ACP-bridge
 * slice of AcpServerDeps that shares it by reference.
 */
export function createAcpWiring(deps: CreateAcpWiringDeps): AcpWiring {
  // ONE holder per agent runtime. The agent runtime publishes into it; the
  // gateway plan bridge reads from it — the SAME object (asserted by reference
  // in setup-acp-wiring.test.ts).
  const holder = createExecutionPlanHolder();
  deps.logger.debug?.(
    { submodule: "setup-acp-wiring" },
    "ACP execution-plan holder created and shared with the gateway port",
  );
  return {
    holder,
    acpServerDeps: {
      // The holder IS a @comis/core ExecutionPlanPort — handed to the gateway
      // as a read-only port without the gateway importing @comis/agent.
      executionPlanPort: holder,
      eventBus: deps.eventBus,
      activityStreamPort: deps.activityStreamPort,
    },
  };
}
