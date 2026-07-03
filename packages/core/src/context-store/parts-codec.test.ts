// SPDX-License-Identifier: Apache-2.0
/**
 * Golden per-provider round-trip + pairing + reasoning-exclusion tests for the
 * LCD parts codec.
 *
 * These fixtures pin the lossless `partsToMessage(messageToParts(msg))`
 * round-trip contract, so a regression cannot be
 * absorbed silently (inline hand-written fixtures, NOT
 * auto-snapshots that `-u` would rubber-stamp).
 *
 * The fixtures build the CANONICAL pi-ai `Message` shape (role `"assistant"`
 * with `{type:"toolCall", id, name, arguments}` content blocks; a TOP-LEVEL role
 * `"toolResult"` message with `toolCallId`/`toolName`/`content`/`isError`) — NOT
 * the assembled provider wire shape. Provider-correct emission is pi-ai's
 * downstream job; this codec's only contract is faithful canonical
 * reconstruction with stable ids. The three provider families therefore share
 * the SAME canonical shape and differ only in the `api`/`provider`/`model`/
 * signature fields (that divergence is pi-ai's concern, not the codec's).
 *
 * The pairing invariant (a reconstructed assistant `ToolCall.id` ===
 * the paired `ToolResultMessage.toolCallId`) is asserted INLINE here: the
 * assembled-shape pairing helper is module-internal to
 * `observability/src/cache-trace/stream-fn-wrapper.ts` and must NOT be
 * imported — the tiny pairing check is replicated below.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import type {
  Message,
  AssistantMessage,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";

import { messageToParts, partsToMessage } from "./parts-codec.js";
import type { LcdMessage, LcdMessagePart } from "../ports/context-store-types.js";

// --- Fixture helpers -------------------------------------------------------

/** A concrete, deterministic Usage block (kept exact so `toEqual` is exact). */
function makeUsage(): Usage {
  return {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Wrap a parts array into a minimal `LcdMessage` row so the codec's READ side
 * (`partsToMessage`) can be driven on the output of the WRITE side
 * (`messageToParts`). The codec reconstructs role/blocks from the parts +
 * `metadata.raw`; the row envelope fields (id/conversationId/seq/tokenCount/
 * createdAt) are queryable projection only and are not part of the canonical
 * Message contract, so concrete throwaway values are fine here.
 */
function rowFromParts(role: LcdMessage["role"], parts: LcdMessagePart[]): LcdMessage {
  return {
    id: "m_test",
    conversationId: "conv_test",
    seq: 0,
    role,
    tokenCount: 0,
    createdAt: 1_700_000_000_000,
    parts,
  };
}

/** Round-trip a single canonical message through messageToParts -> partsToMessage. */
function roundTrip(msg: Message): Message {
  const parts = messageToParts(msg);
  // The reconstructed message role is the pi-ai role of the source message.
  return partsToMessage(rowFromParts(msg.role, parts));
}

/**
 * Inline replica of the tool_use<->tool_result pairing gate (the
 * assembled-shape pairing helper, stream-fn-wrapper.ts:146-206) — NOT imported
 * (module-internal). Collect every assistant `toolCall` id, collect every
 * top-level `toolResult` `toolCallId`, and assert every tool-result id has a
 * matching tool-call id (no orphan, no id drift).
 */
function assertPaired(messages: Message[]): void {
  const toolUseIds = new Set<string>();
  const toolResultIds: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const block of m.content) {
        if (block.type === "toolCall") {
          toolUseIds.add((block as { id: string }).id);
        }
      }
    } else if (m.role === "toolResult") {
      toolResultIds.push((m as ToolResultMessage).toolCallId);
    }
  }
  expect(toolResultIds.length).toBeGreaterThan(0);
  for (const rid of toolResultIds) {
    expect(toolUseIds).toContain(rid);
  }
}

// --- Per-provider canonical fixtures ---------------------------------------
// The SAME canonical shape per family (that is the whole point — provider
// divergence is pi-ai's downstream concern). They differ only in api/provider/
// model + the signature fields each family carries. Each covers: a user text
// message, an assistant message with a stable-id toolCall, the paired top-level
// ToolResultMessage (isError:false), an assistant ThinkingContent reasoning
// block, and an ImageContent (verbatim file fidelity).

