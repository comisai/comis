// SPDX-License-Identifier: Apache-2.0
import type {
  BackgroundRecoveryRecorderDisposition,
  BackgroundRecoveryRecorderFailure,
  ComisSessionManager,
} from "@comis/agent";
import type { ComisLogger, SessionKey, TypedEventBus } from "@comis/core";
import {
  createTrajectoryEventTypeFilter,
  type SessionTrajectoryHandleRegistry,
  type TrajectoryResumeFailureKind,
} from "@comis/observability";
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

export type {
  BackgroundRecoveryRecorderDisposition,
  BackgroundRecoveryRecorderFailure,
  BackgroundRecoveryRecorderFailureKind,
} from "@comis/agent";

function classifyTrajectoryFailure(
  kind: TrajectoryResumeFailureKind,
  cause: Error,
): BackgroundRecoveryRecorderFailure {
  switch (kind) {
    case "size_limit":
      return { kind: "persisted_state_capacity", cause };
    case "invalid_jsonl":
      return { kind: "persisted_state_invalid", cause };
    case "permission":
    case "confinement":
    case "symlink":
    case "non_regular":
    case "changed":
    case "io":
      return { kind: "protected_path_unavailable", cause };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function createBackgroundRecoveryRecorder(
  deps: BackgroundRecoveryRecorderDeps,
): (
  input: BackgroundRecoveryTrajectoryInput,
) => Result<
  BackgroundRecoveryRecorderDisposition,
  BackgroundRecoveryRecorderFailure
> {
  return (input) => {
    if (!deps.trajectoryConfig.enabled) return ok("suppressed");
    if (
      deps.trajectoryConfig.eventTypes !== undefined
      && deps.trajectoryConfig.eventTypes.length > 0
      && !deps.trajectoryConfig.eventTypes.includes("background_task.notified")
    ) {
      return ok("suppressed");
    }
    const sessionAdapter = deps.sessionAdapters.get(input.agentId);
    if (sessionAdapter === undefined) {
      return err({
        kind: "session_adapter_unavailable",
        cause: new Error("Background recovery session adapter is unavailable"),
      });
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
      createTrajectoryEventTypeFilter(deps.trajectoryConfig.eventTypes),
    );
    if (!handle.ok) {
      return err(classifyTrajectoryFailure(
        handle.error.failureKind,
        handle.error,
      ));
    }
    if (handle.value.recorder === null) {
      return ok("suppressed");
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
      ? ok("accepted")
      : err({
        kind: "recorder_rejected",
        cause: new Error("Background recovery trajectory rejected the event"),
      });
  };
}
