// SPDX-License-Identifier: Apache-2.0
/**
 * ContextStorePort: hexagonal architecture boundary for the LCD (Lossless
 * Context DAG) message store.
 *
 * This is the NEW LCD lossless-store port introduced in v2.12 (Phase 127).
 * It reuses the `ContextStorePort` identifier that was DELETED in Phase 126
 * (the old DAG context-store port + its `Ctx*Row` DTOs), but it is a fresh,
 * unrelated interface — same name per CONTEXT.md decision Q2, NOT a revival
 * of the old contract. Do not resurrect the deleted `ctx_*` types.
 *
 * Type-only, NO zod (core ports are zero-runtime-zod by rule). Row DTOs live
 * in core/src/ports/context-store-types.ts.
 *
 * The implementation lives at the memory package's createLcdStore(); the
 * pure parts <-> pi-ai Message codec lives at core's parts-codec.ts.
 *
 * @module
 */

import type {
  AppendMessageInput,
  LcdMessage,
} from "./context-store-types.js";

/**
 * ContextStorePort persists and reconstructs lossless conversation messages
 * for the LCD engine.
 *
 * All operations are synchronous (better-sqlite3 is synchronous), matching
 * the SessionStorePort precedent. The 127 surface is intentionally minimal —
 * write + read only. Assembly / eviction / summary methods belong to Phases
 * 128-130 and are NOT declared here.
 */
export interface ContextStorePort {
  /**
   * Write path (F1): persist one message + its structured parts atomically.
   * `tokenCount` arrives pre-computed on the input (the store NEVER computes
   * tokens — the caller supplies it agent-side via `estimateMessageTokens`).
   */
  append(input: AppendMessageInput): void;
  /**
   * Read path (F2): reconstruct all messages for a conversation, ordered by
   * seq. Each `LcdMessage` carries its parts; provider-correct block emission
   * is pi-ai's job downstream — this port returns the faithful canonical rows.
   */
  getMessages(conversationId: string): LcdMessage[];
}