const ANTHROPIC_MESSAGES: Message[] = [
  {
    role: "user",
    content: [{ type: "text", text: "read config.yaml" }],
    timestamp: 1_700_000_000_001,
  },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I should read the file first.", thinkingSignature: "sig_think_a" },
      { type: "text", text: "Reading the file now.", textSignature: "sig_text_a" },
      { type: "toolCall", id: "call_abc", name: "read_file", arguments: { path: "config.yaml" }, thoughtSignature: "sig_tc_a" },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-4",
    usage: makeUsage(),
    stopReason: "toolUse",
    timestamp: 1_700_000_000_002,
  } satisfies AssistantMessage,
  {
    role: "toolResult",
    toolCallId: "call_abc",
    toolName: "read_file",
    content: [{ type: "text", text: "port: 8080" }],
    isError: false,
    timestamp: 1_700_000_000_003,
  } satisfies ToolResultMessage,
  {
    role: "user",
    content: [{ type: "image", data: "aGVsbG8taW1hZ2U=", mimeType: "image/png" }],
    timestamp: 1_700_000_000_004,
  },
];

const OPENAI_COMPLETIONS_MESSAGES: Message[] = [
  {
    role: "user",
    content: [{ type: "text", text: "read config.yaml" }],
    timestamp: 1_700_000_001_001,
  },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Reasoning via reasoning_content.", thinkingSignature: "sig_think_oc" },
      { type: "text", text: "Reading the file now." },
      { type: "toolCall", id: "call_oc_1", name: "read_file", arguments: { path: "config.yaml" } },
    ],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4o",
    usage: makeUsage(),
    stopReason: "toolUse",
    timestamp: 1_700_000_001_002,
  } satisfies AssistantMessage,
  {
    role: "toolResult",
    toolCallId: "call_oc_1",
    toolName: "read_file",
    content: [{ type: "text", text: "port: 8080" }],
    isError: false,
    timestamp: 1_700_000_001_003,
  } satisfies ToolResultMessage,
  {
    role: "user",
    content: [{ type: "image", data: "b3BlbmFpLWltYWdl", mimeType: "image/jpeg" }],
    timestamp: 1_700_000_001_004,
  },
];

const OPENAI_RESPONSES_MESSAGES: Message[] = [
  {
    role: "user",
    content: [{ type: "text", text: "read config.yaml" }],
    timestamp: 1_700_000_002_001,
  },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Encrypted reasoning content.", thinkingSignature: "enc_sig_or", redacted: true },
      { type: "text", text: "Reading the file now." },
      { type: "toolCall", id: "fc_or_1", name: "read_file", arguments: { path: "config.yaml" } },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5",
    usage: makeUsage(),
    stopReason: "toolUse",
    timestamp: 1_700_000_002_002,
  } satisfies AssistantMessage,
  {
    role: "toolResult",
    toolCallId: "fc_or_1",
    toolName: "read_file",
    content: [{ type: "text", text: "port: 8080" }],
    isError: false,
    timestamp: 1_700_000_002_003,
  } satisfies ToolResultMessage,
  {
    role: "user",
    content: [{ type: "image", data: "cmVzcG9uc2VzLWltYWdl", mimeType: "image/webp" }],
    timestamp: 1_700_000_002_004,
  },
];

const PROVIDER_FIXTURES: Array<{ name: string; messages: Message[] }> = [
  { name: "anthropic", messages: ANTHROPIC_MESSAGES },
  { name: "openai-completions", messages: OPENAI_COMPLETIONS_MESSAGES },
  { name: "openai-responses", messages: OPENAI_RESPONSES_MESSAGES },
];

// --- Tests -----------------------------------------------------------------

describe("parts-codec — golden per-provider lossless round-trip", () => {
  for (const { name, messages } of PROVIDER_FIXTURES) {
    it(`reconstructs every ${name} canonical message losslessly with stable ids`, () => {
      for (const msg of messages) {
        // The reconstructed visible content of an assistant message must
        // not re-emit the thinking block, so compare the EXPECTED reconstruction
        // (source minus any thinking block) rather than the raw source.
        const expected = stripVisibleReasoning(msg);
        expect(roundTrip(msg)).toEqual(expected);
      }
    });
  }

  it("preserves the stable tool-call id across the round-trip (anthropic call_abc)", () => {
    const assistant = ANTHROPIC_MESSAGES[1] as AssistantMessage;
    const reconstructed = roundTrip(assistant) as AssistantMessage;
    const toolCall = reconstructed.content.find((b) => b.type === "toolCall") as
      | { id: string }
      | undefined;
    expect(toolCall?.id).toBe("call_abc");
  });
});

