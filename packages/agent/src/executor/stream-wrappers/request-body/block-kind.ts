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

/** The nested record a keyed Bedrock block carries under `key`, if any. */
function keyed(block: unknown, key: string): Record<string, unknown> | undefined {
  return asRecord(asRecord(block)?.[key]);
}

/**
 * The call id a tool_use block carries — `id` on the typed shape, `toolUse.toolUseId` on the keyed
 * one. Undefined when absent, so callers can treat an unidentifiable call conservatively.
 */
export function toolCallId(block: unknown): string | undefined {
  const b = asRecord(block);
  if (!b) return undefined;
  if (typeof b.id === "string") return b.id;
  const id = keyed(b, "toolUse")?.toolUseId;
  return typeof id === "string" ? id : undefined;
}

/** The tool name a tool_use block carries, across both wire shapes. */
export function toolCallName(block: unknown): string | undefined {
  const b = asRecord(block);
  if (!b) return undefined;
  if (typeof b.name === "string") return b.name;
  const name = keyed(b, "toolUse")?.name;
  return typeof name === "string" ? name : undefined;
}

/** The arguments a tool_use block carries, across both wire shapes. */
export function toolCallInput(block: unknown): unknown {
  const b = asRecord(block);
  if (!b) return undefined;
  const nested = keyed(b, "toolUse");
  return nested ? nested.input : b.input;
}

/** Overwrite a tool_use block's arguments in place, writing to whichever shape it uses. */
export function setToolCallInput(block: unknown, value: unknown): void {
  const b = asRecord(block);
  if (!b) return;
  const nested = keyed(b, "toolUse");
  if (nested) nested.input = value;
  else b.input = value;
}

/** The call id a tool_RESULT block refers back to, across both wire shapes. */
export function toolResultCallId(block: unknown): string | undefined {
  const b = asRecord(block);
  if (!b) return undefined;
  if (typeof b.tool_use_id === "string") return b.tool_use_id;
  const id = keyed(b, "toolResult")?.toolUseId;
  return typeof id === "string" ? id : undefined;
}

/**
 * Total length of the text a tool_result block carries, across both wire shapes — the measure that
 * decides whether the result is worth compacting.
 */
export function toolResultTextLength(block: unknown): number {
  const b = asRecord(block);
  if (!b) return 0;
  const nested = keyed(b, "toolResult");
  const content = nested ? nested.content : b.content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce<number>((n, part) => n + blockText(part).length, 0);
}

/**
 * Replace a tool_result block's payload with `placeholder`, preserving the protocol fields the
 * provider validates. On the keyed shape `toolUseId` and `status` MUST survive: a result that loses
 * them no longer pairs with its call and the request is rejected outright.
 */
export function setToolResultPlaceholder(block: unknown, placeholder: string): boolean {
  const b = asRecord(block);
  if (!b) return false;
  const nested = keyed(b, "toolResult");
  if (nested) {
    nested.content = [{ text: placeholder }];
    return true;
  }
  if (b.content === undefined) return false;
  b.content = [{ type: "text", text: placeholder }];
  return true;
}

/**
 * Mint a text block in the SAME wire shape as `sibling`, an existing block of the message it will
 * join.
 *
 * A message's blocks are all one shape, and a provider rejects a block carrying no member it
 * recognises — appending `{type:"text"}` to a Bedrock message is a hard request error, not a
 * degraded read. When the sibling's shape cannot be established, the `type`-discriminated form is
 * the safe default: it is what every non-Bedrock provider on this path expects.
 */
export function makeTextBlockLike(sibling: unknown, text: string): Record<string, unknown> {
  const b = asRecord(sibling);
  const keyDiscriminated = b !== undefined
    && typeof b.type !== "string"
    && BEDROCK_KEY_KINDS.some(([key]) => b[key] !== undefined);
  return keyDiscriminated ? { text } : { type: "text", text };
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
