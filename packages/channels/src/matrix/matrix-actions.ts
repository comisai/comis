// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix platform-action decoder — pure and transport-free.
 *
 * `platformAction(action, params)` carries an untyped verb + a loose params bag.
 * This module owns the "which action + which params" decision: it validates and
 * extracts the fields each action needs (roomId, topic, eventId) into a closed,
 * discriminated descriptor the adapter switches on. No client, no I/O — the
 * adapter binds the SDK call to the decoded descriptor, so the routing logic
 * unit-tests without a homeserver.
 *
 * A known action missing a required field, or an unknown action, decodes to
 * `unsupported` carrying a secret-free reason — the adapter logs the reject and
 * errs, never silently no-ops.
 *
 * @module
 */

/** The decoded, validated shape of a platform action the adapter can execute. */
export type MatrixActionDecode =
  | { kind: "sendTyping"; roomId: string; typing: boolean }
  | { kind: "join"; roomId: string }
  | { kind: "leave"; roomId: string }
  | { kind: "setTopic"; roomId: string; topic: string; htmlTopic: string | undefined }
  | { kind: "markRead"; roomId: string; eventId: string }
  | { kind: "unsupported"; action: string; reason: string };

/** The first of the candidates that is a non-empty string, else undefined. */
function firstString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return undefined;
}

/** A `string | undefined` read of a params field (never coerces a non-string). */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Decode a platform action + params into a validated {@link MatrixActionDecode}.
 *
 * The room id is resolved from `chatId`, `roomId`, or `channelId` (in that
 * order) — the orchestrator's typing controller passes `chatId`. A known action
 * whose required fields are absent, or an unknown action, decodes to
 * `unsupported`.
 *
 * @param action - The platform-action verb.
 * @param params - The loosely-typed params bag.
 * @returns The decoded descriptor.
 */
export function decodeMatrixAction(
  action: string,
  params: Record<string, unknown>,
): MatrixActionDecode {
  const roomId = firstString(params.chatId, params.roomId, params.channelId);

  switch (action) {
    case "sendTyping":
      // Suppressed during streaming (the streamed text is itself the activity).
      return roomId !== undefined
        ? { kind: "sendTyping", roomId, typing: params.streaming !== true }
        : unsupported(action, "sendTyping requires a room id");

    case "stopTyping":
      return roomId !== undefined
        ? { kind: "sendTyping", roomId, typing: false }
        : unsupported(action, "stopTyping requires a room id");

    case "join":
      return roomId !== undefined
        ? { kind: "join", roomId }
        : unsupported(action, "join requires a room id");

    case "leave":
      return roomId !== undefined
        ? { kind: "leave", roomId }
        : unsupported(action, "leave requires a room id");

    case "setTopic": {
      const topic = optionalString(params.topic);
      return roomId !== undefined && topic !== undefined
        ? { kind: "setTopic", roomId, topic, htmlTopic: optionalString(params.htmlTopic) }
        : unsupported(action, "setTopic requires a room id and a topic");
    }

    case "markRead": {
      const eventId = firstString(params.eventId, params.messageId);
      return roomId !== undefined && eventId !== undefined
        ? { kind: "markRead", roomId, eventId }
        : unsupported(action, "markRead requires a room id and an event id");
    }

    default:
      return unsupported(action, "unknown action");
  }
}

/** Build the `unsupported` descriptor (a known-but-invalid or unknown action). */
function unsupported(action: string, reason: string): MatrixActionDecode {
  return { kind: "unsupported", action, reason };
}
