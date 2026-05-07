// SPDX-License-Identifier: Apache-2.0
//
// Test-only helpers for substituting the provider's stream/fetch function.
// Mirrors the substitution-discipline pattern at
// packages/agent/src/executor/fault-injector.ts:48-103.
//
// NOT a production code path. Lives in __test-helpers/ to be visible to
// co-located *.test.ts only.
//
// The binding gate is the **outgoing provider payload**. The pi-ai OpenAI
// Responses converter at
// `node_modules/@mariozechner/pi-ai/dist/providers/openai-responses-shared.js`
// (lines 159-163) reads `msg.content` only — `msg.details` is ignored.
// We replicate that production projection in `projectMessagesToProviderPayload`
// below: a faithful, test-isolated reimplementation that mirrors what
// pi-ai writes onto the wire. Substitution is at the binding gate (the
// converted payload), not upstream of it (no caller-threaded `onPayload`
// config).
//
// We do not import the pi-ai converter directly because pi-ai's package
// exports do not surface `openai-responses-shared.js`. Reimplementing the
// same projection rule (content-only, no details) keeps the test
// hermetic and self-documenting against the canonical contract.
//
// @module

import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { safePath } from "@comis/core";

// ---------------------------------------------------------------------------
// Local message shape (mirrors pi-ai's Message types just enough for the
// projection — we do not depend on pi-ai's runtime since the binding gate
// is the outgoing payload, not pi-ai's internals).
// ---------------------------------------------------------------------------

interface UserMessage {
  role: "user";
  content: string | Array<{ type: "text"; text: string }>;
  timestamp: number;
}

interface AssistantTextBlock { type: "text"; text: string }
interface AssistantToolCall { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
interface AssistantMessage {
  role: "assistant";
  content: Array<AssistantTextBlock | AssistantToolCall>;
  timestamp: number;
}

interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError: boolean;
  timestamp: number;
}

type AnyMessage = UserMessage | AssistantMessage | ToolResultMessage;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CapturingProviderStub {
  /** Marker shape so consumers can pattern-match on it; intentionally minimal. */
  readonly _kind: "capturingProviderStub";
  /** Captured request bodies, in invocation order. */
  readonly captures: ReadonlyArray<unknown>;
  /** The onSend callback the stub fires when invoked via runOneTurnWithProvider. */
  readonly onSend: (body: unknown) => void;
  /** The synthetic assistant response the stub returns when invoked. */
  readonly respondWith: {
    role: "assistant";
    content: Array<{ type: "text"; text: string }>;
    stopReason: "stop";
  };
}

export interface CapturingProviderStubOpts {
  onSend: (body: unknown) => void;
  respondWith: {
    role: "assistant";
    content: Array<{ type: "text"; text: string }>;
    stopReason: "stop";
  };
}

export function createCapturingProviderStub(opts: CapturingProviderStubOpts): CapturingProviderStub {
  return {
    _kind: "capturingProviderStub",
    captures: [],
    onSend: opts.onSend,
    respondWith: opts.respondWith,
  };
}

export interface RunOneTurnWithProviderOpts {
  sessionPath: string;
  provider: CapturingProviderStub;
}

/**
 * Project a session's messages to the outgoing provider payload, mirroring
 * pi-ai's `convertResponsesMessages` content-only rule (see
 * `pi-ai/.../openai-responses-shared.js` lines 159-163). The `details` field
 * on toolResult messages is intentionally NOT included — that is the binding
 * invariant under test.
 */
function projectMessagesToProviderPayload(messages: AnyMessage[]): unknown {
  const out: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : msg.content.map((c) => c.text).join("\n");
      out.push({ role: "user", content: [{ type: "input_text", text }] });
    } else if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "text") {
          out.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: block.text, annotations: [] }],
            status: "completed",
          });
        } else {
          // toolCall
          const [callId, itemId] = block.id.split("|");
          out.push({
            type: "function_call",
            call_id: callId,
            id: itemId,
            name: block.name,
            arguments: JSON.stringify(block.arguments),
          });
        }
      }
    } else {
      // toolResult — content-only projection. `details` is intentionally NOT
      // included.
      const textResult = msg.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const [callId] = msg.toolCallId.split("|");
      out.push({
        type: "function_call_output",
        call_id: callId,
        output: textResult,
      });
    }
  }
  return out;
}

/**
 * Substitute the provider seam for one turn against the seeded session.
 *
 * Reads the JSONL session file at `sessionPath`, projects the messages
 * through `projectMessagesToProviderPayload` (mirrors the production
 * binding gate), and fires the stub's `onSend` callback with the converted
 * payload. Resolves once the synthetic response would be applied (no real
 * LLM call).
 */
export function runOneTurnWithProvider(opts: RunOneTurnWithProviderOpts): Promise<void> {
  const messages = loadSession(opts.sessionPath);
  const converted = projectMessagesToProviderPayload(messages);

  // Fire the stub's capture hook with the converted outgoing payload — this
  // is the production-binding gate.
  opts.provider.onSend(converted);
  // Mutate the captures array (cast through unknown so the readonly hint stays
  // at the public type level — consumers should treat captures as read-only).
  (opts.provider.captures as unknown as unknown[]).push(converted);

  return Promise.resolve();
}

export interface BuildFixtureSessionOpts {
  toolName: string;
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

/**
 * Write a JSONL session file containing a synthetic toolResult message.
 *
 * The session contains one user message + one toolResult message (the
 * shape pi-coding-agent persists post-tool-execution). The toolResult's
 * `details` field carries the augmenter output — the `visibleDelivery`
 * record. The JSONL on disk is byte-faithful to what production writes.
 */
export function buildFixtureSessionWithToolResult(opts: BuildFixtureSessionOpts): Promise<string> {
  // Use a per-call temp dir so concurrent test runs do not collide.
  const baseDir = mkdtempSync(safePath(tmpdir(), "comis-t035-fixture-"));
  const sessionPath = safePath(baseDir, "session.jsonl");

  const userMsg: UserMessage = {
    role: "user",
    content: "test prompt",
    timestamp: 1700000000000,
  };

  const toolResultMsg: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "tc-1|item-1",
    toolName: opts.toolName,
    content: opts.content,
    details: opts.details,
    isError: false,
    timestamp: 1700000000001,
  };

  // JSONL: one message per line. Each line is a complete JSON object.
  // Production sessions persist `details` verbatim; the converter strips
  // it on read. The longCaption in `details.visibleDelivery.caption`
  // is preserved on disk but absent from the converter's outgoing payload.
  const lines = [JSON.stringify(userMsg), JSON.stringify(toolResultMsg)];
  writeFileSync(sessionPath, lines.join("\n") + "\n", "utf-8");

  return Promise.resolve(sessionPath);
}

/**
 * Read a JSONL session file back into a typed message array.
 *
 * Reverses `buildFixtureSessionWithToolResult` — used by tests for
 * belt-and-braces verification of the prompt-assembly read path.
 */
export function loadSession(path: string): AnyMessage[] {
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((l) => JSON.parse(l) as AnyMessage);
}

/**
 * Concatenate visible assistant text from a session.
 *
 * Used by tests for belt-and-braces verification: the prompt-assembly read
 * path projects only `assistant` text content. `toolResult.details` is not
 * part of the visible-text projection — confirms the JSONL-only path.
 */
export function getVisibleAssistantText(session: AnyMessage[]): string {
  const parts: string[] = [];
  for (const msg of session) {
    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push(block.text);
        }
      }
    }
  }
  return parts.join("\n");
}
