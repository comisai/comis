// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams Bot Framework `Activity` builders.
 *
 * The Teams emulator drives inbound by PUSHING these builder-produced activities
 * to the daemon's gateway ingress (`POST /channels/msteams/api/messages`), and
 * the scenario proofs round-trip them through the REAL production Teams adapter
 * (`mapMsTeamsActivityToNormalized` / `mapMsTeamsReaction` /
 * `normalizeCardAction`). Because the builders import the adapter's OWN exported
 * `TeamsActivity` / `TeamsReactionActivity` wire interface (`type`-only from the
 * `@comis/channels` barrel; defined in `msteams/message-mapper.ts` +
 * `msteams/msteams-reaction-binder.ts`) and return-annotate against it, every
 * emitted activity is *guaranteed* to be exactly the shape the adapter parses — a
 * wire-shape drift becomes a COMPILE error here, not a silent runtime mismatch.
 * That is the whole point: it forecloses the hand-rolled-struct drift problem.
 * The grammy-typed Telegram twin is `tg-payloads.ts`; the SignalEnvelope-typed
 * Signal twin is `signal-payloads.ts`.
 *
 * Scope (the activity kinds the adapter's inbound path routes — msteams-adapter.ts
 * processEvent):
 *   - `type: "message"`     — the DM/group/channel text round-trip (+ optional
 *     bot @-mention, thread root, and file/image attachments).
 *   - `type: "messageReaction"` — the inbound reaction FLOW (`reactionsAdded`),
 *     mapped by `mapMsTeamsReaction` (like/heart/laugh/surprised/sad/angry).
 *   - `type: "invoke"` (name `"adaptiveCard/action"`) — an Adaptive Card button
 *     click, routed to `normalizeCardAction` (verb `comis.approval.resolve`).
 * Out-of-scope activity kinds (conversationUpdate, typing, …) are deliberately
 * NOT minted — the adapter drops them, so building them would be dead payloads.
 *
 * SECURITY: the `TeamsActivity` / `TeamsReactionActivity` imports are `type`-only
 * (erased at build) so this file carries NO `@comis/*` runtime edge into the
 * never-published harness (`harness-never-published.test.ts`).
 *
 * TEST-HARNESS — lives under `test/`, never `packages`; ZERO production runtime
 * change. The lone product touch (the `type`-only barrel re-export of the
 * reaction wire interface) is VISIBILITY-only — erased at build, no behavior moved.
 *
 * @module
 */

import type { TeamsActivity } from "@comis/channels";

/**
 * The Bot Framework `messageReaction` activity shape — the adapter's shared
 * {@link TeamsActivity} plus the additive `reactionsAdded` list only reaction
 * activities carry (mirrors `TeamsReactionActivity` in
 * `packages/channels/src/msteams/msteams-reaction-binder.ts`). Defined here rather
 * than imported from the barrel so the reaction wire type is NOT a public
 * `@comis/channels` export whose only consumer is this test harness (a dead-export
 * governance violation). The `TeamsActivity` portion is still return-annotated
 * against the adapter's own exported type, so a drift in the shared shape is a
 * compile error; `reactionsAdded` is a trivial, stable local mirror.
 */
type TeamsReactionActivity = TeamsActivity & {
  reactionsAdded?: ReadonlyArray<{ type: string }>;
};

/**
 * The Bot Framework Connector service host that {@link isSafeServiceUrl} admits
 * for the public cloud (msteams-connector.ts:61) — the EXACT host the adapter
 * will POST every outbound activity to. The emulator sets this verbatim on every
 * inbound activity's `serviceUrl` so the outbound send passes the host-allowlist
 * gate UNCHANGED; the daemon's test-only redirect `fetchImpl`
 * (`COMIS_MSTEAMS_TEST_CONNECTOR`) then routes the wire bytes to the loopback
 * emulator AFTER the gate. The trailing slash matches the adapter's
 * `withTrailingSlash` normalization (so it composes `${serviceUrl}v3/...` cleanly).
 */
