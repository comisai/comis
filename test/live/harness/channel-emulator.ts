// SPDX-License-Identifier: Apache-2.0
/**
 * `ChannelEmulator` — the shared, channel-agnostic control-plane contract every
 * per-channel emulator implements.
 *
 * This is the 1-contract analog of the product's `ChannelPort`
 * (packages/core/src/ports/channel.ts) on the EMULATOR side: instead of an
 * adapter that plugs a real platform into Comis, a `ChannelEmulator` is a fake
 * of a real platform's wire surface that the real adapter talks to over
 * loopback HTTP (the same wire-surface symmetry as production). A second channel
 * implements the SAME port unchanged so the harness is additive, not a per-channel rewrite.
 *
 * Scope: the MINIMAL contract surface — `start()`/`stop()` + a
 * `readonly caps` descriptor. `TgEmulator extends ChannelEmulator`
 * (`test/live/emulators/telegram/tg-emulator.ts`) adds the Telegram-specific
 * verbs (`createForumTopic`, the typed inject/read verbs, …) — out of this file's scope.
 *
 * Hard constraint: this file is the SHARED port, so it depends on NOTHING
 * channel-specific — no `grammy`, no `@comis/channels`. It mirrors `ChannelPort`
 * structurally but does not import it (the harness is a consumer of `@comis/*`
 * only from `dist` via the test alias, never the product port type). Telegram
 * specifics live entirely in `tg-emulator.ts`.
 *
 * @module
 */

/**
 * The kinds of inbound media an emulated channel can carry.
 * A closed union so a typo in a caps descriptor is a compile error.
 */
export type MediaKind = "photo" | "voice" | "document" | "video" | "video_note";

/**
 * `ChannelCaps` — the FLAT capability descriptor every emulator publishes.
 *
 * Deliberately flat (`inbound{}` / `outbound{}` / `protocol`) and distinct from
 * the adapter's NESTED `ChannelCapability`
 * (packages/core/src/domain/channel-capability.ts, `features{}`/`limits{}`).
 * `tg-caps.ts` (the drift tripwire) reconciles the overlapping fields between
 * the two shapes; this file only DEFINES this flat
 * emulator-side shape.
 *
 * `protocol` tags the transport class so the right protocol-base backend is
 * chosen (`http` → `backends/http-backend.ts`); Signal/LINE reuse
 * the same `http` base.
 */
export interface ChannelCaps {
  /** The platform this descriptor describes. One of the real channels. */
  channel:
    | "telegram"
    | "discord"
    | "slack"
    | "whatsapp"
    | "signal"
    | "imessage"
    | "line"
    | "irc"
    | "email"
    | "msteams"
    | "matrix";
  /** What the channel can deliver INTO the agent (inbound surface). */
  inbound: {
    text: boolean;
    media: MediaKind[];
    reactions: boolean;
    edits: boolean;
    buttons: boolean;
    threads: boolean;
    slashCommands: boolean;
    location: boolean;
  };
  /** What the agent can push BACK to the channel (outbound surface). */
  outbound: {
    reactions: boolean;
    edits: boolean;
    deletes: boolean;
    buttons: boolean;
    attachments: boolean;
    typing: boolean;
    threads: boolean;
    richCards: boolean;
  };
  /** The wire-protocol class — selects the protocol-base backend. */
  protocol: "http" | "ws" | "tcp" | "subprocess" | "smtp-imap";
}

/**
 * `ChannelEmulator` — the channel-agnostic verbs every emulator shares.
 *
 * `start()` boots the emulator's wire surface on a kernel-allocated loopback
 * port and returns the `apiRoot` the rig writes into the daemon's channel
 * config (the redirect seam) plus the resolved `port`. `stop()` tears the
 * server down. `caps` is the static capability descriptor for feature
 * negotiation + the drift contract.
 *
 * Per-channel emulators EXTEND this with their own typed inject/read verbs
 * (e.g. `TgEmulator` adds `injectMessage` + `outbound()` over the `/control/*`
 * surface). Keeping those off the shared port is deliberate — the
 * read/inject payload types are channel-specific (`RecordedOutbound` is defined
 * with `tg-emulator.ts`).
 */
export interface ChannelEmulator {
  /**
   * Boot the emulator's loopback wire surface.
   * @returns the `apiRoot` (`http://127.0.0.1:<port>`) + the kernel-allocated `port`.
   */
  start(): Promise<{ apiRoot: string; port: number }>;
  /** Tear down the emulator server, releasing the port. */
  stop(): Promise<void>;
  /** Static capability descriptor (feature negotiation + the drift contract). */
  readonly caps: ChannelCaps;
}
