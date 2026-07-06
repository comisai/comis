// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chat classic interaction-event builders.
 *
 * The Google Chat emulator drives inbound by ENQUEUEING these builder-produced
 * events onto its fake Pub/Sub subscription; the real production pull loop pulls
 * them (base64-decoded from `receivedMessages[].message.data`), and the scenario
 * proof round-trips them through the REAL production adapter
 * (`mapGoogleChatEventToNormalized` / `normalizeGoogleChatCardAction`). Because
 * the message/attachment builders import the adapter's OWN exported
 * `GoogleChatEvent` wire interface (`type`-only from the `@comis/channels` barrel;
 * defined in `googlechat/message-mapper.ts`) and return-annotate against it, every
 * emitted MESSAGE event is *guaranteed* to be exactly the shape the adapter parses
 * — a wire-shape drift becomes a COMPILE error here, not a silent runtime
 * mismatch. That forecloses the hand-rolled-struct drift problem. The grammy-typed
 * Telegram twin is `tg-payloads.ts`; the TeamsActivity-typed Teams twin is
 * `msteams-payloads.ts`.
 *
 * Scope (the event kinds the adapter's inbound path routes — googlechat-adapter.ts
 * handleChatEvent):
 *   - `type: "MESSAGE"`      — the space/DM text round-trip (+ optional mention,
 *     thread root, and an `attachmentDataRef` media attachment).
 *   - `type: "CARD_CLICKED"` — a Cards v2 button click, routed to
 *     `normalizeGoogleChatCardAction` (the rendered `comis.approval.resolve` verb).
 * Out-of-scope event kinds (ADDED_TO_SPACE, REMOVED_FROM_SPACE, …) are deliberately
 * NOT minted — the adapter maps them to null, so building them would be dead
 * payloads.
 *
 * SECURITY: the `GoogleChatEvent` import is `type`-only (erased at build) so this
 * file carries NO `@comis/*` runtime edge into the never-published harness.
 *
 * TEST-HARNESS — lives under `test/`, never `packages`; ZERO production runtime
 * change.
 *
 * @module
 */

import type { GoogleChatEvent } from "@comis/channels";

/**
 * The action-method name the approval card renders on its Cards v2 buttons — the
 * only method in the adapter's rendered set (googlechat-actions.ts
 * `RENDERED_FUNCTIONS`). A click naming any other method is dropped before it
 * becomes a message; the scenario proof round-trips this verb through the real
 * adapter, so a drift in the rendered set fails there. Kept a local const because
 * the adapter does not export it on the `@comis/channels` barrel (its only
 * consumer would be this harness — a dead-export governance violation).
 */
export const GOOGLECHAT_APPROVAL_FUNCTION = "comis.approval.resolve";

/**
 * Minimal CARD_CLICKED interaction-event shape — the fields the adapter's
 * `normalizeGoogleChatCardAction` reads. Defined here rather than imported from
 * the barrel because the adapter does not export its `GoogleChatCardClickEvent`
 * type (its only consumer would be this harness). The MESSAGE builders below
 * still return-annotate against the adapter's exported `GoogleChatEvent`, so the
 * MESSAGE wire shape is compile-checked; the CARD_CLICKED shape is a small, stable
 * local mirror validated end-to-end by the scenario round-trip.
 */
export interface GoogleChatCardClickEvent {
  /** Event kind — always "CARD_CLICKED" here. */
  type: "CARD_CLICKED";
  /** The acting user; the ONLY source of the verified clicker id. */
  user?: { name?: string };
  /** The space the click happened in ("spaces/AAAA"). */
  space?: { name?: string };
  /** The clicked card message ("spaces/AAAA/messages/CCCC") — the pull-loop dedup key. */
  message?: { name?: string };
  /** Classic click payload: the invoked method plus a `{key,value}` parameter list. */
  action?: {
    actionMethodName?: string;
    parameters?: Array<{ key?: string; value?: string }>;
  };
  /** Newer click payload: the same invoked method plus a keyed parameter map. */
  common?: {
    invokedFunction?: string;
    parameters?: Record<string, string>;
  };
}