export const MSTEAMS_CONNECTOR_SERVICE_URL = "https://smba.trafficmanager.net/";

/**
 * A default single-tenant directory id (a GUID) that satisfies the token
 * endpoint's `TENANT_ID_PATTERN` (msteams-auth.ts:123). Interpolated into the
 * `login.microsoftonline.com/${tenantId}/oauth2/v2.0/token` mint URL.
 */
export const MSTEAMS_TEST_TENANT_ID = "00000000-0000-0000-0000-000000000001";

/** The closed set of Teams reaction types the adapter maps (msteams-reaction-binder.ts:36). */
export type TeamsReactionType =
  | "like"
  | "heart"
  | "laugh"
  | "surprised"
  | "sad"
  | "angry";

/** Shared addressing fields every activity builder accepts. */
interface BaseActivityOpts {
  /**
   * The sender's stable AAD directory object id — the adapter PREFERS this as
   * `senderId` (msteams-adapter.ts / message-mapper.ts:195). The allowlist keys
   * on it in `allowMode:"allowlist"`.
   */
  readonly fromAadObjectId: string;
  /** The sender's activity `from.id` (fallback sender id). Defaults to the aadObjectId. */
  readonly fromId?: string;
  /** The sender's display name (`from.name`). Omitted when absent. */
  readonly fromName?: string;
  /**
   * The conversation id — the routing `channelId` (a `;messageid=` suffix, when
   * present, is stripped by the mapper). For a DM this is the 1:1 id; for a
   * channel/group it is the `19:…@thread.tacv2` id.
   */
  readonly conversationId: string;
  /** personal → dm, groupChat → group, channel → channel (message-mapper.ts:120). Defaults to personal. */
  readonly conversationType?: "personal" | "groupChat" | "channel";
  /** The tenant directory id (`channelData.tenant.id`, preferred over conversation.tenantId). Defaults to {@link MSTEAMS_TEST_TENANT_ID}. */
  readonly tenantId?: string;
  /** The bot's recipient id (bot-mention detection targets it). Defaults to a fixed emulator bot id. */
  readonly recipientId?: string;
  /**
   * The Connector service base for the outbound reply (`serviceUrl`). Defaults to
   * {@link MSTEAMS_CONNECTOR_SERVICE_URL} — the allowlisted public-cloud host.
   * Override only to exercise the isSafeServiceUrl reject path.
   */
  readonly serviceUrl?: string;
  /** Explicit activity id (`activity.id`). Defaults to a monotonic emulator id. */
  readonly id?: string;
}

/** The bot recipient id the emulator's activities target (bot-mention detection). */
const DEFAULT_BOT_ID = "28:emulator-bot";

/** Compose the shared activity fields every kind carries (id/from/conversation/recipient/serviceUrl/channelData). */
function baseActivity(opts: BaseActivityOpts): TeamsActivity {
  const tenantId = opts.tenantId ?? MSTEAMS_TEST_TENANT_ID;
  return {
    type: "message",
    id: opts.id ?? nextActivityId(),
    conversation: {
      id: opts.conversationId,
      conversationType: opts.conversationType ?? "personal",
      tenantId,
    },
    from: {
      id: opts.fromId ?? opts.fromAadObjectId,
      aadObjectId: opts.fromAadObjectId,
      ...(opts.fromName !== undefined ? { name: opts.fromName } : {}),
    },
    recipient: { id: opts.recipientId ?? DEFAULT_BOT_ID },
    serviceUrl: opts.serviceUrl ?? MSTEAMS_CONNECTOR_SERVICE_URL,
    // channelData.tenant.id is the PREFERRED tenant source (adapter captureReference
    // reads it first); set it so a proactive-send reference capture succeeds.
    channelData: { tenant: { id: tenantId } },
  };
}

