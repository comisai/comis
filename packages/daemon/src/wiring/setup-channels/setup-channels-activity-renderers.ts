// SPDX-License-Identifier: Apache-2.0
/**
 * Build the per-channel activity renderers for the running daemon (§17.7).
 * For each registered adapter, route its declared `ChannelCapability`
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
 *    `ClockPort` (factories barrel-exported by their channel modules).
 *  - DeleteAndRepost (Signal), AppendOnly (iMessage/LINE), LinePerEvent (IRC),
 *    DigestOnly (Email): each wraps its strategy machine over a
 *    per-channel render-actions adapter (factories barrel-exported and
 *    dispatched here). Deps differ per strategy and are
 *    adapted to the uniform factory-map signature: DeleteAndRepost uses
 *    {timer, clock}, LinePerEvent uses {clock}, AppendOnly/DigestOnly use
 *    neither (they read only the fields they need from the passed deps).
 * This completes the §18.3 coverage-matrix wiring: every channelType
 * selectStrategy can route to now produces a live per-channelId factory.
 *
 * NOTE: the activity kill-switch (per-channel runtime toggle + global
 * emergency override) is enforced downstream in the turn coordinator — this
 * function wires the renderer UNCONDITIONALLY (capability-driven only via
 * selectStrategy). Do NOT add any config-toggle gate here; absence is intentional.
 *
 * The returned map feeds the orchestrator's per-turn `coordinatorFactory`
 * (ExecutionPipelineDeps), keyed by channelType. Threading the
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
  ActivityStatusMarkers,
} from "@comis/core";
// (ActivityStatusMarkers also used in the per-call factory signature below.)
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
import type { SignCallbackData, MintApprovalLink } from "@comis/channels";
import type { ComisLogger } from "@comis/infra";

/** A per-channelId renderer factory. The render-actions adapter binds the
 *  concrete channelId at turn time (channelId is unknown at boot).
 *
 *  The OPTIONAL second arg is the per-turn theme markers, resolved
 *  per-agent in the coordinatorFactory from `agents[ctx.agentId]?.activity?.theme`.
 *  When provided it OVERRIDES the boot-time default markers baked into the map at
 *  `buildActivityRenderers` time — so a non-default agent renders with ITS theme,
 *  not the default agent's. Omitted → the boot-time default markers (the
 *  process-wide stream / single-agent case stays byte-identical). */
export type ActivityRendererFactory = (
  channelId: string,
  markers?: ActivityStatusMarkers,
) => ChannelActivityRenderer;

/** System clock + timer injected from the daemon composition root. The
 *  EditPlace machine debounces edits (TimerPort) and gates the delete on
 *  `outcome.delivery.deliveredAtMs` (ClockPort).
 *
 *  `signCallbackData` is the secret-bound signer the button-capable
 *  renderers (Telegram/Discord/Slack/LINE) consume to paint signed approval
 *  `callback_data`; `mintApprovalLink` is the single-use approval-link
 *  minter the Email DigestOnly renderer consumes (it has no buttons). Both are
 *  OPTIONAL: when absent (the signing secret / gateway token map not yet wired),
 *  the renderers degrade to button-/link-less prompts. A renderer reads only the
 *  fields it needs (the uniform-factory contract). */
export interface ActivityRendererDeps {
  timer: TimerPort;
  clock: ClockPort;
  signCallbackData?: SignCallbackData;
  mintApprovalLink?: MintApprovalLink;
  /** Resolved theme status markers forwarded to closing-line strategies.
   *  Resolved ONCE at the composition root from the default agent's
   *  `activity.theme`; omitted → default glyphs. */
  markers?: ActivityStatusMarkers;
}

/** The uniform per-channelId factory every strategy map stores. A factory that
 *  needs only a subset of `deps` (AppendOnly/DigestOnly need none, LinePerEvent
 *  needs only `clock`) is structurally assignable and reads only the fields it
 *  uses. */
type RendererFactory = (adapter: ChannelPort, channelId: string, deps: ActivityRendererDeps) => ChannelActivityRenderer;

/**
 * A CLOSED per-channelType → factory dispatch record, keyed by the precise
 * channelType subset a single strategy serves (`K`). Closing the key type to a
 * finite literal union — never an open `Record<string, …>` (AGENTS.md §2.8) —
 * makes a key typo (`signnal`) or a cross-map duplicate a compile error at the
 * map literal, not a silent runtime miss. Each strategy declares its own `K`
 * (e.g. EditPlace = the four edit-capable channels), so the keys are validated
 * per strategy and stay disjoint across the five maps.
 */
type RendererFactoryMap<K extends string> = Readonly<Record<K, RendererFactory>>;

/** Channel-type key unions, one per strategy — the closed sets `selectStrategy`
 *  can route to each strategy. Adding a channelType to a strategy is a one-line
 *  edit here that `tsc` then forces into the matching map literal. */
type EditPlaceChannel = "telegram" | "discord" | "slack" | "whatsapp";
type DeleteAndRepostChannel = "signal";
type AppendOnlyChannel = "imessage" | "line";
type LinePerEventChannel = "irc";
type DigestOnlyChannel = "email";