describe("parts-codec — reasoning exclusion from visible content", () => {
  it("emits a reasoning part marked topLevelReasoningOnly for an assistant thinking block", () => {
    const assistant = ANTHROPIC_MESSAGES[1] as AssistantMessage;
    const parts = messageToParts(assistant);
    const reasoningPart = parts.find((p) => p.kind === "reasoning");
    expect(reasoningPart).toBeDefined();
    expect(reasoningPart!.metadata.topLevelReasoningOnly).toBe(true);
  });

  it("excludes the reasoning block from reconstructed visible content", () => {
    const assistant = ANTHROPIC_MESSAGES[1] as AssistantMessage;
    const reconstructed = roundTrip(assistant) as AssistantMessage;
    const hasThinking = reconstructed.content.some((b) => b.type === "thinking");
    expect(hasThinking).toBe(false);
  });
});

describe("parts-codec — verbatim raw-block capture", () => {
  it("captures a non-undefined metadata.raw deep-equal to the source block for every part", () => {
    const assistant = ANTHROPIC_MESSAGES[1] as AssistantMessage;
    const parts = messageToParts(assistant);
    expect(parts.length).toBe(assistant.content.length);
    parts.forEach((part, i) => {
      expect(part.metadata.raw).toBeDefined();
      expect(part.metadata.raw).toEqual(assistant.content[i]);
    });
  });

  it("captures the whole ToolResultMessage verbatim in the tool_result part metadata.raw", () => {
    const toolResult = ANTHROPIC_MESSAGES[2] as ToolResultMessage;
    const parts = messageToParts(toolResult);
    expect(parts.length).toBe(1);
    expect(parts[0].kind).toBe("tool_result");
    expect(parts[0].metadata.raw).toEqual(toolResult);
  });
});

describe("parts-codec — blockFromPart never yields a sparse block (a sparse block aborts the whole turn)", () => {
  // A stored part whose `metadata.raw` is absent/null (and whose kind has no
  // typed-column reconstruction) MUST NOT decode to an `undefined`/`null`
  // content block. A sparse block crashes every downstream `.type` consumer
  // (token estimator, transcript-repair) inside the LCD assembler's
  // transformContext — BEFORE the LLM call — aborting the whole turn and
  // surfacing to the user as a silent "AI didn't produce a response".
  // Reconstruct from typed columns, or emit a valid empty block.
  it("decodes a raw-ABSENT text part to a valid block (not undefined)", () => {
    const part = { kind: "text", metadata: {} } as unknown as LcdMessagePart;
    const msg = partsToMessage(rowFromParts("assistant", [part]));
    const blocks = msg.content as unknown[];
    expect(Array.isArray(blocks)).toBe(true);
    for (const b of blocks) {
      expect(b == null).toBe(false);
      expect(typeof (b as { type?: unknown }).type).toBe("string");
    }
  });

  it("decodes a raw-NULL part to a valid block (not null)", () => {
    const part = { kind: "text", metadata: { raw: null } } as unknown as LcdMessagePart;
    const msg = partsToMessage(rowFromParts("assistant", [part]));
    for (const b of msg.content as unknown[]) {
      expect(b != null && typeof (b as { type?: unknown }).type === "string").toBe(true);
    }
  });

  it("backfills a raw-absent tool_use part from its typed columns", () => {
    const part = {
      kind: "tool_use",
      toolCallId: "tc_x",
      toolName: "do_it",
      toolInput: { a: 1 },
      metadata: {},
    } as unknown as LcdMessagePart;
    const msg = partsToMessage(rowFromParts("assistant", [part]));
    const tc = (msg.content as Array<{ type: string; id?: string; name?: string }>).find(
      (b) => b.type === "toolCall",
    );
    expect(tc?.id).toBe("tc_x");
    expect(tc?.name).toBe("do_it");
  });
});

