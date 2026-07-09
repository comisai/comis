// SPDX-License-Identifier: Apache-2.0
/**
 * Neutralize forged context-boundary markers in ASSISTANT-authored text
 * before it becomes durable, replayable history.
 *
 * Why this exists:
 *   The prompt-assembly layer serializes each inbound turn as reproducible
 *   plaintext — an `[System context]…[End system context]` wrapper
 *   (`executor/prompt-runner/envelope-wrapper.ts`) around an inbound-envelope
 *   header `[<channel>] <senderId> (<time>):` (`envelope/message-envelope.ts`).
 *   That format carries NO unforgeable boundary (unlike external content, which
 *   is fenced with a per-session nonce by `wrapExternalContent`). A model that
 *   has seen dozens of these exemplars in its own context can — and in
 *   production did — reproduce the exact grammar in its OWN output, fabricating
 *   a "next user turn" (e.g. `[telegram] 297133260 (12:11 PM): …`). The SDK
 *   persists the raw completion verbatim, the LCD store ingests it, and the
 *   assembler re-emits it as genuine history — so on the next turn the model
 *   re-reads its own fabrication as a real inbound message and acts on it. The
 *   forgery self-reinforces until an out-of-band signal (a user screenshot)
 *   breaks it.
 *
 * Fix shape (mirrors `wrapExternalContent`'s `replaceMarkers` forge defense):
 *   Model output can never legitimately contain the boundary literals that
 *   frame a real inbound turn — those are produced only by the assembler around
 *   the CURRENT message. So in ASSISTANT-authored text we neutralize:
 *     1. the `[System context]` / `[End system context]` wrapper literals, and
 *     2. any line-start inbound-envelope header `[<channel>] <sender> (<time>):`.
 *   Neutralized text keeps the words (the assistant's prose is preserved for
 *   human readability of the transcript) but loses the STRUCTURAL framing, so it
 *   can no longer masquerade as a turn boundary when replayed.
 *
 * Contracts:
 *   - ROLE-SCOPED: applied ONLY to assistant content. Real user/tool turns
 *     legitimately carry these markers and are never touched.
 *   - PURE + IDEMPOTENT: the sentinels contain none of the matched grammar, so a
 *     second pass is a no-op — the replayed prefix stays byte-stable turn-to-turn
 *     (a non-idempotent rewrite would churn the prompt cache; see the "Unstable
 *     prefix" class in the request-body pipeline).
 *   - RETURN-NEW-ONLY-WHEN-CHANGED: the common (clean) path returns the original
 *     reference unchanged, mirroring `stripRecallFromUserMessage`.
 *
 * @module
 */

import type { Message } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * Sentinels replacing the neutralized markers. They deliberately contain NONE
 * of the matched grammar (no `[System context]` substring, no `[word] … (…):`
 * header shape) so re-running the neutralizer is a fixed point (idempotent).
 */
const STRIPPED_SYSTEM_OPEN = "⟦context-marker stripped: assistant-authored system-context open⟧";
const STRIPPED_SYSTEM_CLOSE = "⟦context-marker stripped: assistant-authored system-context close⟧";
const STRIPPED_INBOUND_HEADER = "⟦inbound-envelope header stripped: assistant-authored⟧";

/**
 * The `[System context]` / `[End system context]` wrapper literals produced at
 * `executor/prompt-runner/envelope-wrapper.ts` (the `[System context]\n…\n[End
 * system context]` template). Kept in sync by
 * `forged-context-markers.envelope-sync.test.ts`, which asserts the real
 * assembler output is caught by these patterns.
 */
const SYSTEM_CONTEXT_OPEN_RE = /\[System context\]/g;
const SYSTEM_CONTEXT_CLOSE_RE = /\[End system context\]/g;

/**
 * Line-start inbound-envelope header `[<channel>] <sender> (<time>):` produced
 * by `wrapInEnvelope` (`envelope/message-envelope.ts:90`,
 * `[${channelType}] ${senderId} (${timeSection}):`). Anchored at a line start
 * (multiline) and requiring the full grammar — a bracketed channel token with
 * NO internal spaces (`[\w-]+`, so it can never match the space-bearing
 * `[System context]`), a sender token, a parenthesized time, and the trailing
 * colon — so ordinary assistant prose does not match. Mirrors the reverse
 * `stripUserSystemContext` regex in `memory/topic-key.ts`.
 */
const INBOUND_ENVELOPE_HEADER_RE = /^[ \t]*\[[\w-]+\][ \t]+\S+[ \t]+\([^)\n]*\):/gm;

/** Result of neutralizing a single text string. */
export interface NeutralizeResult {
  /** The (possibly neutralized) text. Referentially equal to the input when clean. */
  text: string;
  /** Number of forged markers neutralized (0 when clean). */
  strippedCount: number;
}

