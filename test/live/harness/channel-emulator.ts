// SPDX-License-Identifier: Apache-2.0
/**
 * `ChannelEmulator` — the shared, channel-agnostic control-plane contract every
 * per-channel emulator implements (FOUND-01, Phase 204).
 *
 * This is the 1-contract analog of the product's `ChannelPort`
 * (packages/core/src/ports/channel.ts) on the EMULATOR side: instead of an
 * adapter that plugs a real platform into Comis, a `ChannelEmulator` is a fake
 * of a real platform's wire surface that the real adapter talks to over
 * loopback HTTP (design §3A.2 symmetry). Channel #2 (Phase 209) implements the
 * SAME port unchanged so the harness is additive, not a per-channel rewrite.
 *
 * Scope (Phase 204): the MINIMAL contract surface — `start()`/`stop()` + a
 * `readonly caps` descriptor. `TgEmulator extends ChannelEmulator` (Wave 2,
 * `test/live/emulators/telegram/tg-emulator.ts`) adds the Telegram-specific
 * verbs (`createForumTopic`, the typed inject/read verbs, …) — out of 204 scope.
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
 * The kinds of inbound media an emulated channel can carry (design §3A.4).
 * A closed union so a typo in a caps descriptor is a compile error.
 */
export type MediaKind = "photo" | "voice" | "document" | "video" | "video_note";

/**
 * `ChannelCaps` — the FLAT capability descriptor every emulator publishes
 * (design §3A.4).
 *
 * Deliberately flat (`inbound{}` / `outbound{}` / `protocol`) and distinct from
 * the adapter's NESTED `ChannelCapability`
 * (packages/core/src/domain/channel-capability.ts, `features{}`/`limits{}`).
 * Plan 03 (`tg-caps.ts`, FOUND-03) reconciles the overlapping fields between
 * the two shapes and is the drift tripwire; Plan 01 only DEFINES this flat
 * emulator-side shape.
 *
 * `protocol` tags the transport class so the right protocol-base backend is
 * chosen (`http` → `backends/http-backend.ts`); Signal/LINE in Phase 209 reuse
 * the same `http` base.
 */
export interface ChannelCaps {
  /** The platform this descriptor describes. One of the 9 real channels. */
  channel:
    | "telegram"
    | "discord"
    | "slack"
    | "whatsapp"
    | "signal"
    | "imessage"
    | "line"
    | "irc"
    | "email";
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
 * `ChannelEmulator` — the channel-agnostic verbs every emulator shares
 * (design §4.4).
 *
 * `start()` boots the emulator's wire surface on a kernel-allocated loopback
 * port and returns the `apiRoot` the rig writes into the daemon's channel
 * config (the redirect seam) plus the resolved `port`. `stop()` tears the
 * server down. `caps` is the static capability descriptor for feature
 * negotiation + the FOUND-03 drift contract.
 *
 * Per-channel emulators EXTEND this with their own typed inject/read verbs
 * (e.g. `TgEmulator` adds `injectMessage` + `outbound()` over the `/control/*`
 * surface, Wave 2). Keeping those off the shared port is deliberate — the
 * read/inject payload types are channel-specific (`RecordedOutbound` is defined
 * with `tg-emulator.ts` in Plan 03).
 */
export interface ChannelEmulator {
  /**
   * Boot the emulator's loopback wire surface.
   * @returns the `apiRoot` (`http://127.0.0.1:<port>`) + the kernel-allocated `port`.
   */
  start(): Promise<{ apiRoot: string; port: number }>;
  /** Tear down the emulator server, releasing the port. */
  stop(): Promise<void>;
  /** Static capability descriptor (feature negotiation + FOUND-03 drift contract). */
  readonly caps: ChannelCaps;
}
