// SPDX-License-Identifier: Apache-2.0
/**
 * Pure outbound builders for the Matrix adapter.
 *
 * Each function reads only its arguments — no closure over adapter state, the
 * SDK, or `deps` — so it unit-tests in isolation and keeps the adapter module
 * within its size budget. The markdown→HTML rendering (and its escaping) lives
 * in the shared, separately-tested `format-matrix` module; this builder only
 * assembles the resulting fields into the `m.room.message` content object.
 *
 * @module
 */

import { renderMarkdownToMatrixHtml } from "./format-matrix.js";

/**
 * The `m.room.message` content object for an `m.text` send: the plaintext
 * `body` fallback plus the `org.matrix.custom.html` formatted rendering. Snake
 * -cased to match the Matrix event content wire shape.
 */
export interface MatrixTextMessageContent {
  /** Always `m.text` for a rendered chat message this phase. */
  msgtype: "m.text";
  /** Plaintext fallback for clients that ignore `org.matrix.custom.html`. */
  body: string;
  /** The formatting marker Matrix requires alongside a `formatted_body`. */
  format: "org.matrix.custom.html";
  /** The safe HTML rendering (text-escaped, allowlisted tags only). */
  formatted_body: string;
}

/**
 * Build the `m.room.message` content for a markdown text send.
 *
 * @param markdown - The agent's markdown text.
 * @returns The `m.text` content object carrying both the plaintext `body` and
 *   the `org.matrix.custom.html` `formatted_body`.
 */
export function buildTextMessageContent(markdown: string): MatrixTextMessageContent {
  const { body, formattedBody } = renderMarkdownToMatrixHtml(markdown);
  return {
    msgtype: "m.text",
    body,
    format: "org.matrix.custom.html",
    formatted_body: formattedBody,
  };
}

/**
 * The `m.replace` edit content: the leading-marker fallback (`body` /
 * `formatted_body` a replacement-unaware client shows), the authoritative
 * `m.new_content` replacement message, and the `m.relates_to` naming the edited
 * event. Snake-cased to match the Matrix event content wire shape.
 */
export interface MatrixEditContent {
  /** Always `m.text` for a rendered chat edit. */
  msgtype: "m.text";
  /**
   * Fallback plaintext, prefixed with the leading edit marker so a client that
   * does not apply replacements still shows it and reads it as an edit.
   */
  body: string;
  /** The formatting marker Matrix requires alongside a `formatted_body`. */
  format: "org.matrix.custom.html";
  /** Fallback HTML, likewise prefixed with the leading edit marker. */
  formatted_body: string;
  /** The authoritative replacement message a replacement-aware client renders. */
  "m.new_content": MatrixTextMessageContent;
  /** Relates the edit to the event it replaces. */
  "m.relates_to": {
    /** Always `m.replace` for an edit. */
    rel_type: "m.replace";
    /** The event id this edit replaces. */
    event_id: string;
  };
}

/**
 * Build the `m.replace` edit content for replacing `messageId` with `markdown`.
 *
 * The authoritative new message rides under `m.new_content`, rendered exactly as a
 * fresh send (reusing `buildTextMessageContent`, so the single markdown renderer
 * and its escaping apply). The top-level `body`/`formatted_body` are the fallback a
 * client that does not understand replacements shows; the Matrix convention
 * prefixes them with a leading `* ` marker so they read as an edit. Pure and
 * SDK-free — the caller sends the returned object as an `m.room.message`.
 *
 * @param messageId - The event id being edited (replaced).
 * @param markdown - The new markdown text.
 * @returns The `m.replace` content object.
 */
export function buildEditContent(messageId: string, markdown: string): MatrixEditContent {
  const newContent = buildTextMessageContent(markdown);
  return {
    msgtype: "m.text",
    body: `* ${newContent.body}`,
    format: "org.matrix.custom.html",
    formatted_body: `* ${newContent.formatted_body}`,
    "m.new_content": newContent,
    "m.relates_to": {
      rel_type: "m.replace",
      event_id: messageId,
    },
  };
}