describe("parts-codec — stable-id tool-call pairing (inline invariant)", () => {
  it("keeps reconstructed toolCall.id === paired ToolResultMessage.toolCallId (no orphan, no drift)", () => {
    // Reconstruct the full anthropic multi-step turn and assert pairing inline
    // (NOT via the module-internal assembled-shape pairing helper, which must
    // stay unimported).
    const reconstructed = ANTHROPIC_MESSAGES.map((m) =>
      partsToMessage(rowFromParts(m.role, messageToParts(m))),
    );
    assertPaired(reconstructed);

    // Stronger structural form: the reconstructed assistant toolCall id is the
    // reconstructed top-level toolResult toolCallId.
    const asst = reconstructed.find((m) => m.role === "assistant") as AssistantMessage;
    const tr = reconstructed.find((m) => m.role === "toolResult") as ToolResultMessage;
    const tc = asst.content.find((b) => b.type === "toolCall") as { id: string };
    expect(tc.id).toBe(tr.toolCallId);
  });
});

describe("parts-codec — empty-content envelope fidelity", () => {
  // An aborted/errored assistant turn is a realistic shape: stopReason
  // "aborted"/"error" with errorMessage and ZERO content blocks
  // (AssistantMessage.content is (Text|Thinking|ToolCall)[], which admits []).
  // The message-level envelope (api/provider/model/usage/stopReason/
  // errorMessage/timestamp) must survive the round-trip even with no blocks —
  // the round-trip contract drops no field.

  it("preserves the full envelope of an empty-content assistant message (content: [])", () => {
    const empty: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-4",
      usage: makeUsage(),
      stopReason: "stop",
      timestamp: 1_700_000_010_001,
    };
    expect(roundTrip(empty)).toEqual(empty);
  });

  it("preserves stopReason + errorMessage of an aborted/errored empty-content turn", () => {
    const aborted: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5",
      usage: makeUsage(),
      stopReason: "error",
      errorMessage: "upstream provider 529 — turn aborted before any content block",
      timestamp: 1_700_000_010_002,
    };
    const reconstructed = roundTrip(aborted) as AssistantMessage;
    expect(reconstructed.content).toEqual([]);
    expect(reconstructed.stopReason).toBe("error");
    expect(reconstructed.errorMessage).toBe(
      "upstream provider 529 — turn aborted before any content block",
    );
    expect(reconstructed).toEqual(aborted);
  });

  it("emits exactly one envelope-carrying part for an empty-content message (so the store row is not empty)", () => {
    const empty: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-4",
      usage: makeUsage(),
      stopReason: "aborted",
      timestamp: 1_700_000_010_003,
    };
    const parts = messageToParts(empty);
    // A turn always has >=1 part so the envelope has a carrier on read.
    expect(parts.length).toBe(1);
    const { content: _content, ...envelope } = empty;
    expect(parts[0]!.metadata.messageEnvelope).toEqual(envelope);
  });
});

describe("parts-codec — isError + tool input fidelity", () => {
  it("round-trips a tool_result with isError:true preserving the boolean (not coerced/dropped)", () => {
    const errored: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call_err",
      toolName: "read_file",
      content: [{ type: "text", text: "ENOENT: no such file" }],
      isError: true,
      timestamp: 1_700_000_009_001,
    };
    const reconstructed = roundTrip(errored) as ToolResultMessage;
    expect(reconstructed.isError).toBe(true);
    expect(reconstructed).toEqual(errored);
  });

  it("round-trips a tool_result with isError:false preserving the boolean", () => {
    const ok = ANTHROPIC_MESSAGES[2] as ToolResultMessage;
    const reconstructed = roundTrip(ok) as ToolResultMessage;
    expect(reconstructed.isError).toBe(false);
  });

  it("round-trips a toolCall with nested-object arguments deep-equal (JSON lossless)", () => {
    const nested: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_nested",
          name: "configure",
          arguments: {
            server: { host: "example.com", ports: [80, 443], tls: { enabled: true, ciphers: ["a", "b"] } },
            retries: 3,
            flags: { verbose: false },
          },
        },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-4",
      usage: makeUsage(),
      stopReason: "toolUse",
      timestamp: 1_700_000_009_002,
    };
    const reconstructed = roundTrip(nested) as AssistantMessage;
    expect(reconstructed).toEqual(nested);
  });
});

/**
 * Build the EXPECTED reconstruction of a canonical message: identical to the
 * source EXCEPT an assistant message's visible content drops any `thinking`
 * block (reasoning rides as a marked part / metadata, never re-emitted as
 * a visible content block). User + toolResult messages are returned unchanged.
 */
function stripVisibleReasoning(msg: Message): Message {
  if (msg.role !== "assistant") return msg;
  return {
    ...msg,
    content: msg.content.filter((b) => b.type !== "thinking"),
  };
}
