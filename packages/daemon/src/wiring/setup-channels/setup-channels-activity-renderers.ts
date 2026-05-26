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
 *  - DeleteAndRepost (Signal), AppendOnly (iMessage/LINE), LinePerEvent (IRC),
 *    DigestOnly (Email): each wraps its Phase-70 strategy machine over a
 *    per-channel render-actions adapter (Phase 72-01..04; factories barrel-
 *    exported + dispatched here in 72-05). Deps differ per strategy and are
 *    adapted to the uniform factory-map signature: DeleteAndRepost uses
 *    {timer, clock}, LinePerEvent uses {clock}, AppendOnly/DigestOnly use
 *    neither (they read only the fields they need from the passed deps).
 * This completes the §18.3 coverage-matrix wiring: every channelType
 * selectStrategy can route to now produces a live per-channelId factory.
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
  createSignalActivityRenderer,
  createIMessageActivityRenderer,
  createLineActivityRenderer,
  createIrcActivityRenderer,
  createEmailActivityRenderer,
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
 * A closed per-channelType → factory dispatch record. Each factory takes the
 * uniform `(adapter, channelId, deps)` shape; a factory that needs only a subset
 * of `deps` (AppendOnly/DigestOnly need none, LinePerEvent needs only `clock`)
 * is structurally assignable and reads only the fields it uses. Always a finite
 * channelType-keyed record, never an open string-keyed shim (AGENTS.md §2.8).
 */
type RendererFactoryMap = Readonly<
  Record<string, (adapter: ChannelPort, channelId: string, deps: ActivityRendererDeps) => ChannelActivityRenderer>
>;

/**
 * Closed dispatch: each edit-capable channelType → its create<Ch>ActivityRenderer.
 * A `selectStrategy(...) === "EditPlace"` for a channelType NOT in this map is a
 * routing/coverage gap (the renderer is silently skipped) — keep this in lockstep
 * with the EditPlace-routed channels.
 */
const EDIT_PLACE_RENDERER_FACTORIES: RendererFactoryMap = {
  telegram: createTelegramActivityRenderer,
  discord: createDiscordActivityRenderer,
  slack: createSlackActivityRenderer,
  whatsapp: createWhatsAppActivityRenderer,
};

/** DeleteAndRepost → Signal (deleteMessages, no edit). Uses {timer, clock}. */
const DELETE_AND_REPOST_RENDERER_FACTORIES: RendererFactoryMap = {
  signal: createSignalActivityRenderer,
};

/**
 * AppendOnly → iMessage AND LINE (no edit/delete, attachments, mid-range cap) —
 * a single strategy serving TWO channelTypes (Pitfall 6). Neither uses `deps`.
 */
const APPEND_ONLY_RENDERER_FACTORIES: RendererFactoryMap = {
  imessage: createIMessageActivityRenderer,
  line: createLineActivityRenderer,
};

/** LinePerEvent → IRC (no edit/delete, maxMessageChars <= 512). Uses {clock}. */
const LINE_PER_EVENT_RENDERER_FACTORIES: RendererFactoryMap = {
  irc: createIrcActivityRenderer,
};

/** DigestOnly → Email (no edit/delete, largest cap). Uses no `deps`. */
const DIGEST_ONLY_RENDERER_FACTORIES: RendererFactoryMap = {
  email: createEmailActivityRenderer,
};

/**
 * Look the channelType up in a closed strategy→factory map and, if present, set
 * a per-channelId factory that binds the turn-time channelId. Returns whether a
 * factory was set (the `live` flag). A channelType the strategy routed to but
 * that is absent from its map is a coverage gap — silently skipped, surfaced by
 * the composition test, never an open string-keyed shim (AGENTS.md §2.8).
 */
function setFromFactoryMap(
  out: Map<string, ActivityRendererFactory>,
  factories: RendererFactoryMap,
  channelType: string,
  adapter: ChannelPort,
  deps: ActivityRendererDeps,
): boolean {
  const make = factories[channelType];
  if (!make) return false;
  out.set(channelType, (channelId: string) => make(adapter, channelId, deps));
  return true;
}

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
    let live = false;
    if (strategy === "TestSink") {
      // Zero-adapter recorder; ignores channelId.
      activityRenderers.set(channelType, () => createTestSink());
      live = true;
    } else if (strategy === "EditPlace") {
      live = setFromFactoryMap(activityRenderers, EDIT_PLACE_RENDERER_FACTORIES, channelType, adapter, deps);
    } else if (strategy === "DeleteAndRepost") {
      live = setFromFactoryMap(activityRenderers, DELETE_AND_REPOST_RENDERER_FACTORIES, channelType, adapter, deps);
    } else if (strategy === "AppendOnly") {
      live = setFromFactoryMap(activityRenderers, APPEND_ONLY_RENDERER_FACTORIES, channelType, adapter, deps);
    } else if (strategy === "LinePerEvent") {
      live = setFromFactoryMap(activityRenderers, LINE_PER_EVENT_RENDERER_FACTORIES, channelType, adapter, deps);
    } else if (strategy === "DigestOnly") {
      live = setFromFactoryMap(activityRenderers, DIGEST_ONLY_RENDERER_FACTORIES, channelType, adapter, deps);
    }
    logger.debug({ channelType, strategy, live }, "Activity renderer selected");
  }
  return activityRenderers;
}