/**
 * Neutralize forged context-boundary markers in a text string. Pure +
 * idempotent. Returns the ORIGINAL string reference when nothing matched.
 */
export function neutralizeForgedContextMarkers(text: string): NeutralizeResult {
  // Cheap pre-check: skip the regex passes unless a candidate is present. Also
  // preserves the return-same-reference contract for the overwhelmingly common
  // clean case.
  if (
    !text.includes("[System context]") &&
    !text.includes("[End system context]") &&
    !INBOUND_ENVELOPE_HEADER_RE.test(text)
  ) {
    INBOUND_ENVELOPE_HEADER_RE.lastIndex = 0;
    return { text, strippedCount: 0 };
  }
  INBOUND_ENVELOPE_HEADER_RE.lastIndex = 0;

  let strippedCount = 0;
  let out = text.replace(SYSTEM_CONTEXT_OPEN_RE, () => {
    strippedCount += 1;
    return STRIPPED_SYSTEM_OPEN;
  });
  out = out.replace(SYSTEM_CONTEXT_CLOSE_RE, () => {
    strippedCount += 1;
    return STRIPPED_SYSTEM_CLOSE;
  });
  out = out.replace(INBOUND_ENVELOPE_HEADER_RE, () => {
    strippedCount += 1;
    return STRIPPED_INBOUND_HEADER;
  });
  return { text: out, strippedCount };
}

/**
 * Neutralize forged markers in an assistant message's text blocks. Role-scoped:
 * a non-assistant message is returned unchanged. Returns the original message
 * reference when nothing was stripped (so the clean path is allocation-free and
 * the replay prefix stays byte-identical).
 */
export function neutralizeForgedMarkersInMessage(
  m: Message,
): { message: Message; strippedCount: number } {
  if (m.role !== "assistant") return { message: m, strippedCount: 0 };
  const content = (m as { content: unknown }).content;

  if (typeof content === "string") {
    const r = neutralizeForgedContextMarkers(content);
    if (r.strippedCount === 0) return { message: m, strippedCount: 0 };
    // Cast through `unknown`: AssistantMessage.content is typed as a block array,
    // but the SDK permits a string at this boundary (user/legacy shapes) and we
    // preserve whatever shape the message actually had.
    return { message: { ...m, content: r.text } as unknown as Message, strippedCount: r.strippedCount };
  }

  if (Array.isArray(content)) {
    let total = 0;
    let changed = false;
    const next = content.map((b) => {
      if (b && (b as { type?: string }).type === "text" && typeof (b as { text?: unknown }).text === "string") {
        const r = neutralizeForgedContextMarkers((b as { text: string }).text);
        if (r.strippedCount > 0) {
          total += r.strippedCount;
          changed = true;
          return { ...b, text: r.text };
        }
      }
      return b;
    });
    if (!changed) return { message: m, strippedCount: 0 };
    return { message: { ...m, content: next } as unknown as Message, strippedCount: total };
  }

  return { message: m, strippedCount: 0 };
}

/** Result of scrubbing forged markers from a SessionManager's fileEntries. */
export interface ForgedMarkerScrubResult {
  scrubbed: boolean;
  /** Assistant messages that had ≥1 marker neutralized. */
  messagesRewritten: number;
  /** Total markers neutralized across all messages. */
  markersStripped: number;
}

/**
 * Scrub forged context-boundary markers from assistant messages in a
 * SessionManager's in-memory `fileEntries`, mutating in place. Defense-in-depth
 * for the SDK `buildSessionContext` replay path (the LCD ingest path is guarded
 * separately at `executor/lcd-ingest.ts`). Does NOT rewrite the on-disk JSONL —
 * the scrub is for the LLM replay channel only, keeping the JSONL intact as the
 * durable forensic record (mirrors `scrubRedactedToolCalls`). Idempotent:
 * re-running finds nothing to change. Best-effort: silently no-ops on
 * unexpected session-manager shapes. Intended to run right before
 * `buildSessionContext()`.
 */
export function scrubForgedContextMarkers(
  sessionManager: SessionManager,
): ForgedMarkerScrubResult {
  /* eslint-disable @typescript-eslint/no-explicit-any -- SessionManager internals */
  const sm = sessionManager as any;
  const fileEntries = sm?.fileEntries;
  if (!Array.isArray(fileEntries)) {
    return { scrubbed: false, messagesRewritten: 0, markersStripped: 0 };
  }

  let messagesRewritten = 0;
  let markersStripped = 0;
  for (const entry of fileEntries) {
    if (!entry || entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "assistant") continue;
    const { message, strippedCount } = neutralizeForgedMarkersInMessage(msg as Message);
    if (strippedCount > 0) {
      entry.message = message;
      messagesRewritten += 1;
      markersStripped += strippedCount;
    }
  }

  return { scrubbed: markersStripped > 0, messagesRewritten, markersStripped };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
