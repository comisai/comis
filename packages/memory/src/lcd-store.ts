// SPDX-License-Identifier: Apache-2.0
/**
 * SQLite adapter implementing ContextStorePort — the LCD (Lossless Context DAG)
 * lossless store. Mirrors createSessionStore: prepared statements bound once,
 * a synchronous port-typed object, zod-validated graceful-degrade reads, and an
 * injected wall-clock (the caller supplies `createdAt`; the store never reads
 * the clock or computes tokens).
 *
 * The write path (`append`) persists one message + its N structured parts
 * atomically in a single `db.transaction` (F1). The read path (`getMessages`)
 * reconstructs the ordered `LcdMessage[]` DTOs; the canonical pi-ai Message
 * reconstruction delegates to @comis/core's `partsToMessage` codec (F2/F3) — the
 * single pi-ai-typed seam, consumed by Phase 128 assembly.
 *
 * NO module-level logger in Phase 127 (mirrors createSessionStore exactly): the
 * memory package has no infra-logging dependency and AGENTS.md §2.4 forbids
 * importing the infra logger directly (inject the logger via Deps). The boundary
 * observability line (an injected-logger INFO per append/read with
 * durationMs/err/hint) lands in Phase 128 when the live append-on-turn
 * write-path is wired. The store NEVER logs `metadata.raw` / `tool_output`
 * contents (tool I/O may carry secrets — a Phase-132 concern; Pino redaction is
 * for logs, not the DB).
 *
 * @module
 */

import type Database from "better-sqlite3";
import {
  partsToMessage,
  type AppendMessageInput,
  type ContextStorePort,
  type LcdMessage,
  type LcdMessagePart,
  type LcdPartMetadata,
  type LcdPartKind,
  type LcdRole,
} from "@comis/core";
import type { Message } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createRowMapper } from "./row-mapper.js";
import { LcdMessageRowSchema, LcdMessagePartRowSchema } from "./row-schemas.js";

/**
 * The named pi-ai reconstruction entry point for the LCD store (F2/F3).
 *
 * `getMessages` returns the faithful `LcdMessage` DTO rows; turning one back
 * into a canonical pi-ai `Message` is the consumer's step — Phase-128 assembly
 * calls this. It delegates to the core `partsToMessage` codec (the single
 * pi-ai-typed seam) rather than duplicating the per-block reconstruction in the
 * store; it is exposed here so consumers reconstruct via one named function
 * co-located with the store that produced the rows.
 */
export function reconstructLcdMessage(message: LcdMessage): Message {
  return partsToMessage(message);
}

// Row mappers (createRowMapper(z.strictObject) — degrade to [] on validation
// failure, never throw; strictObject rejects extra columns = drift detection).
const messageRowMapper = createRowMapper(LcdMessageRowSchema);
const partRowMapper = createRowMapper(LcdMessagePartRowSchema);

/** The verbatim canonical block is opaque at the row layer (F1). */
const LcdPartMetadataSchema = z.looseObject({
  raw: z.unknown(),
  rawType: z.string().optional(),
  topLevelReasoningOnly: z.boolean().optional(),
  messageEnvelope: z.unknown().optional(),
});

/**
 * Parse the JSON `metadata` column with graceful degradation (T-127-10 /
 * ASVS V5): a corrupt/poisoned persisted block degrades `raw` to undefined and
 * NEVER throws — a malformed row can not crash reconstruction.
 */
function parseMetadata(raw: string): LcdPartMetadata {
  try {
    const result = LcdPartMetadataSchema.safeParse(JSON.parse(raw));
    return result.success ? (result.data as LcdPartMetadata) : { raw: undefined };
  } catch {
    return { raw: undefined };
  }
}

/** Parse a nullable JSON column (tool_input / tool_output) — degrade to undefined. */
function parseJsonColumn(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** SQLite NULL/0/1 INTEGER -> boolean | undefined (NULL for non-tool_result parts). */
function intToBool(value: number | null): boolean | undefined {
  return value === null ? undefined : value !== 0;
}

/** boolean | undefined -> SQLite NULL/0/1 INTEGER for the is_error column. */
function boolToInt(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

/**
 * Create a ContextStorePort bound to the given database.
 *
 * Assumes `initSchema()` has already created the `lcd_messages` /
 * `lcd_message_parts` tables.
 */
export function createLcdStore(db: Database.Database): ContextStorePort {
  // Prepare statements once for performance. Static SQL only; bound parameters
  // for every value; no interpolated identifiers (T-127-09). Column-count ===
  // placeholder-count === arg-count (arg-shift guard — a shift surfaces in the
  // round-trip test).
  const insertMsg = db.prepare(`
    INSERT INTO lcd_messages
      (id, conversation_id, tenant_id, agent_id, session_key, seq, role, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertPart = db.prepare(`
    INSERT INTO lcd_message_parts
      (id, message_id, ordinal, kind, tool_call_id, tool_name, tool_input, tool_output, is_error, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const selectMsgs = db.prepare(
    "SELECT * FROM lcd_messages WHERE conversation_id = ? ORDER BY seq",
  );

  const selectParts = db.prepare(
    "SELECT * FROM lcd_message_parts WHERE message_id = ? ORDER BY ordinal",
  );

  // One atomic write: the message row + its N part rows commit together (F1).
  const appendTxn = db.transaction((input: AppendMessageInput) => {
    const messageId = randomUUID();
    insertMsg.run(
      messageId,
      input.scope.conversationId,
      input.scope.tenantId,
      input.scope.agentId,
      input.scope.sessionKey,
      input.seq,
      input.role,
      input.tokenCount,
      input.createdAt,
    );

    let ordinal = 0;
    for (const part of input.parts) {
      insertPart.run(
        randomUUID(),
        messageId,
        ordinal,
        part.kind,
        part.toolCallId ?? null,
        part.toolName ?? null,
        part.toolInput === undefined ? null : JSON.stringify(part.toolInput),
        part.toolOutput === undefined ? null : JSON.stringify(part.toolOutput),
        boolToInt(part.isError),
        JSON.stringify(part.metadata),
      );
      ordinal++;
    }
  });

  return {
    append(input: AppendMessageInput): void {
      appendTxn(input);
    },

    getMessages(conversationId: string): LcdMessage[] {
      const parsedMsgs = messageRowMapper.parseRows(selectMsgs.all(conversationId));
      const msgRows = parsedMsgs.ok ? parsedMsgs.value : [];

      return msgRows.map((row) => {
        const parsedParts = partRowMapper.parseRows(selectParts.all(row.id));
        const partRows = parsedParts.ok ? parsedParts.value : [];

        const parts: LcdMessagePart[] = partRows.map((p) => ({
          kind: p.kind as LcdPartKind,
          toolCallId: p.tool_call_id ?? undefined,
          toolName: p.tool_name ?? undefined,
          toolInput: parseJsonColumn(p.tool_input),
          toolOutput: parseJsonColumn(p.tool_output),
          isError: intToBool(p.is_error),
          metadata: parseMetadata(p.metadata),
        }));

        return {
          id: row.id,
          conversationId: row.conversation_id,
          seq: row.seq,
          role: row.role as LcdRole,
          tokenCount: row.token_count,
          createdAt: row.created_at,
          parts,
        };
      });
    },
  };
}
