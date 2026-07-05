// SPDX-License-Identifier: Apache-2.0
/**
 * Zod row schema for the `msteams_conversation_refs` table — the persisted
 * conversation-id → routing-tuple map. SSOT for the file-internal
 * `MsTeamsConversationRow` type in `msteams-conversation-store.ts`.
 *
 * Conventions (same as the other row schemas):
 *   - `z.strictObject(...)` rejects extra columns, so a drift between the schema
 *     and the `ensureMsTeamsConversationTable` DDL surfaces in the round-trip test.
 *   - nullable → `z.X.nullable()` (`X | null`) — SQLite NULL ≠ undefined; the
 *     store's `rowToRef` maps `?? undefined` at the domain boundary.
 *   - INTEGER → `z.number()`; TEXT → `z.string()` (nullable TEXT → `.nullable()`).
 *
 * SECURITY — routing columns ONLY: `conversation_id`, `service_url`, `tenant_id`
 * (routing, not credentials), `thread_id`, `updated_at_ms`. There is deliberately
 * NO credential column and NO message-content column — the strictObject REJECTS
 * one if the DDL ever adds it.
 *
 * Columns MUST match the `ensureMsTeamsConversationTable` DDL exactly.
 *
 * @module
 */

import { z } from "zod";

/**
 * Schema for the `msteams_conversation_refs` table.
 * SSOT for the file-internal `MsTeamsConversationRow` type in
 * msteams-conversation-store.ts. Columns MUST match the
 * `ensureMsTeamsConversationTable` DDL exactly (strictObject).
 */
export const MsTeamsConversationRowSchema = z.strictObject({
  // sha256(conversation_id) — the fixed-width PK.
  key: z.string(),
  conversation_id: z.string(),
  service_url: z.string(),
  tenant_id: z.string(),
  // Thread root; NULL for a 1:1 or unthreaded chat. SQLite NULL ≠ undefined —
  // rowToRef maps `?? undefined` at the domain boundary.
  thread_id: z.string().nullable(),
  updated_at_ms: z.number(),
});

export type MsTeamsConversationRow = z.infer<typeof MsTeamsConversationRowSchema>;