/** Options for {@link makeMessageActivity}. */
export interface MakeMessageActivityOpts extends BaseActivityOpts {
  /** The message body (`activity.text` → `NormalizedMessage.text` after <at>/HTML strip). */
  readonly text: string;
  /**
   * When true, prepend an `<at>` mention span + an `entities[]` mention targeting
   * the bot recipient id, so `detectBotMention` sets `metadata.mentionedBot`.
   */
  readonly mentionBot?: boolean;
  /**
   * The thread root a channel/group reply threads under (`replyToId`). Set only
   * for a non-personal conversation — a DM is always top-level (the mapper drops
   * a DM thread root). Omitted when absent.
   */
  readonly threadRootId?: string;
}

/**
 * Build a Bot Framework `message` activity (the DM/group/channel text round-trip).
 *
 * The return annotation IS the adapter's OWN `TeamsActivity` (the compile-time
 * tripwire): a drift in the wire interface (`message-mapper.ts:34`) fails to
 * compile here. `mentionBot` adds the `<at>` span + `entities[]` the adapter's
 * `detectBotMention` reads; `threadRootId` sets `replyToId` for a channel/group
 * reply (spread only when supplied — exactOptionalPropertyTypes). A DM omits both
 * the thread root and any mention by default.
 */
export function makeMessageActivity(opts: MakeMessageActivityOpts): TeamsActivity {
  const base = baseActivity(opts);
  const recipientId = opts.recipientId ?? DEFAULT_BOT_ID;
  const mentionText = opts.mentionBot === true ? `<at>bot</at> ${opts.text}` : opts.text;
  const isThreaded =
    opts.threadRootId !== undefined && (opts.conversationType ?? "personal") !== "personal";
  return {
    ...base,
    type: "message",
    text: mentionText,
    ...(opts.mentionBot === true
      ? {
          entities: [
            { type: "mention", mentioned: { id: recipientId }, text: "<at>bot</at>" },
          ],
        }
      : {}),
    ...(isThreaded ? { replyToId: opts.threadRootId } : {}),
  };
}

/** Options for {@link makeReactionActivity}. */
export interface MakeReactionActivityOpts extends BaseActivityOpts {
  /** The Teams reaction type (mapped to a Unicode emoji, msteams-reaction-binder.ts:36). */
  readonly reactionType: TeamsReactionType;
  /**
   * The id of the (bot) message being reacted to — the adapter resolves the
   * reaction target as `replyToId ?? id` (msteams-reaction-binder.ts:78). Set as
   * `replyToId` so it names an EXISTING bot activity, not this reaction's own id.
   */
  readonly targetActivityId: string;
}

/**
 * Build a Bot Framework `messageReaction` activity (the inbound reaction FLOW).
 *
 * The return annotation IS the adapter's OWN `TeamsReactionActivity` (the
 * compile-time tripwire): the additive `reactionsAdded` field
 * (`msteams-reaction-binder.ts:28`) plus the shared `TeamsActivity` shape. The
 * mapper reads `reactionsAdded[0].type` (msteams-reaction-binder.ts:72) and the
 * target as `replyToId ?? id` (:78) — both set here.
 */
export function makeReactionActivity(
  opts: MakeReactionActivityOpts,
): TeamsReactionActivity {
  const base = baseActivity(opts);
  return {
    ...base,
    type: "messageReaction",
    replyToId: opts.targetActivityId,
    reactionsAdded: [{ type: opts.reactionType }],
  };
}

/** Options for {@link makeCardActionInvoke}. */
export interface MakeCardActionInvokeOpts extends BaseActivityOpts {
  /**
   * The Adaptive Card action verb (`value.action.verb`). The adapter's approval
   * gate only accepts the rendered `comis.approval.resolve` verb
   * (msteams-actions.ts); pass another to exercise the unrendered-verb drop.
   * Defaults to the approval-resolve verb.
   */
  readonly verb?: string;
  /**
   * The signed callback string (`value.action.data.cb`) the card carried. Opaque
   * to the emulator; the adapter validates the signature. Omitted when absent
   * (exercises the missing-callback drop).
   */
  readonly callback?: string;
}

