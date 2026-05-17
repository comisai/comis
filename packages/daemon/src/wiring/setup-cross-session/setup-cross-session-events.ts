// SPDX-License-Identifier: Apache-2.0
/**
 * Proxy typing event listener registration for cross-session messaging.
 *
 * Hosts the `typing:proxy_start` / `typing:proxy_stop` event handlers and
 * the TTL sweep timer that the registry orchestrator wires after
 * sub-agent runner construction. The handlers create per-run
 * TypingController instances scoped to the parent-channel adapter and
 * clean up on graceful shutdown.
 *
 * @module
 */

import type { AppContainer, ChannelPort } from "@comis/core";
import { systemNowMs, systemSetInterval, systemClearInterval } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { createTypingController } from "@comis/channels";
import type { TypingController } from "@comis/channels";

/** Per-platform typing refresh intervals (matches inbound-pipeline.ts). */
const PROXY_TYPING_REFRESH: Record<string, number> = {
  telegram: 4000,
  discord: 8000,
  whatsapp: 8000,
  signal: 4000,
  line: 15000,
  imessage: 4000,
};

const PROXY_TTL_MS = 300_000; // 5 min max (matches sub-agent watchdog)
const PROXY_SWEEP_INTERVAL_MS = 60_000; // Sweep every 60s

/**
 * Closure-captured dependencies for the proxy typing event handlers.
 */
export interface ProxyTypingListenerDeps {
  container: AppContainer;
  adaptersByType: Map<string, ChannelPort & { platformAction?(action: string, params: Record<string, unknown>): Promise<unknown> }>;
  logger?: ComisLogger;
}

/**
 * Register the proxy typing event handlers on the daemon event bus. Three
 * listeners are attached:
 *   1. `typing:proxy_start` — create TypingController for parent channel
 *      (no-op when the platform lacks typing support or the runId is already
 *      tracked).
 *   2. `typing:proxy_stop` — stop the controller and remove the entry.
 *   3. `system:shutdown` — stop every active controller + clear the TTL
 *      sweep timer.
 *
 * Additionally schedules a TTL sweep timer that stops any controller older
 * than 5 minutes (mirrors the sub-agent watchdog timeout).
 */
export function registerProxyTypingListeners(deps: ProxyTypingListenerDeps): void {
  const { container, adaptersByType, logger } = deps;

  const proxyControllers = new Map<string, {
    controller: TypingController;
    startedAt: number;
  }>();

  // typing:proxy_start — create TypingController for parent channel
  container.eventBus.on("typing:proxy_start", (evt) => {
    // Skip duplicate proxy for same run
    if (proxyControllers.has(evt.runId)) return;

    // Skip channels without typing support
    const refreshMs = PROXY_TYPING_REFRESH[evt.channelType];
    if (!refreshMs) return;

    const adapter = adaptersByType.get(evt.channelType) as
      | (ChannelPort & { platformAction?(action: string, params: Record<string, unknown>): Promise<unknown> })
      | undefined;
    if (!adapter?.platformAction) return;

    const boundPlatformAction = adapter.platformAction.bind(adapter);
    const controller = createTypingController(
      { mode: "thinking", refreshMs, ttlMs: PROXY_TTL_MS },
      async (chatId: string) => {
        // Pass threadId for forum topic routing
        await boundPlatformAction("sendTyping", { chatId, ...(evt.threadId ? { threadId: evt.threadId } : {}) });
      },
      { warn: (obj: object, msg: string) => logger?.warn(obj, msg) },
    );

    controller.start(evt.channelId);
    proxyControllers.set(evt.runId, {
      controller,
      startedAt: systemNowMs(),
    });

    logger?.debug({
      runId: evt.runId,
      channelType: evt.channelType,
      channelId: evt.channelId,
      agentId: evt.agentId,
    }, "Proxy typing started for sub-agent run");
  });

  // typing:proxy_stop — stop and remove controller
  container.eventBus.on("typing:proxy_stop", (evt) => {
    const entry = proxyControllers.get(evt.runId);
    if (!entry) return;

    entry.controller.stop();
    proxyControllers.delete(evt.runId);

    logger?.debug({
      runId: evt.runId,
      reason: evt.reason,
      durationMs: evt.durationMs,
    }, "Proxy typing stopped for sub-agent run");
  });

  // TTL sweep timer — clean up leaked entries
  const proxySweepTimer = systemSetInterval(() => {
    const now = systemNowMs();
    for (const [runId, entry] of proxyControllers) {
      if (now - entry.startedAt > PROXY_TTL_MS) {
        entry.controller.stop();
        proxyControllers.delete(runId);
        logger?.debug({ runId, reason: "ttl_expired" }, "Proxy typing TTL expired");
      }
    }
  }, PROXY_SWEEP_INTERVAL_MS);
  proxySweepTimer.unref(); // Do not prevent process exit

  // Shutdown cleanup — stop all proxy controllers and clear sweep timer
  container.eventBus.on("system:shutdown", () => {
    systemClearInterval(proxySweepTimer);
    for (const [, entry] of proxyControllers) {
      entry.controller.stop();
    }
    proxyControllers.clear();
  });
}
