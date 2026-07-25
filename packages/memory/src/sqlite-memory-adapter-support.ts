// SPDX-License-Identifier: Apache-2.0
/** Typed row and correction-history support for SqliteMemoryAdapter. */

import type { MemoryEntry } from "@comis/core";
import { z } from "zod";
import { createRowMapper } from "./row-mapper.js";
import { IdProjectionRowSchema, MemoryRowSchema } from "./row-schemas.js";

/** The closed result of replacing a scoped incumbent memory. */
export type MemorySupersedeOutcome = "superseded" | "not-found";

export interface MemorySupersedeScope {
  tenantId: string;
  agentId: string;
  userId?: string;
}

export interface MemoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  audit?(obj: Record<string, unknown>, msg: string): void;
}

export const memoryRowMapper = createRowMapper(MemoryRowSchema);
export const idProjectionRowMapper = createRowMapper(IdProjectionRowSchema);

const SupersedeHistorySchema = z.array(
  z.strictObject({ previousContent: z.string(), changedAt: z.number().int().positive() }),
);

/** Malformed history is treated as absent so the next correction can self-heal it. */
export function parseHistoryColumn(raw: string | null): MemoryEntry["history"] | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = SupersedeHistorySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
