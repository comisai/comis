// SPDX-License-Identifier: Apache-2.0
/**
 * Context (LCD lossless-store) operator-browse RPC contracts. Back the web
 * Context DAG browser (`packages/web/src/views/context-dag-browser.ts`), which
 * previously called these methods via untyped `.call()` against UNREGISTERED
 * handlers (every call returned JSON-RPC -32601 — the view was 100% dead).
 *
 * Handler path: `packages/daemon/src/api/context-handlers.ts`.
 *
 * **Scope (R4).** Both methods are `rpc`-scoped and AGENT+TENANT scoped exactly
 * like `memory.search_files`: the handler reads `_agentId` from the dispatcher-
 * injected internals and `tenantId` from `deps.tenantId`, NEVER widening past
 * one agent within one tenant. The caller cannot pass agentId/tenantId — they
 * ride the request context (WR-02).
 *
 * **Content posture.** `context.conversations` is pure metadata (ids / counts /
 * time-bounds). `context.tree` is the structural DAG (summary nodes + raw-
 * message count) with a short, length-bounded `contentPreview` per summary; it
 * mirrors `ctx_inspect`'s deliberate "metadata-first" stance and surfaces the
 * per-node `taint` flag so the UI can mark untrusted nodes. Full per-node
 * content recovery (the taint-sensitive `context.inspect` / FTS
 * `context.searchByConversation` paths) is intentionally NOT in this pass —
 * those two methods remain unregistered and are tracked as deferred.
 *
 * **Allowlist compliance.** All schemas use only the 12-shape allowlist:
 * z.object, z.string, z.number, z.boolean, z.array, z.nullable, z.optional.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

// ---------------------------------------------------------------------------
// context.conversations
// ---------------------------------------------------------------------------

/**
 * `context.conversations` — list the distinct LCD conversations the calling
 * agent owns within its tenant, most-recently-updated first, paginated.
 *
 * Request: `{ limit?, offset? }` (defaults applied handler-side: limit 100,
 * offset 0). Response: `{ conversations: DagConversation[], total }`. Each
 * conversation row carries snake_case keys matching the web `DagConversation`
 * type (`conversation_id`, `tenant_id`, `agent_id`, `session_key`, `title`,
 * `created_at`, `updated_at`). `title` is always null (the LCD store has no
 * title); `created_at` / `updated_at` are ISO-8601 strings derived from the
 * min / max message epoch.
 */
export const ContextConversationsContract = defineContract({
  method: "context.conversations",
  request: z.object({
    limit: z.number().optional(),
    offset: z.number().optional(),
  }),
  response: z.object({
    conversations: z.array(z.object({
      conversation_id: z.string(),
      tenant_id: z.string(),
      agent_id: z.string(),
      session_key: z.string(),
      title: z.nullable(z.string()),
      created_at: z.string(),
      updated_at: z.string(),
      message_count: z.number(),
    })),
    total: z.number(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// context.tree
// ---------------------------------------------------------------------------

/**
 * `context.tree` — the resolved DAG for ONE conversation: the leaf/condensed
 * summary nodes plus the count of raw messages still present in the model-
 * facing context_items view.
 *
 * Request: `{ conversation_id }`. Response: `{ conversationId, nodes:
 * DagTreeNode[], messageCount }`. Each node mirrors the web `DagTreeNode` type
 * (`summaryId`, `kind` ("leaf"|"condensed"), `depth`, `tokenCount`,
 * `contentPreview` (bounded, untrusted-origin — shown to a human, never re-fed
 * to a model), `childIds`, `parentIds`, `taint`, `createdAt` ISO string).
 * `messageCount` is the number of `message`-ref context_items (raw turns not yet
 * collapsed into a summary). R4 agent+tenant scoped — a wrong/foreign
 * conversation resolves to an empty tree, never another agent's data.
 */
export const ContextTreeContract = defineContract({
  method: "context.tree",
  request: z.object({
    conversation_id: z.string(),
  }),
  response: z.object({
    conversationId: z.string(),
    nodes: z.array(z.object({
      summaryId: z.string(),
      kind: z.string(),
      depth: z.number(),
      tokenCount: z.number(),
      contentPreview: z.string(),
      childIds: z.array(z.string()),
      parentIds: z.array(z.string()),
      taint: z.boolean(),
      createdAt: z.string(),
    })),
    messageCount: z.number(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// context.reset_lcd
// ---------------------------------------------------------------------------

/**
 * `context.reset_lcd` — delete ALL lcd_* rows for the conversation identified
 * by `session_key`. Admin-gated (T-164-02: `scopes: ["admin"]`). Returns a
 * count-only response — NO message content is returned or logged (T-164-03).
 *
 * `memory: true` additionally clears the conversation's RAG memories (the
 * GDPR / full-forget path). Defaults to `false` when absent.
 *
 * Plan 03 wires the daemon handler; this contract is the type-level gate.
 * Schema uses only the 12-shape allowlist: z.object, z.string, z.number,
 * z.boolean, z.optional (ASVS V5 / contract policy).
 */
export const ContextResetLcdContract = defineContract({
  method: "context.reset_lcd",
  request: z.object({
    session_key: z.string(),
    memory: z.boolean().optional(),
  }),
  response: z.object({
    sessionKey: z.string(),
    lcdRowsDeleted: z.number(),
    memoriesDeleted: z.number().optional(),
  }),
  scopes: ["admin"] as const,
});

// ===========================================================================
// Aggregator
// ===========================================================================

/**
 * Tuple of every context.* operator-browse contract. The bidirectional 1:1
 * architecture test treats this as an unordered set.
 *
 * NOTE: `context.inspect` + `context.searchByConversation` are deliberately
 * absent — they are the deferred content-recovery / FTS methods and remain
 * unregistered until implemented (the view degrades to load + render the DAG
 * structure without per-node deep-inspect / in-conversation search).
 */
export const CONTEXT_CONTRACTS = [
  ContextConversationsContract,
  ContextTreeContract,
  ContextResetLcdContract,
] as const;
