// SPDX-License-Identifier: Apache-2.0
/** Exact-boundary parser for historical model-facing inbound envelopes. */

import { EXTERNAL_CONTENT_WARNING, unwrapExternalContent } from "@comis/core";
import { stripInlineRecalledMemory } from "@comis/agent";

const SYSTEM_CONTEXT_OPEN = "[System context]";
const SYSTEM_CONTEXT_CLOSE = "[End system context]";
const ENVELOPE_HEADER_RE = /^[ \t]*\[([\w-]+)\][ \t]+(\S+)[ \t]+\(([^)\n]*)\):[ \t]*$/;
const PROVIDER_HIDDEN_HEADER_RE = /^[ \t]*(\S+)[ \t]+\(([^)\n]*)\):[ \t]*$/;
const COALESCER_LINE_RE = /^[ \t]*\[Message \d+\]:/m;
const LINKED_CONTENT_SEPARATOR = "\n\n--- Linked Content ---\n\n";

export interface ParsedSessionEnvelope {
  channelType: string;
  senderId: string;
  envelopeTime: string;
  text: string;
}

/** One fallback candidate whose channel must be established independently. */
export interface SessionEnvelopeCandidate {
  senderId: string | undefined;
  envelopeTime: string | undefined;
  text: string;
}

export type SessionEnvelopeUnparsedReason =
  | "unmatched"
  | "coalescer_candidate";

export interface SessionEnvelopeParseResult {
  envelope: ParsedSessionEnvelope | undefined;
  candidate: SessionEnvelopeCandidate | undefined;
  ambiguous: boolean;
  unparsedReason: SessionEnvelopeUnparsedReason | undefined;
}

/** Return the first nonblank line and the byte offset immediately after it. */
function firstBoundaryLine(scope: string): {
  line: string;
  lineStart: number;
  bodyStart: number;
} | undefined {
  let offset = 0;
  while (offset <= scope.length) {
    const newline = scope.indexOf("\n", offset);
    const lineEnd = newline < 0 ? scope.length : newline;
    const rawLine = scope.slice(offset, lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length > 0) {
      return {
        line,
        lineStart: offset,
        bodyStart: newline < 0 ? scope.length : newline + 1,
      };
    }
    if (newline < 0) return undefined;
    offset = newline + 1;
  }
  return undefined;
}

/** Return the byte offset after an exact standalone marker line. */
function markerBodyStart(scope: string, start: number, marker: string): number | undefined {
  let offset = start;
  while (offset <= scope.length) {
    const newline = scope.indexOf("\n", offset);
    const lineEnd = newline < 0 ? scope.length : newline;
    const rawLine = scope.slice(offset, lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === marker) return newline < 0 ? scope.length : newline + 1;
    if (newline < 0) return undefined;
    offset = newline + 1;
  }
  return undefined;
}

/**
 * Resolve the producer-owned wrapper exactly once. A marker appearing after an
 * envelope header is user body text and can never redirect parsing.
 */
function envelopeScope(text: string): string {
  const initial = firstBoundaryLine(text);
  if (initial !== undefined && ENVELOPE_HEADER_RE.test(initial.line)) return text;
  if (initial === undefined || initial.line.trim() !== SYSTEM_CONTEXT_OPEN) return text;
  const bodyStart = markerBodyStart(text, initial.bodyStart, SYSTEM_CONTEXT_CLOSE);
  return bodyStart === undefined ? text : text.slice(bodyStart);
}

/** Unwrap only a complete producer-generated external-content envelope. */
function unwrapCompleteExternalContent(
  text: string,
  expectedSource: "web_fetch" | "voice_transcription",
): string | undefined {
  const unwrapped = unwrapExternalContent(text);
  if (unwrapped === null || unwrapped.source !== expectedSource) return undefined;
  const startMarker = `<<<UNTRUSTED_${unwrapped.delimiter}>>>`;
  const endMarker = `<<<END_UNTRUSTED_${unwrapped.delimiter}>>>`;
  const start = text.indexOf(startMarker);
  const end = text.lastIndexOf(endMarker);
  if (start < 0 || end < start) return undefined;
  const prefix = text.slice(0, start).trim();
  if (prefix !== "" && prefix !== EXTERNAL_CONTENT_WARNING) return undefined;
  if (text.slice(end + endMarker.length).trim() !== "") return undefined;
  return unwrapped.content;
}

