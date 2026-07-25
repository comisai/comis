// SPDX-License-Identifier: Apache-2.0
/**
 * Missed-inbound liveness monitor: a daemon-side timer that raises a proactive
 * alert when a webhook channel stops receiving inbound activity.
 *
 * Webhook adapters are exempt from the channel health monitor's stale-reap
 * (a webhook connection reports healthy even when nothing arrives), so a dead
 * ingress would otherwise be invisible. This dedicated timer keys on the
 * inbound-only `getStatus().lastInboundAt` (never the last-activity timestamp,
 * which an outbound send also bumps — a send-only bot must not mask a dead
 * ingress) and, once the silence exceeds the configured
 * `missedInboundThresholdMs`, emits a content-free `channel:inbound_silent`
 * event + a WARN. The obs bridge turns the event into a `health_signal` row
 * that surfaces as a `comis system-health` finding.
 *
 * Extracted from `daemon.ts` (mirrors `setupChannelHealthMonitor`) to keep the
 * composition root under its architecture line cap.
 *
 * @module
 */
import type { ChannelPort, TimerPort } from "@comis/core";
import { systemNowMs } from "@comis/core";
import type { BootContext } from "../daemon-types.js";
import type { LoggingResult } from "./setup-logging.js";

/**
 * Cap on the poll cadence. A 6h threshold checked every 6h would detect a
 * breach up to 12h late; capping the interval bounds detection latency to at
 * most this window past the threshold without polling more often than needed.
 */
const MAX_LIVENESS_CHECK_INTERVAL_MS = 900_000; // 15 minutes

/** The handle returned to the composition root; `stop()` cancels the timer. */
export interface ChannelLivenessMonitor {
  stop(): void;
}

/**
 * Wire the missed-inbound liveness monitor. Returns `{ monitor, stop }`; both
 * are `undefined` (a no-op) when the msteams webhook channel is disabled or no
 * webhook adapter is present, mirroring `setupChannelHealthMonitor`.
 */
export function setupChannelLivenessMonitor(deps: {
  adaptersByType: NonNullable<BootContext["adaptersByType"]>;
  daemonLogger: LoggingResult["daemonLogger"];
  container: BootContext["container"];
  timer: TimerPort;
  now?: () => number;
}): { monitor: ChannelLivenessMonitor | undefined; stop: (() => void) | undefined } {
  const { adaptersByType, daemonLogger, container, timer } = deps;
  const now = deps.now ?? systemNowMs;

  // The threshold lives on the msteams config — the only webhook channel today
  // (a fully-defaulted config always carries it). Disabled → nothing to watch.
  const msteamsConfig = container.config.channels?.msteams;
  if (!msteamsConfig?.enabled) return { monitor: undefined, stop: undefined };
  const thresholdMs = msteamsConfig.missedInboundThresholdMs;

  /** Read an adapter's connection mode without letting a throwing getStatus()
   *  abort the scan (mirrors the health monitor's defensive probe). */
  function connectionModeOf(adapter: ChannelPort): string | undefined {
    try {
      return adapter.getStatus?.()?.connectionMode;
    } catch {
      return undefined;
    }
  }

  // If there is no webhook adapter to watch, stay a no-op (no leaked timer).
  const hasWebhookAdapter = [...adaptersByType.values()].some(
    (adapter) => connectionModeOf(adapter) === "webhook",
  );
  if (!hasWebhookAdapter) return { monitor: undefined, stop: undefined };

  // Baseline for an adapter that has never reported inbound: the daemon start
  // (this setup call). A bot that has NEVER received is the headline dead
  // ingress, so it alerts once uptime exceeds the threshold.
  const daemonStartMs = now();

  // Debounce: emit once per silent window. A channel is removed from the set
  // the moment its silence drops back under the threshold, so a fresh silence
  // after inbound resumes re-alerts.
  const alertedChannels = new Set<string>();

  function checkOnce(): void {
    const currentMs = now();
    for (const [channelType, adapter] of adaptersByType) {
      let status;
      try {
        status = adapter.getStatus?.();
      } catch {
        continue;
      }
      if (status?.connectionMode !== "webhook") continue;

      const lastInboundAt = status.lastInboundAt ?? null;
      const baselineMs = lastInboundAt ?? daemonStartMs;
      const silentForMs = currentMs - baselineMs;

      if (silentForMs > thresholdMs) {
        if (alertedChannels.has(channelType)) continue; // already alerted this window
        alertedChannels.add(channelType);
        container.eventBus.emit("channel:inbound_silent", {
          channelType,
          lastInboundAt,
          silentForMs,
          thresholdMs,
          timestamp: currentMs,
        });
        daemonLogger.warn(
          {
            channelType,
            silentForMs,
            thresholdMs,
            hint: "No inbound activity past the missed-inbound threshold — verify the channel's inbound webhook route is reachable (app registration messaging endpoint + gateway route) and that senders are allowlisted",
            errorKind: "platform" as const,
          },
          "Channel ingress silent past the missed-inbound threshold",
        );
      } else {
        // Inbound is within the threshold — clear the debounce so the next
        // silent window re-alerts.
        alertedChannels.delete(channelType);
      }
    }
  }

  const checkIntervalMs = Math.min(thresholdMs, MAX_LIVENESS_CHECK_INTERVAL_MS);
  const handle = timer.setInterval(checkOnce, checkIntervalMs);
  handle.unref();

  const stop = (): void => {
    if (!handle.cancelled) handle.cancel();
  };

  return { monitor: { stop }, stop };
}