/**
 * Build a Bot Framework `invoke` activity for an Adaptive Card button click
 * (`name: "adaptiveCard/action"`).
 *
 * The return annotation IS the adapter's OWN `TeamsActivity` — the `name` +
 * `value.action.{verb,data.cb}` fields the adapter's `normalizeCardAction` reads
 * (message-mapper.ts:51-58). The clicker identity is sourced ONLY from the
 * verified `from.aadObjectId` (never from `value`), matching the adapter's
 * default-deny gate.
 */
export function makeCardActionInvoke(opts: MakeCardActionInvokeOpts): TeamsActivity {
  const base = baseActivity(opts);
  return {
    ...base,
    type: "invoke",
    name: "adaptiveCard/action",
    value: {
      action: {
        verb: opts.verb ?? "comis.approval.resolve",
        ...(opts.callback !== undefined ? { data: { cb: opts.callback } } : {}),
      },
    },
  };
}

/** A single inbound attachment descriptor for {@link makeMediaActivity}. */
export interface MakeAttachmentOpts {
  /** MIME type (`contentType` → the normalized attachment type via mimeToAttachmentType). */
  readonly contentType: string;
  /** A hosted-content link needing the Connector Bearer at fetch time. Omitted when a downloadUrl is used. */
  readonly contentUrl?: string;
  /** A pre-authed SharePoint download link (PREFERRED over contentUrl by the mapper). Omitted when absent. */
  readonly downloadUrl?: string;
  /** The original filename (`name` → `fileName`). Omitted when absent. */
  readonly name?: string;
}

/** Options for {@link makeMediaActivity}. */
export interface MakeMediaActivityOpts extends BaseActivityOpts {
  /** Optional caption text alongside the attachment(s). */
  readonly text?: string;
  /** One or more inbound attachments (each rewritten to `msteams-file://` by the mapper). */
  readonly attachments: readonly MakeAttachmentOpts[];
}

/**
 * Build a Bot Framework `message` activity carrying inbound file/media
 * attachments (the media-pipeline round-trip).
 *
 * The return annotation IS the adapter's OWN `TeamsActivity` — the
 * `attachments[]` shape (`message-mapper.ts:68-73`) the mapper rewrites to the
 * `msteams-file://` scheme. Each attachment sets `contentUrl` and/or
 * `content.downloadUrl` (the mapper prefers `content.downloadUrl`).
 */
export function makeMediaActivity(opts: MakeMediaActivityOpts): TeamsActivity {
  const base = baseActivity(opts);
  return {
    ...base,
    type: "message",
    ...(opts.text !== undefined ? { text: opts.text } : {}),
    attachments: opts.attachments.map((att) => ({
      contentType: att.contentType,
      ...(att.contentUrl !== undefined ? { contentUrl: att.contentUrl } : {}),
      ...(att.name !== undefined ? { name: att.name } : {}),
      ...(att.downloadUrl !== undefined
        ? { content: { downloadUrl: att.downloadUrl } }
        : {}),
    })),
  };
}

/**
 * Module-level strictly-monotonic Bot Framework activity-id source.
 *
 * Bot Framework activity ids are opaque strings; the emulator mints an
 * increasing `f:<n>`-shaped id (the leading `f:` mirrors a real Teams activity
 * id) so a suite gets strictly-ordered, path-safe ids
 * (isSafeConversationId-clean — no control chars, no `..`) without managing a
 * counter. The bot's OUTBOUND reply ids are minted separately by the emulator's
 * Connector oracle.
 */
let activityIdCounter = 1_000;

/** Return the next strictly-increasing Bot Framework activity id (`f:<n>`). */
export function nextActivityId(): string {
  activityIdCounter += 1;
  return `f:${activityIdCounter}`;
}

/**
 * Reset the {@link nextActivityId} counter to its base (so the next call returns
 * `f:1001`). For per-test isolation when a suite needs a deterministic sequence.
 */
export function resetActivityIdCounter(): void {
  activityIdCounter = 1_000;
}
