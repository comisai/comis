// SPDX-License-Identifier: Apache-2.0
import type {
  ComisLogger,
  SessionKey,
  TypedEventBus,
} from "@comis/core";
import type { ComisSessionManager } from "@comis/agent";
import type { SessionTrajectoryHandleRegistry } from "@comis/observability";
import { err, ok, type Result } from "@comis/shared";

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
        confinedBaseDir: deps.dataDir,
      },
      deps.eventBus,
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