/**
 * Closed dispatch: each edit-capable channelType → its create<Ch>ActivityRenderer.
 * A `selectStrategy(...) === "EditPlace"` for a channelType NOT in `EditPlaceChannel`
 * is a routing/coverage gap (the renderer is silently skipped) — keep this and the
 * `EditPlaceChannel` union in lockstep with the EditPlace-routed channels.
 */
const EDIT_PLACE_RENDERER_FACTORIES: RendererFactoryMap<EditPlaceChannel> = {
  telegram: createTelegramActivityRenderer,
  discord: createDiscordActivityRenderer,
  slack: createSlackActivityRenderer,
  whatsapp: createWhatsAppActivityRenderer,
};

/** DeleteAndRepost → Signal (deleteMessages, no edit). Uses {timer, clock}. */
const DELETE_AND_REPOST_RENDERER_FACTORIES: RendererFactoryMap<DeleteAndRepostChannel> = {
  signal: createSignalActivityRenderer,
};

/**
 * AppendOnly → iMessage AND LINE (no edit/delete, attachments, mid-range cap) —
 * a single strategy serving TWO channelTypes. Neither uses `deps`.
 */
const APPEND_ONLY_RENDERER_FACTORIES: RendererFactoryMap<AppendOnlyChannel> = {
  imessage: createIMessageActivityRenderer,
  line: createLineActivityRenderer,
};

/** LinePerEvent → IRC (no edit/delete, maxMessageChars <= 512). Uses {clock}. */
const LINE_PER_EVENT_RENDERER_FACTORIES: RendererFactoryMap<LinePerEventChannel> = {
  irc: createIrcActivityRenderer,
};

/** DigestOnly → Email (no edit/delete, largest cap). Uses no `deps`. */
const DIGEST_ONLY_RENDERER_FACTORIES: RendererFactoryMap<DigestOnlyChannel> = {
  email: createEmailActivityRenderer,
};

/**
 * Look the channelType up in a closed strategy→factory map and, if present, set
 * a per-channelId factory that binds the turn-time channelId. Returns whether a
 * factory was set (the `live` flag). A channelType the strategy routed to but
 * that is absent from its map is a coverage gap — silently skipped, surfaced by
 * the composition test, never an open string-keyed shim (AGENTS.md §2.8).
 */
function setFromFactoryMap<K extends string>(
  out: Map<string, ActivityRendererFactory>,
  factories: RendererFactoryMap<K>,
  channelType: string,
  adapter: ChannelPort,
  deps: ActivityRendererDeps,
): boolean {
  // The runtime channelType is an arbitrary string, so view the closed map as a
  // partial string-keyed lookup: the closed `Record<K, …>` is assignable here,
  // the index yields `RendererFactory | undefined`, and the guard below is real.
  const make = (factories as Readonly<Partial<Record<string, RendererFactory>>>)[channelType];
  if (!make) return false;
  // Per-call markers (per-agent theme, resolved at turn time) override the
  // boot-time default baked into `deps.markers`; omitted → the boot-time default.
  out.set(channelType, (channelId: string, markers?: ActivityStatusMarkers) =>
    make(adapter, channelId, markers ? { ...deps, markers } : deps),
  );
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
    // Exhaustive dispatch over the closed `ActivityStrategy` union (AGENTS.md §2.8):
    // the `never` default makes "added a strategy, forgot to wire it" a compile
    // error rather than a silent `live: false` coverage gap.
    switch (strategy) {
      case "TestSink":
        // Zero-adapter recorder; ignores channelId.
        activityRenderers.set(channelType, () => createTestSink());
        live = true;
        break;
      case "EditPlace":
        live = setFromFactoryMap(activityRenderers, EDIT_PLACE_RENDERER_FACTORIES, channelType, adapter, deps);
        break;
      case "DeleteAndRepost":
        live = setFromFactoryMap(activityRenderers, DELETE_AND_REPOST_RENDERER_FACTORIES, channelType, adapter, deps);
        break;
      case "AppendOnly":
        live = setFromFactoryMap(activityRenderers, APPEND_ONLY_RENDERER_FACTORIES, channelType, adapter, deps);
        break;
      case "LinePerEvent":
        live = setFromFactoryMap(activityRenderers, LINE_PER_EVENT_RENDERER_FACTORIES, channelType, adapter, deps);
        break;
      case "DigestOnly":
        live = setFromFactoryMap(activityRenderers, DIGEST_ONLY_RENDERER_FACTORIES, channelType, adapter, deps);
        break;
      case "Structured":
        // ACP renders its own structured `SessionUpdate` stream, not a
        // `ChannelActivityRenderer`, and carries no ChannelPlugin/capability so it
        // never reaches this loop today (the `caps` guard above `continue`s first).
        // This is an explicit, reviewed no-renderer branch, NOT a silent
        // fall-through (live stays false).
        break;
      default: {
        const _exhaustive: never = strategy;
        void _exhaustive;
      }
    }
    logger.debug({ channelType, strategy, live }, "Activity renderer selected");
  }
  return activityRenderers;
}
