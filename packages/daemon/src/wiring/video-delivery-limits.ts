// SPDX-License-Identifier: Apache-2.0
/**
 * DEL-03 (Phase 192 / Plan 03) — the per-channelType video-size limit table +
 * the override-aware resolver + the link-vs-notice support map.
 *
 * THE DEL-03 RECONCILIATION (RESEARCH Open Q3). The design forbids BOTH:
 *   (a) one hardcoded global per-platform byte cap, AND
 *   (b) an invented per-platform byte table baked across the 9 adapter files.
 * The reconciliation is a SINGLE per-channelType table here, where each entry is
 * the platform's DOCUMENTED bot/upload limit (cited inline) — so each channel
 * "owns its real limit" while the degrade DECISION stays at the central delivery
 * site (the poller's `sendAttachment` branch), not scattered across adapters.
 * The per-channel constant is OVERRIDABLE via the media-compressor `maxVideoBytes`
 * config (the operator knob); an UNKNOWN channelType falls back to the same 25 MB
 * default the media-compressor uses (`DEFAULT_COMPRESSION_CONFIG.maxVideoBytes`).
 *
 * THIS IS NOT THE SILENT-DROP PATH. `packages/channels/src/shared/media-compressor.ts`
 * `compressAttachments` REMOVES an oversized attachment and appends an
 * `[Attachment too large]` placeholder — the v2.23 anti-pattern DEL-03 exists to
 * replace (PATTERNS §5b / Pitfall 5). The delivery site consults THIS table and
 * sends a link/notice instead; an oversized clip is NEVER silently dropped.
 *
 * @module
 */

import { isBlockedObjectKey } from "@comis/core";

const MB = 1024 * 1024;

/**
 * The honest conservative default — the media-compressor's `maxVideoBytes`
 * default (`DEFAULT_COMPRESSION_CONFIG.maxVideoBytes = 25 * 1024 * 1024`). Used
 * for an unknown channelType (and as the floor the per-channel constants are
 * cited against). Kept as a literal (not an import) so this daemon-wiring file
 * stays decoupled from the channels package's compression config.
 */
export const DEFAULT_VIDEO_SIZE_LIMIT = 25 * MB;

/**
 * Per-channelType documented bot/upload limit, in bytes. Each entry cites the
 * platform's real limit (DEL-03: per-adapter, not an invented global). These are
 * the HONEST defaults; an operator overrides any of them via the media-compressor
 * `maxVideoBytes` config (passed as the `override` arg to `resolveVideoSizeLimit`).
 *
 * Sources (documented platform limits, conservative where a platform varies):
 *   - telegram  : Bot API `sendVideo` cloud limit ≈ 50 MB (a self-hosted local
 *                 Bot API server allows up to 2 GB, but 50 MB is the default).
 *   - discord   : default (non-boosted) upload limit = 25 MB (raised from 8 MB
 *                 in 2022; boosted servers go higher but 25 MB is the honest floor).
 *   - slack     : file uploads up to ~1 GB, capped CONSERVATIVELY here to 100 MB
 *                 (a clip over 100 MB is link-degraded rather than a slow upload).
 *   - whatsapp  : video message limit ≈ 16 MB.
 *   - line      : Messaging API video send ≈ 200 MB (renders a link reliably).
 *   - signal    : attachment limit ≈ 100 MB.
 *   - imessage  : attachment limit ≈ 100 MB.
 *   - email     : common provider attachment cap ≈ 25 MB (Gmail).
 *   - echo      : the in-tree test/echo adapter — generous (no real platform cap).
 * IRC is intentionally ABSENT: it has no attachment surface (no `sendAttachment`),
 * so it degrades via the DEL-02 capability gate (a notice), never a size check.
 */
export const VIDEO_SIZE_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  telegram: 50 * MB,
  discord: 25 * MB,
  slack: 100 * MB,
  whatsapp: 16 * MB,
  line: 200 * MB,
  signal: 100 * MB,
  imessage: 100 * MB,
  email: 25 * MB,
  echo: 1024 * MB,
});

/**
 * Channels that render a clickable URL message — DEL-03's `link` degrade policy
 * (send the RETAINED provider/workspace path as a message). A channel ABSENT here
 * (and IRC, which has no attachment surface at all) degrades with a `notice`
 * instead. Verified against the per-adapter audit (RESEARCH Open Q4/A4):
 * Discord/Slack/Telegram/LINE/WhatsApp/Signal/iMessage/Email render a link in a
 * text message; IRC does not (notice-only).
 */