/**
 * The `m.reaction` event content: an `m.annotation` relation to the target event
 * carrying the reaction `key`. Snake-cased to match the Matrix event content wire
 * shape (`m.relates_to` / `rel_type` / `event_id`).
 */
export interface MatrixReactionContent {
  "m.relates_to": {
    /** Always `m.annotation` for a reaction. */
    rel_type: "m.annotation";
    /** The event id the reaction annotates. */
    event_id: string;
    /** The reaction key — the emoji itself (Matrix has no closed reaction vocabulary). */
    key: string;
  };
}

/**
 * Build the `m.reaction` annotation content for reacting to a message.
 *
 * The reaction key is the emoji verbatim: Matrix carries no closed reaction
 * vocabulary, so the emoji passes straight through (mirroring the inbound mapper,
 * where the `m.annotation` key IS the emoji).
 *
 * @param messageId - The target event id the reaction annotates.
 * @param emoji - The reaction key (a Unicode emoji).
 * @returns The `m.annotation` content relating the reaction to its target.
 */
export function buildReactionContent(messageId: string, emoji: string): MatrixReactionContent {
  return {
    "m.relates_to": {
      rel_type: "m.annotation",
      event_id: messageId,
      key: emoji,
    },
  };
}

/**
 * An `m.thread` relation to a thread root, carrying the spec reply fallback so a
 * client that does not render threads still shows the message as a reply to the
 * root. Snake-cased to match the Matrix event content wire shape.
 */
export interface MatrixThreadRelation {
  /** Always `m.thread` for a threaded reply. */
  rel_type: "m.thread";
  /** The thread-root event id the reply hangs under. */
  event_id: string;
  /**
   * `true`: this relation is ALSO a reply fallback. A non-threaded client reads
   * `m.in_reply_to` and renders a plain reply to the root rather than dropping
   * the message.
   */
  is_falling_back: boolean;
  /** The reply-fallback target — the same thread root, for non-threaded clients. */
  "m.in_reply_to": { event_id: string };
}

/**
 * Build the `m.thread` relation for a threaded reply rooted at `threadRootId`.
 *
 * The relation carries the reply fallback (`is_falling_back` + `m.in_reply_to`)
 * so a client that ignores threads still renders the message as a reply to the
 * thread root instead of dropping it. Pure and SDK-free — the caller merges the
 * returned object into the message content under `m.relates_to`.
 *
 * @param threadRootId - The event id of the thread root the reply hangs under.
 * @returns The `m.thread` relation object.
 */
export function buildThreadRelation(threadRootId: string): MatrixThreadRelation {
  return {
    rel_type: "m.thread",
    event_id: threadRootId,
    is_falling_back: true,
    "m.in_reply_to": { event_id: threadRootId },
  };
}

/**
 * The per-event serialized-byte budget an outbound message is chunked against.
 *
 * A Matrix federated PDU is capped at 64 KiB; this budget leaves headroom (of
 * that cap) for the event envelope the homeserver adds around the content the
 * adapter controls. Chunking measures the SERIALIZED content bytes (`body` +
 * `formatted_body` + any relation), not the character count — the HTML
 * `formatted_body` roughly doubles the plaintext, so a char-count-bounded chunk
 * overflows the federation cap on HTML-heavy content and the homeserver rejects
 * the event mid-turn.
 */
export const MATRIX_EVENT_BYTE_BUDGET = 48 * 1024;

/** The serialized byte size of a built content object (UTF-8). */
function contentBytes(content: MatrixTextMessageContent): number {
  return Buffer.byteLength(JSON.stringify(content));
}

/**
 * Whether a candidate markdown slice, once rendered to a content object, fits
 * the budget with room reserved for a relation the caller will merge in.
 */
function sliceFits(markdown: string, budgetBytes: number, relationReserveBytes: number): boolean {
  return contentBytes(buildTextMessageContent(markdown)) + relationReserveBytes <= budgetBytes;
}

/**
 * Hard-split a single token that alone exceeds the budget (a pathological run of
 * non-whitespace, e.g. a very long URL) into per-code-point pieces that each fit.
 * The last resort under the paragraph→line→word hierarchy: only reached when no
 * whitespace boundary is available.
 */
