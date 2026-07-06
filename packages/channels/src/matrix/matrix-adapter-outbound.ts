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
