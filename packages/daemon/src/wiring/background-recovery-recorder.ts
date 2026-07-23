// SPDX-License-Identifier: Apache-2.0
import type {
  ComisLogger,
  SessionKey,
  TypedEventBus,
} from "@comis/core";
import type { ComisSessionManager } from "@comis/agent";
import type { SessionTrajectoryHandleRegistry } from "@comis/observability";
import { err, ok, type Result } from "@comis/shared";
import type { EffectiveTrajectoryConfig } from "./trajectory-runtime-config.js";

export interface BackgroundRecoveryTrajectoryInput {
  readonly agentId: string;
  readonly taskId: string;
  readonly toolName: string;
  readonly sessionKey: string;
  readonly projectedSessionKey: SessionKey;
  readonly traceId: string | null;
  readonly timestamp: number;
  readonly reason: "recovery_retry_required" | "recovery_resolved";
}

export interface BackgroundRecoveryRecorderDeps {
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

export function createBackgroundRecoveryRecorder(
  deps: BackgroundRecoveryRecorderDeps,
): (input: BackgroundRecoveryTrajectoryInput) => Result<void, Error> {
  return (input) => {
    if (!deps.trajectoryConfig.enabled) return ok(undefined);
    if (
      deps.trajectoryConfig.eventTypes !== undefined
      && deps.trajectoryConfig.eventTypes.length > 0
      && !deps.trajectoryConfig.eventTypes.includes("background_task:notified")
    ) {
      return ok(undefined);
    }
    const sessionAdapter = deps.sessionAdapters.get(input.agentId);
    if (sessionAdapter === undefined) {
      return err(new Error("Background recovery session adapter is unavailable"));
    }
    const handle = deps.trajectoryRegistry.getOrCreate(
      input.sessionKey,
      {
        agentId: input.agentId,
        sessionId: input.sessionKey,
        sessionKey: input.sessionKey,
        sessionFile: sessionAdapter.getSessionPath(input.projectedSessionKey),
        logger: deps.logger,
        ...(deps.trajectoryConfig.dir === undefined
          ? { confinedBaseDir: deps.dataDir }
          : { trajectoryDir: deps.trajectoryConfig.dir }),
        enabled: deps.trajectoryConfig.enabled,
        maxRuntimeFileBytes: deps.trajectoryConfig.maxFileBytes,
      },
      deps.eventBus,
      deps.trajectoryConfig.eventTypes !== undefined
        && deps.trajectoryConfig.eventTypes.length > 0
        ? (eventName) => deps.trajectoryConfig.eventTypes?.includes(eventName) ?? false
        : undefined,
    );
    if (!handle.ok) return err(handle.error);
    if (handle.value.recorder === null) {
      return err(new Error("Background recovery trajectory recorder is disabled"));
    }
    const disposition = handle.value.recorder.recordEvent(
      "background_task.notified",
      {
        taskId: input.taskId,
        toolName: input.toolName,
        notified: false,
        reason: input.reason,
      },
    );
    return disposition === "queued"
      ? ok(undefined)
      : err(new Error("Background recovery trajectory rejected the event"));
  };
}