function hardSplitToken(
  token: string,
  budgetBytes: number,
  relationReserveBytes: number,
): string[] {
  const pieces: string[] = [];
  let buf = "";
  for (const ch of token) {
    const candidate = buf + ch;
    if (sliceFits(candidate, budgetBytes, relationReserveBytes)) {
      buf = candidate;
      continue;
    }
    if (buf.length > 0) pieces.push(buf);
    buf = ch;
    // A single code point that cannot fit even alone (a budget smaller than one
    // rendered char) is emitted as-is rather than looping forever.
    if (!sliceFits(buf, budgetBytes, relationReserveBytes)) {
      pieces.push(buf);
      buf = "";
    }
  }
  if (buf.length > 0) pieces.push(buf);
  return pieces;
}

/**
 * Split an outbound markdown message into `m.text` content objects, each bounded
 * by SERIALIZED event bytes (not character count).
 *
 * Each returned content satisfies
 * `Buffer.byteLength(JSON.stringify(content)) + relationReserveBytes <= budgetBytes`,
 * so once the caller merges a reserved-for `m.relates_to` relation into a chunk
 * the resulting event still fits under the federation cap. A message that
 * already fits is returned as exactly ONE content (never over-split); the
 * splitter greedily packs whitespace-delimited tokens (preferring paragraph →
 * line → word boundaries, which fall out of packing tokens with their original
 * separators) and only hard-splits a token that cannot fit alone. An empty chunk
 * is never emitted.
 *
 * The size of each candidate is measured on the RENDERED content, so whatever
 * the markdown renderer does to a slice (HTML expansion, escaping) is counted
 * exactly — the bound holds regardless of markup density.
 *
 * @param markdown - The agent's markdown text.
 * @param budgetBytes - The per-event serialized-byte budget. Defaults to
 *   {@link MATRIX_EVENT_BYTE_BUDGET}.
 * @param relationReserveBytes - Bytes to reserve in every chunk for an
 *   `m.relates_to` relation the caller merges in afterward (0 when none).
 * @returns One or more `m.text` content objects, each within budget.
 */
export function chunkBySerializedBytes(
  markdown: string,
  budgetBytes: number = MATRIX_EVENT_BYTE_BUDGET,
  relationReserveBytes = 0,
): MatrixTextMessageContent[] {
  const text = markdown ?? "";

  // Fast path: a message that already fits is one content — never over-split,
  // even when empty (preserves single-event send behavior for short messages).
  if (sliceFits(text, budgetBytes, relationReserveBytes)) {
    return [buildTextMessageContent(text)];
  }

  // Tokenize keeping the whitespace separators so re-joining reconstructs the
  // text faithfully; splitting only ever falls on a whitespace boundary (or,
  // as a last resort, inside an over-long token).
  const tokens = text.split(/(\s+)/).filter((t) => t.length > 0);
  const slices: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current.trim().length > 0) slices.push(current);
    current = "";
  };

  for (const token of tokens) {
    if (sliceFits(current + token, budgetBytes, relationReserveBytes)) {
      current += token;
      continue;
    }
    // Adding this token overflows the current slice — close it out.
    flush();
    if (sliceFits(token, budgetBytes, relationReserveBytes)) {
      current = token;
      continue;
    }
    // The token alone exceeds the budget: hard-split it, keeping the final
    // piece open so subsequent tokens continue packing into it.
    const pieces = hardSplitToken(token, budgetBytes, relationReserveBytes);
    for (let i = 0; i < pieces.length - 1; i++) slices.push(pieces[i]);
    current = pieces[pieces.length - 1] ?? "";
  }
  flush();

  // Guarantee at least one content (defensive: the fast path already handles a
  // fitting/empty message, so a non-empty over-budget input always yields ≥1).
  const nonEmpty = slices.filter((s) => s.length > 0);
  return (nonEmpty.length > 0 ? nonEmpty : [text]).map(buildTextMessageContent);
}
