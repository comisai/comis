// SPDX-License-Identifier: Apache-2.0
/**
 * WIRE-02 (§17.7): build the per-channel activity renderers for the running
 * daemon. For each registered adapter, route its declared `ChannelCapability`
 * to a rendering strategy via `selectStrategy(caps, channelType)` (@comis/core)
 * and construct the matching @comis/channels strategy.
 *
 * The map VALUE is a per-`channelId` factory `(channelId) => ChannelActivityRenderer`,
 * not a pre-bound renderer. `buildActivityRenderers` runs once at boot per
 * channelType, but the EditPlace render-actions adapter (`make<Ch>RenderActions`)
 * needs the concrete `channelId` to address `sendMessage`/`editMessage`/
 * `deleteMessage` — and a single channelType serves many channelIds. The
 * per-turn `channelId` is known downstream (TurnActivityContext.channelKey =
 * effectiveMsg.channelId, execution-pipeline.ts), so the value defers channelId
 * binding to turn time. TestSink also goes through the factory (it ignores
 * channelId — it is a zero-adapter recorder).
 *
 * Live strategies:
 *  - Echo→TestSink: needs no platform `ActivityRenderActions` (send/edit/delete).
 *  - EditPlace: Telegram/Discord/Slack/WhatsApp wrap `createEditPlaceRenderer`
 *    over a per-channel render-actions adapter + the injected `TimerPort`/
 *    `ClockPort` (Phase 71-02/03/04; factories barrel-exported in 71-05).
 * The DeleteAndRepost/AppendOnly/LinePerEvent/DigestOnly strategies bind their
 * per-channel adapters in a later phase; adding one is a one-branch change here.
 *
 * NOTE: the activity kill-switch (per-channel runtime toggle + global
 * emergency override) is enforced in a later phase — this function wires the
 * renderer UNCONDITIONALLY (capability-driven only via selectStrategy). Do NOT
 * add any config-toggle gate here; absence is intentional.
 *
 * The returned map feeds the orchestrator's per-turn `coordinatorFactory`
 * (ExecutionPipelineDeps, WIRE-03), keyed by channelType. Threading the
 * factory map through `coordinatorFactory`/execDeps so a live production turn
 * drives the EditPlace renderer is the documented follow-on.
 *
 * Extracted from setup-channels-runtime.ts to keep that composition file within
 * its 600-line subdirectory cap.
 *
 * @module
 */
import type {
  ChannelPort,
  ChannelPluginPort,
  ChannelActivityRenderer,
  ClockPort,
  TimerPort,
} from "@comis/core";
import { selectStrategy } from "@comis/core";
import {
  createTestSink,
  createTelegramActivityRenderer,
  createDiscordActivityRenderer,
  createSlackActivityRenderer,
  createWhatsAppActivityRenderer,
} from "@comis/channels";
import type { ComisLogger } from "@comis/infra";

/** A per-channelId renderer factory. The render-actions adapter binds the
 *  concrete channelId at turn time (channelId is unknown at boot). */
export type ActivityRendererFactory = (channelId: string) => ChannelActivityRenderer;

/** System clock + timer injected from the daemon composition root. The
 *  EditPlace machine debounces edits (TimerPort) and gates the delete on
 *  `outcome.delivery.deliveredAtMs` (ClockPort). */
export interface ActivityRendererDeps {
  timer: TimerPort;
  clock: ClockPort;
}

/**
 * Closed dispatch: each edit-capable channelType → its create<Ch>ActivityRenderer.
 * A `selectStrategy(...) === "EditPlace"` for a channelType NOT in this map is a
 * routing/coverage gap (the renderer is silently skipped) — keep this in lockstep
 * with the EditPlace-routed channels. Closed dispatch: a finite channelType→factory
 * record, never an open string-keyed shim.
 */
const EDIT_PLACE_RENDERER_FACTORIES: Readonly<
  Record<string, (adapter: ChannelPort, channelId: string, deps: ActivityRendererDeps) => ChannelActivityRenderer>
> = {
  telegram: createTelegramActivityRenderer,
  discord: createDiscordActivityRenderer,
  slack: createSlackActivityRenderer,
  whatsapp: createWhatsAppActivityRenderer,
};

/**
 * Select + construct the live per-channel activity renderer factories, keyed by
 * channelType. Logs the chosen strategy per channel (and whether it is live).
 * Channels with no declared capabilities are skipped.
 */
export function buildActivityRenderers(
  adaptersByType: Map<string, ChannelPort>,
  channelPlugins: Map<string, ChannelPluginPort>,
  logger: ComisLogger,
  deps: ActivityRendererDeps,
): Map<string, ActivityRendererFactory> {
  const activityRenderers = new Map<string, ActivityRendererFactory>();
  for (const [channelType, adapter] of adaptersByType) {
    const caps = channelPlugins.get(channelType)?.capabilities;
    if (!caps) continue;
    const strategy = selectStrategy(caps, channelType);
    if (strategy === "TestSink") {
      // Zero-adapter recorder; ignores channelId.
      activityRenderers.set(channelType, () => createTestSink());
    } else if (strategy === "EditPlace") {
      const make = EDIT_PLACE_RENDERER_FACTORIES[channelType];
      if (make) {
        activityRenderers.set(channelType, (channelId: string) => make(adapter, channelId, deps));
      }
    }
    logger.debug(
      { channelType, strategy, live: strategy === "TestSink" || strategy === "EditPlace" },
      "Activity renderer selected",
    );
  }
  return activityRenderers;
}