/**
 * Module-level strictly-monotonic event-id source.
 *
 * Chat message resource names are opaque; the emulator mints an increasing suffix
 * so a suite gets strictly-ordered message names (`spaces/X/messages/<n>`) without
 * managing a counter. The Pub/Sub ackIds are minted separately by the emulator.
 */
let eventIdCounter = 1_000;

/** Return the next strictly-increasing event id (used to mint message resource names). */
export function nextEventId(): number {
  eventIdCounter += 1;
  return eventIdCounter;
}

/**
 * Reset the {@link nextEventId} counter to its base (so the next call returns
 * 1001). For per-test isolation when a suite needs a deterministic sequence.
 */
export function resetEventIdCounter(): void {
  eventIdCounter = 1_000;
}

/** Options for {@link makeMessageEvent}. */
export interface MakeMessageEventOpts {
  /** The space resource name — the routing `channelId` ("spaces/AAAA"). */
  readonly space: string;
  /** The immutable sender resource id ("users/123") — the allowlist key. */
  readonly user: string;
  /** The thread resource name a reply threads under ("spaces/AAAA/threads/T"). Omitted when absent. */
  readonly thread?: string;
  /**
   * DIRECT_MESSAGE → a "dm" chatType (isGroup false); anything else is a "group"
   * space. Defaults to SPACE (a multi-person space → group).
   */
  readonly spaceType?: "SPACE" | "DIRECT_MESSAGE" | "GROUP_CHAT";
  /** When true, add a USER_MENTION annotation so the mapper flags `wasMentioned`. */
  readonly mentioned?: boolean;
  /** Explicit message resource name (the pull-loop dedup key). Defaults to a monotonic emulator name. */
  readonly name?: string;
}

/**
 * Build a classic Chat `MESSAGE` interaction event (the space/DM text round-trip).
 *
 * The return annotation IS the adapter's OWN `GoogleChatEvent` (the compile-time
 * tripwire): a drift in the wire interface (`message-mapper.ts`) fails to compile
 * here. The text is set on BOTH `text` and `argumentText` (the mapper prefers
 * `argumentText`, the mention-stripped form). `thread` sets `message.thread.name`;
 * `mentioned` adds the `USER_MENTION` annotation the mapper reads.
 */
export function makeMessageEvent(
  text: string,
  opts: MakeMessageEventOpts,
): GoogleChatEvent {
  const name = opts.name ?? `${opts.space}/messages/${nextEventId()}`;
  const spaceType = opts.spaceType ?? "SPACE";
  return {
    type: "MESSAGE",
    eventTime: "2026-01-01T00:00:00Z",
    user: { name: opts.user },
    space: { name: opts.space, spaceType },
    message: {
      name,
      sender: { name: opts.user },
      text,
      // The platform strips the app mention into argumentText; set it so the
      // mapper's preferred field carries the faithful command text.
      argumentText: text,
      space: { name: opts.space, spaceType },
      ...(opts.thread !== undefined ? { thread: { name: opts.thread } } : {}),
      ...(opts.mentioned === true
        ? { annotations: [{ type: "USER_MENTION" }] }
        : {}),
    },
  };
}

/** Options for {@link makeAttachmentEvent}. */
export interface MakeAttachmentEventOpts {
  /** The space resource name — the routing `channelId` ("spaces/AAAA"). */
  readonly space: string;
  /** The immutable sender resource id ("users/123"). */
  readonly user: string;
  /**
   * The downloadable attachment resource name (`attachmentDataRef.resourceName`)
   * the mapper rewrites to a `googlechat-attachment://` ref. Present here → the
   * attachment is surfaced (not skipped).
   */
  readonly resourceName: string;
  /** MIME type (`contentType` → the normalized attachment type). Defaults to image/png. */
  readonly contentType?: string;
  /** The original filename (`contentName` → `fileName`). Defaults to file.png. */
  readonly contentName?: string;
  /** Optional caption text alongside the attachment. */
  readonly text?: string;
  /** Explicit message resource name (the pull-loop dedup key). Defaults to a monotonic emulator name. */
  readonly name?: string;
}