/** Remove model-only enrichments while retaining the physical inbound body. */
function physicalEnvelopeBody(body: string): string {
  const linkedAt = body.lastIndexOf(LINKED_CONTENT_SEPARATOR);
  if (linkedAt >= 0) {
    const originalBody = body.slice(0, linkedAt);
    const linked = body.slice(linkedAt + LINKED_CONTENT_SEPARATOR.length);
    if (
      (originalBody.includes("https://") || originalBody.includes("http://")) &&
      unwrapCompleteExternalContent(linked, "web_fetch") !== undefined
    ) {
      return originalBody;
    }
  }
  const voice = unwrapCompleteExternalContent(body, "voice_transcription");
  return voice?.startsWith("[Voice message transcription]: ") === true
    ? voice
    : body;
}

/**
 * Parse only the first nonblank line at the trusted wrapper boundary. Later
 * header/marker-shaped text remains byte-for-byte body and makes the physical
 * message count ambiguous instead of creating another message.
 */
function parseSessionEnvelopeWithoutRecall(text: string): SessionEnvelopeParseResult {
  const scope = envelopeScope(text);
  const boundary = firstBoundaryLine(scope);
  if (boundary === undefined) {
    return {
      envelope: undefined,
      candidate: undefined,
      ambiguous: false,
      unparsedReason: "unmatched",
    };
  }
  const header = ENVELOPE_HEADER_RE.exec(boundary.line);
  if (header === null) {
    const providerHidden = PROVIDER_HIDDEN_HEADER_RE.exec(boundary.line);
    const candidate = providerHidden === null
      ? {
          senderId: undefined,
          envelopeTime: undefined,
          text: physicalEnvelopeBody(scope.slice(boundary.lineStart)),
        }
      : {
          senderId: providerHidden[1]!,
          envelopeTime: providerHidden[2]!,
          text: physicalEnvelopeBody(scope.slice(boundary.bodyStart)),
        };
    const ambiguous = COALESCER_LINE_RE.test(candidate.text) ||
      candidate.text.includes(SYSTEM_CONTEXT_CLOSE) ||
      candidate.text.split(/\r?\n/).some((line) => ENVELOPE_HEADER_RE.test(line));
    return {
      envelope: undefined,
      candidate,
      ambiguous,
      unparsedReason: COALESCER_LINE_RE.test(scope) ? "coalescer_candidate" : "unmatched",
    };
  }

  const body = physicalEnvelopeBody(scope.slice(boundary.bodyStart));
  const ambiguous = COALESCER_LINE_RE.test(body) ||
    body.includes(SYSTEM_CONTEXT_CLOSE) ||
    body.split(/\r?\n/).some((line) => ENVELOPE_HEADER_RE.test(line));
  return {
    envelope: {
      channelType: header[1]!,
      senderId: header[2]!,
      envelopeTime: header[3]!,
      text: body,
    },
    candidate: undefined,
    ambiguous,
    unparsedReason: undefined,
  };
}

/** Parse a rendered prompt while accepting only a recall prefix before a real envelope. */
export function parseSessionEnvelope(text: string): SessionEnvelopeParseResult {
  const direct = parseSessionEnvelopeWithoutRecall(text);
  const withoutRecall = stripInlineRecalledMemory(text);
  if (withoutRecall === text) return direct;
  const recalled = parseSessionEnvelopeWithoutRecall(withoutRecall);
  return recalled.envelope !== undefined || recalled.candidate?.senderId !== undefined
    ? recalled
    : direct;
}
