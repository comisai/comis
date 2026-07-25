// SPDX-License-Identifier: Apache-2.0
import { toSafeErrorLogString, type ChannelPort, type ComisLogger } from "@comis/core";

/** Execute one health-driven adapter restart and reject every failed Result. */
export async function restartChannelAdapter(deps: {
  adapter: Pick<ChannelPort, "start" | "stop">;
  channelType: string;
  logger: Pick<ComisLogger, "warn">;
}): Promise<void> {
  const stopped = await deps.adapter.stop();
  if (!stopped.ok) {
    deps.logger.warn(
      {
        channelType: deps.channelType,
        err: toSafeErrorLogString(stopped.error),
        hint: "Resolve the adapter shutdown failure before retrying health recovery",
        errorKind: "platform" as const,
      },
      "Channel health auto-restart failed",
    );
    return Promise.reject(stopped.error);
  }
  const started = await deps.adapter.start();
  if (!started.ok) {
    deps.logger.warn(
      {
        channelType: deps.channelType,
        err: toSafeErrorLogString(started.error),
        hint: "Verify channel credentials and connectivity before retrying health recovery",
        errorKind: "platform" as const,
      },
      "Channel health auto-restart failed",
    );
    return Promise.reject(started.error);
  }
}