const CHANNELS_RENDERING_VIDEO_LINK: Readonly<Record<string, true>> = Object.freeze({
  telegram: true,
  discord: true,
  slack: true,
  line: true,
  whatsapp: true,
  signal: true,
  imessage: true,
  email: true,
});

/**
 * Resolve the video-size limit (bytes) for a channelType.
 *
 *   `override ?? VIDEO_SIZE_LIMITS[channelType] ?? DEFAULT_VIDEO_SIZE_LIMIT`
 *
 * - `override` is the operator's media-compressor `maxVideoBytes` (it WINS — DEL-03
 *   "overridable via maxVideoBytes").
 * - an UNKNOWN channelType (or a proto-pollution key) falls back to the 25 MB
 *   default — NEVER throws, NEVER reads the prototype chain (SEC-04 guard).
 */
export function resolveVideoSizeLimit(channelType: string, override?: number): number {
  if (typeof override === "number" && override > 0) return override;
  if (isBlockedObjectKey(channelType)) return DEFAULT_VIDEO_SIZE_LIMIT;
  // eslint-disable-next-line security/detect-object-injection -- channelType is a platform-internal label, guarded by isBlockedObjectKey above (SEC-04 defense-in-depth); the table is a frozen own-property map.
  const limit = VIDEO_SIZE_LIMITS[channelType];
  return typeof limit === "number" ? limit : DEFAULT_VIDEO_SIZE_LIMIT;
}

/**
 * True when the channel renders a clickable URL message (the `link` degrade
 * policy). Proto-pollution-safe; an unknown channel is conservatively notice-only.
 */
export function channelRendersVideoLink(channelType: string): boolean {
  if (isBlockedObjectKey(channelType)) return false;
  // eslint-disable-next-line security/detect-object-injection -- channelType is a platform-internal label, guarded by isBlockedObjectKey above; the map is a frozen own-property record.
  return CHANNELS_RENDERING_VIDEO_LINK[channelType] === true;
}

/**
 * Human-readable byte formatter for the oversized-degrade notice text (e.g.
 * "50.0 MB", "128 KB"). A local copy of the media-compressor `formatBytes` (that
 * one is module-private + the media-compressor is the silent-drop file we must NOT
 * import the drop logic from). Behavior-identical to the channels formatter.
 */
export function formatVideoBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / (1024 * MB)).toFixed(1)} GB`;
}

/** The DEL-03 degrade policy: `link` where the channel renders a URL and one is
 *  available; otherwise `notice` (the local workspace path). */
export type VideoDegradePolicy = "link" | "notice";

/** The oversized-degrade message + its chosen policy. */
export interface OversizedDegradeMessage {
  text: string;
  policy: VideoDegradePolicy;
}

/**
 * Build the DEL-03 oversized-video degrade message for the delivery site. Where
 * the channel renders links AND a retained provider URL is available, the `link`
 * policy shares that URL; otherwise the `notice` policy carries the local
 * workspace path. EITHER WAY the persisted `filePath` is included so the clip is
 * recoverable, and the text NEVER contains the v2.23 `[Attachment too large]`
 * silent-drop marker (this is the visible-degrade replacement for it).
 */
export function buildOversizedDegradeMessage(args: {
  channelType: string;
  sizeBytes: number;
  limit: number;
  filePath: string;
  sourceUrl?: string;
}): OversizedDegradeMessage {
  const { channelType, sizeBytes, limit, filePath, sourceUrl } = args;
  const sizeStr = formatVideoBytes(sizeBytes);
  const limitStr = formatVideoBytes(limit);
  const link =
    channelRendersVideoLink(channelType) && typeof sourceUrl === "string" && sourceUrl.length > 0
      ? sourceUrl
      : undefined;
  if (link !== undefined) {
    return {
      policy: "link",
      text:
        `Your video (${sizeStr}) exceeds ${channelType}'s ${limitStr} upload limit, ` +
        `so it is shared as a link: ${link}\nSaved to ${filePath}`,
    };
  }
  return {
    policy: "notice",
    text: `Video too large for ${channelType} (${sizeStr} > ${limitStr}); saved to ${filePath}`,
  };
}
