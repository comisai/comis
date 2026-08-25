// SPDX-License-Identifier: Apache-2.0
/** Materialize the owning trajectory before an off-turn dead-letter event fires. */

import type { ComisSessionManager } from "@comis/agent";
import {
  parseFormattedSessionKey,
  type ComisLogger,
  type TypedEventBus,
} from "@comis/core";
import {
  createTrajectoryEventTypeFilter,
  type SessionTrajectoryHandleRegistry,
} from "@comis/observability";
import { err, ok, type Result } from "@comis/shared";
import type { EffectiveTrajectoryConfig } from "./trajectory-runtime-config.js";

export interface DeadLetterRecoveryObserverDeps {
  readonly dataDir: string;
  readonly eventBus: TypedEventBus;
  readonly logger: ComisLogger;
  readonly trajectoryConfig: EffectiveTrajectoryConfig;
  readonly sessionAdapters: ReadonlyMap<
    string,
    Pick<ComisSessionManager, "getSessionPath">
  >;
  readonly trajectoryRegistry: SessionTrajectoryHandleRegistry;
}

export interface DeadLetterRecoveryObservationInput {
  readonly agentId: string;
  readonly sessionKey: string;
}

export function createDeadLetterRecoveryObserver(
  deps: DeadLetterRecoveryObserverDeps,
): (input: DeadLetterRecoveryObservationInput) => Result<void, Error> {
  return (input) => {
    if (!deps.trajectoryConfig.enabled) return ok(undefined);
    if (
      deps.trajectoryConfig.eventTypes !== undefined
      && deps.trajectoryConfig.eventTypes.length > 0
      && !deps.trajectoryConfig.eventTypes.includes("delivery.outward_ledger_transition")
    ) {
      return ok(undefined);
    }
    const projectedSessionKey = parseFormattedSessionKey(input.sessionKey);
    if (projectedSessionKey === undefined) {
      return err(new Error("Dead-letter recovery session key is invalid"));
    }
    if (projectedSessionKey.agentId !== input.agentId) {
      return err(new Error("Dead-letter recovery session authority does not match its agent"));
    }
    const sessionAdapter = deps.sessionAdapters.get(input.agentId);
    if (sessionAdapter === undefined) {
      return err(new Error("Dead-letter recovery session adapter is unavailable"));
    }
    const handle = deps.trajectoryRegistry.getOrCreate(
      input.sessionKey,
      {
        agentId: input.agentId,
        sessionId: input.sessionKey,
        sessionKey: input.sessionKey,
        sessionFile: sessionAdapter.getSessionPath(projectedSessionKey),
        logger: deps.logger,
        ...(deps.trajectoryConfig.dir === undefined
          ? { confinedBaseDir: deps.dataDir }
          : { trajectoryDir: deps.trajectoryConfig.dir }),
        enabled: deps.trajectoryConfig.enabled,
        maxRuntimeFileBytes: deps.trajectoryConfig.maxFileBytes,
      },
      deps.eventBus,
      createTrajectoryEventTypeFilter(deps.trajectoryConfig.eventTypes),
    );
    return handle.ok ? ok(undefined) : err(handle.error);
  };
}
