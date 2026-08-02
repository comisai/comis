// SPDX-License-Identifier: Apache-2.0
/**
 * Canonical content-block kind resolver — one reader for every provider block shape.
 *
 * The request-body pipeline decides what to strip, what to keep byte-stable inside the cache
 * fence, and what to report as a prefix mutation by reading each content block's kind. Two wire
 * shapes reach it:
 *
 *  - **`type`-discriminated** (Anthropic Messages, and the pi-ai canonical form): the kind is the
 *    string in `block.type` — `"text"`, `"thinking"`, `"tool_use"`, …
 *  - **KEY-discriminated** (Bedrock Converse): the block carries NO `type` field at all; the kind
 *    IS the sole key — `{text}`, `{reasoningContent}`, `{toolUse}`, `{toolResult}`, `{cachePoint}`.
 *
 * Reading only `block.type` therefore classifies EVERY Bedrock block as unknown, which silently
 * disables every consumer at once: reasoning is never stripped on replay, no block is ever
 * cache-marker eligible, and the prefix-stability diagnostic reports a mutation it cannot name.
 * That is not a provider quirk to special-case at a call site — it is the shape boundary, so it is
 * resolved once, here, and every consumer reads through it.
 *
 * A block whose kind cannot be established is `"malformed"` (never an object) or `"other"`
 * (an object of no kind this pipeline acts on). Both are inert: consumers must leave them alone
 * rather than guess.
 *
 * @module
 */

/** The canonical kinds this pipeline distinguishes, provider-independent. */
export type BlockKind =
  | "text"
  | "thinking"
  | "redacted_thinking"
  | "tool_use"
  | "tool_result"
  | "image"
  | "cache_marker"
  | "other"
  | "malformed";

/**
 * `type` values that all mean "a tool call". The canonical pi-ai form is `"toolCall"`; the
 * Anthropic wire form is `"tool_use"`; persisted/raw sources also carry `"tool_call"` and
 * `"toolUse"`. Sibling pipeline layers already accept these aliases, so the resolver must too.
 */
const TOOL_CALL_TYPES = new Set(["tool_use", "toolCall", "tool_call", "toolUse"]);

/** `type` values that all mean "a tool result". */
const TOOL_RESULT_TYPES = new Set(["tool_result", "toolResult"]);

/**
 * Bedrock Converse block keys, mapped to canonical kinds. Presence of the key IS the kind — the
 * value is never inspected for classification (a nested `cachePoint.type` is NOT the block's kind).
 */
const BEDROCK_KEY_KINDS: ReadonlyArray<readonly [string, BlockKind]> = [
  ["text", "text"],
  ["reasoningContent", "thinking"],
  ["toolUse", "tool_use"],
  ["toolResult", "tool_result"],
  ["cachePoint", "cache_marker"],
  ["image", "image"],
];

function asRecord(block: unknown): Record<string, unknown> | undefined {
  return typeof block === "object" && block !== null ? block as Record<string, unknown> : undefined;
}

/** True when a Bedrock reasoning block carries ENCRYPTED reasoning rather than plaintext. */
function isRedactedReasoning(reasoning: unknown): boolean {
  const r = asRecord(reasoning);
  return r !== undefined && r.redactedContent !== undefined;
}

/**
 * Resolve a content block's canonical kind across every provider wire shape.
 *
 * `"malformed"` for anything that is not an object — the caller must skip it rather than
 * dereference it. `"other"` for an object carrying no kind this pipeline acts on.
 */
export function blockKind(block: unknown): BlockKind {
  const b = asRecord(block);
  if (!b) return "malformed";

  // `type`-discriminated shapes first: an explicit discriminator always wins over key inference.
  const type = b.type;
  if (typeof type === "string") {
    if (TOOL_CALL_TYPES.has(type)) return "tool_use";
    if (TOOL_RESULT_TYPES.has(type)) return "tool_result";
    if (type === "text") return "text";
    if (type === "thinking") return "thinking";
    if (type === "redacted_thinking") return "redacted_thinking";
    if (type === "image") return "image";
    return "other";
  }

  // KEY-discriminated (Bedrock Converse): the key is the kind.
  for (const [key, kind] of BEDROCK_KEY_KINDS) {
    if (b[key] === undefined) continue;
    if (kind === "thinking" && isRedactedReasoning(b[key])) return "redacted_thinking";
    return kind;
  }

  return "other";
}

/**
 * The plain text a block carries, across every wire shape — `""` when it carries none.
 *
 * Only genuine strings are returned. Rendering a structured field (a tool_result's `content`
 * array) via `String()` yields `"[object Object]"`, which silently inflates any length maths
 * built on this value.
 */
export function blockText(block: unknown): string {
  const b = asRecord(block);
  if (!b) return "";

  if (typeof b.text === "string") return b.text;
  if (typeof b.thinking === "string") return b.thinking;

  // Bedrock reasoning nests the text one level down.
  const reasoning = asRecord(b.reasoningContent);
  if (reasoning) {
    const reasoningText = asRecord(reasoning.reasoningText);
    if (reasoningText && typeof reasoningText.text === "string") return reasoningText.text;
  }

  if (typeof b.content === "string") return b.content;
  return "";
}

/**
 * True when a block is STRIPPABLE reasoning — plaintext thinking in either wire shape.
 *
 * Redacted reasoning is deliberately excluded: it carries the encrypted signature the provider
 * needs to continue the turn, so replay must preserve it.
 */
export function isThinkingBlock(block: unknown): boolean {
  if (blockKind(block) !== "thinking") return false;
  // The Anthropic shape can mark an otherwise-plaintext thinking block as redacted via a flag.
  const b = asRecord(block);
  return (b as { redacted?: boolean } | undefined)?.redacted !== true;
}