/**
 * Build a classic Chat `MESSAGE` event carrying an inbound `attachmentDataRef`
 * attachment (the media-pipeline round-trip).
 *
 * The return annotation IS the adapter's OWN `GoogleChatEvent` — the `attachment[]`
 * shape (SINGULAR field name, `message-mapper.ts`) the mapper rewrites to the
 * `googlechat-attachment://` scheme. The attachment carries a downloadable
 * `attachmentDataRef.resourceName`, so it is surfaced rather than skipped.
 */
export function makeAttachmentEvent(
  opts: MakeAttachmentEventOpts,
): GoogleChatEvent {
  const name = opts.name ?? `${opts.space}/messages/${nextEventId()}`;
  const contentType = opts.contentType ?? "image/png";
  const contentName = opts.contentName ?? "file.png";
  return {
    type: "MESSAGE",
    eventTime: "2026-01-01T00:00:00Z",
    user: { name: opts.user },
    space: { name: opts.space, spaceType: "SPACE" },
    message: {
      name,
      sender: { name: opts.user },
      ...(opts.text !== undefined ? { text: opts.text, argumentText: opts.text } : {}),
      space: { name: opts.space, spaceType: "SPACE" },
      attachment: [
        {
          name: `${name}/attachments/0`,
          contentName,
          contentType,
          source: "UPLOADED_CONTENT",
          attachmentDataRef: { resourceName: opts.resourceName },
        },
      ],
    },
  };
}

/** Options for {@link makeCardClickedEvent}. */
export interface MakeCardClickedEventOpts {
  /** The space the click happened in ("spaces/AAAA"). */
  readonly space: string;
  /** The verified clicker resource id ("users/123") — the only source of identity. */
  readonly user: string;
  /**
   * The opaque signed callback (`common.parameters.cb` + the classic
   * `action.parameters[cb]`). Opaque to the emulator; the adapter validates the
   * signature downstream. Set `undefined` to exercise the missing-callback drop.
   * Defaults to a fixed non-empty blob.
   */
  readonly callback?: string;
  /**
   * The invoked action-method. Defaults to the rendered {@link GOOGLECHAT_APPROVAL_FUNCTION};
   * pass another to exercise the unrendered-method drop.
   */
  readonly invokedFunction?: string;
  /** The clicked card message resource name (also the pull-loop dedup key). Defaults to a monotonic emulator name. */
  readonly messageName?: string;
}

/**
 * Build a `CARD_CLICKED` interaction event (a Cards v2 button click).
 *
 * The event carries the invoked function + the opaque callback in BOTH the classic
 * `action` object and the newer `common` object (the adapter reads either), and
 * the clicker identity ONLY on the verified `user.name` — never a parameter,
 * matching the adapter's default-deny gate. `callback: undefined` omits the cb
 * (the missing-callback drop probe); a non-rendered `invokedFunction` exercises
 * the unrendered-method drop. Round-tripped end-to-end through the real adapter in
 * the scenario proof.
 */
export function makeCardClickedEvent(
  opts: MakeCardClickedEventOpts,
): GoogleChatCardClickEvent {
  const fn = opts.invokedFunction ?? GOOGLECHAT_APPROVAL_FUNCTION;
  const cb = "callback" in opts ? opts.callback : "signed-cb-blob";
  const messageName =
    opts.messageName ?? `${opts.space}/messages/${nextEventId()}`;
  return {
    type: "CARD_CLICKED",
    user: { name: opts.user },
    space: { name: opts.space },
    message: { name: messageName },
    action: {
      actionMethodName: fn,
      ...(cb !== undefined ? { parameters: [{ key: "cb", value: cb }] } : {}),
    },
    common: {
      invokedFunction: fn,
      ...(cb !== undefined ? { parameters: { cb } } : {}),
    },
  };
}
