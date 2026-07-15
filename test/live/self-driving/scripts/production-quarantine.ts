// SPDX-License-Identifier: Apache-2.0
import { err, ok, type Result } from "@comis/shared";
import { stringify } from "yaml";

export type ReplayQuarantineError = {
  readonly kind: "unsafe_agent_id";
  readonly message: string;
};

const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const CHANNEL_TYPES = [
  "telegram",
  "discord",
  "slack",
  "whatsapp",
  "signal",
  "imessage",
  "line",
  "irc",
  "email",
  "msteams",
] as const;

function quarantinedAgent(): Record<string, unknown> {
  return {
    scheduler: {
      cron: { enabled: false },
      heartbeat: { enabled: false },
    },
    notification: { enabled: false },
    backgroundTasks: { enabled: false },
  };
}

export function buildReplayQuarantineOverlay(
  agentIds: readonly string[],
): Result<string, ReplayQuarantineError> {
  const uniqueAgentIds = [...new Set(agentIds)].sort();
  for (const agentId of uniqueAgentIds) {
    if (!AGENT_ID_RE.test(agentId)) {
      return err({
        kind: "unsafe_agent_id",
        message: "Agent identifier cannot be represented by the replay quarantine",
      });
    }
  }

  const channels: Record<string, unknown> = {};
  for (const channelType of CHANNEL_TYPES) channels[channelType] = { enabled: false };
  channels["healthCheck"] = { enabled: false, autoRestartOnStale: false };

  const agents: Record<string, unknown> = {};
  for (const agentId of uniqueAgentIds) agents[agentId] = quarantinedAgent();

  return ok(
    stringify(
      {
        channels,
        scheduler: {
          cron: { enabled: false },
          heartbeat: { enabled: false },
          tasks: { enabled: false },
        },
        gateway: { host: "127.0.0.1" },
        webhooks: { enabled: false },
        autoReplyEngine: { enabled: false },
        lifecycleReactions: { enabled: false },
        deliveryQueue: {
          drainOnStartup: false,
          drainIntervalMs: 86_400_000,
          pruneIntervalMs: 86_400_000,
        },
        deliveryMirror: { enabled: false },
        agents,
      },
      { sortMapEntries: true },
    ),
  );
}
