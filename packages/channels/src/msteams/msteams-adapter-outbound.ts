// SPDX-License-Identifier: Apache-2.0
/**
 * Pure outbound helpers for the Microsoft Teams adapter.
 *
 * Each function here reads only its arguments — no closure over adapter state,
 * the injected clock, or `deps` — so they live in this sibling module and are
 * unit-tested in isolation, keeping the adapter module within its size budget.
 *
 * @module
 */

import type { AttachmentPayload, SendMessageOptions } from "@comis/core";
import { buildMentionEntities } from "./mentions.js";
import { renderMSTeamsCardAttachment } from "./msteams-rich-renderer.js";

/** Ensure a service base URL ends in a single trailing slash for path composition. */
export function withTrailingSlash(raw: string): string {
  return raw.endsWith("/") ? raw : `${raw}/`;
}

/**
 * Build the outbound text-activity body: rewrite id-shape-valid `@[Name](id)`
 * markup into `<at>…</at>` tags + paired mention entities (text with no valid
 * mention markup is left byte-identical), thread under `replyToId` when present,
 * and attach ONE Adaptive Card only when buttons/cards are present (so a plain
 * text send stays the bare `{ type, text }` shape — no attachments key).
 */
export function buildTextActivityBody(
  text: string,
  replyToId: string | undefined,
  options?: SendMessageOptions,
): Record<string, unknown> {
  const built = buildMentionEntities(text);
  const body: Record<string, unknown> = { type: "message", text: built.text };
  if (built.entities.length > 0) body.entities = built.entities;
  if (replyToId !== undefined) body.replyToId = replyToId;
  const hasButtons = (options?.buttons?.length ?? 0) > 0;
  const hasCards = (options?.cards?.length ?? 0) > 0;
  if (hasButtons || hasCards) {
    body.attachments = [
      renderMSTeamsCardAttachment(options?.cards ?? [], options?.buttons ?? []),
    ];
  }
  return body;
}

/**
 * Build the by-reference text body for a NON-image attachment. Bot Framework
 * renders an inline `data:` URI only for images, so a file/video/audio is
 * delivered as a plain text message naming the caption + filename — the bytes are
 * never read (avoids the multi-MB inline blowup). Threads under `replyToId`.
 */
export function buildAttachmentReferenceBody(
  attachment: AttachmentPayload,
  replyToId: string | undefined,
): Record<string, unknown> {
  const label =
    attachment.fileName !== undefined && attachment.fileName.length > 0
      ? attachment.fileName
      : "a file";
  const referenceText =
    (attachment.caption !== undefined && attachment.caption.length > 0
      ? `${attachment.caption}\n`
      : "") +
    `[${label}] — Teams inline delivery currently supports images only; this attachment is available on the server.`;
  const body: Record<string, unknown> = { type: "message", text: referenceText };
  if (replyToId !== undefined) body.replyToId = replyToId;
  return body;
}

/**
 * Build the image-attachment body: inline the bytes as a `data:` URI (Teams has
 * no separate upload step), carrying the caption as text and the filename as the
 * attachment name when present. Threads under `replyToId`. Neither the bytes nor
 * the data URI are ever logged (T-5) — they live only on the returned body.
 */
export function buildImageActivityBody(
  bytes: Buffer,
  attachment: AttachmentPayload,
  replyToId: string | undefined,
): Record<string, unknown> {
  const mime = attachment.mimeType ?? "image/png";
  const body: Record<string, unknown> = {
    type: "message",
    ...(attachment.caption ? { text: attachment.caption } : {}),
    attachments: [
      {
        contentType: mime,
        contentUrl: `data:${mime};base64,${bytes.toString("base64")}`,
        ...(attachment.fileName ? { name: attachment.fileName } : {}),
      },
    ],
  };
  if (replyToId !== undefined) body.replyToId = replyToId;
  return body;
}

/**
 * Resolve the reply target. A Teams direct message is always sent top-level, so
 * a `dm` chatType forces no replyToId even when the caller supplies one (the
 * delivery layer stamps a reply target on every inbound). Channel and group
 * replies thread under the parent via replyToId; a proactive send with no
 * explicit reply target threads under the stored thread root (channel/group
 * references carry one, a 1:1 does not — so a DM stays top-level).
 */
export function resolveReplyToId(
  options?: SendMessageOptions,
  fallbackThreadId?: string,
): string | undefined {
  // Honor "DM → top-level": never thread a direct message, whatever was passed.
  if (options?.extra?.chatType === "dm") return undefined;
  if (typeof options?.replyTo === "string" && options.replyTo.length > 0) {
    return options.replyTo;
  }
  const fromExtra = options?.extra?.replyToId;
  if (typeof fromExtra === "string" && fromExtra.length > 0) return fromExtra;
  return typeof fallbackThreadId === "string" && fallbackThreadId.length > 0
    ? fallbackThreadId
    : undefined;
}

/** Extract an explicit typing serviceUrl from the action params (direct or under extra). */
export function resolveTypingServiceUrl(
  params: Record<string, unknown>,
): string | undefined {
  const direct =
    typeof params.serviceUrl === "string" ? params.serviceUrl : undefined;
  const extra = params.extra;
  const fromExtra =
    typeof extra === "object" &&
    extra !== null &&
    typeof (extra as { serviceUrl?: unknown }).serviceUrl === "string"
      ? (extra as { serviceUrl: string }).serviceUrl
      : undefined;
  return direct ?? fromExtra;
}
