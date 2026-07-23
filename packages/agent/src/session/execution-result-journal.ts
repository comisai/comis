// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import type { ComisSessionManager } from "./comis-session-manager.js";
import type { SessionKey } from "@comis/core";

export const EXECUTION_RESULT_JOURNAL_CUSTOM_TYPE = "execution_result_journal";

export const ExecutionResultJournalRecordSchema = z.strictObject({
  journalKey: z.string().min(1).max(256),
  executionId: z.string().min(1).max(256),
  response: z.string().max(102_400),
});

export type ExecutionResultJournalRecord = z.infer<typeof ExecutionResultJournalRecordSchema>;

function findRecord(
  sessionManager: Pick<SessionManager, "getEntries">,
  journalKey: string,
): Result<ExecutionResultJournalRecord | undefined, Error> {
  const entries = tryCatch(() => sessionManager.getEntries());
  if (!entries.ok) return entries;
  for (let index = entries.value.length - 1; index >= 0; index--) {
    const entry = entries.value[index];
    if (
      entry?.type !== "custom"
      || entry.customType !== EXECUTION_RESULT_JOURNAL_CUSTOM_TYPE
    ) continue;
    const parsed = ExecutionResultJournalRecordSchema.safeParse(entry.data);
    if (!parsed.success || parsed.data.journalKey !== journalKey) continue;
    return ok(parsed.data);
  }
  return ok(undefined);
}

export function appendExecutionResultJournal(
  sessionManager: Pick<SessionManager, "getEntries" | "appendCustomEntry">,
  record: ExecutionResultJournalRecord,
): Result<void, Error> {
  const parsed = ExecutionResultJournalRecordSchema.safeParse(record);
  if (!parsed.success) return err(new Error("Execution result journal validation failed"));
  const existing = findRecord(sessionManager, parsed.data.journalKey);
  if (!existing.ok) return existing;
  if (existing.value !== undefined) {
    return existing.value.executionId === parsed.data.executionId
      && existing.value.response === parsed.data.response
      ? ok(undefined)
      : err(new Error("Execution result journal identity conflict"));
  }
  const appended = tryCatch(() => sessionManager.appendCustomEntry(
    EXECUTION_RESULT_JOURNAL_CUSTOM_TYPE,
    parsed.data,
  ));
  return appended.ok ? ok(undefined) : err(appended.error);
}

export async function readExecutionResultJournal(
  sessionAdapter: Pick<ComisSessionManager, "withSession">,
  sessionKey: SessionKey,
  journalKey: string,
): Promise<Result<ExecutionResultJournalRecord | undefined, Error>> {
  const parsedKey = ExecutionResultJournalRecordSchema.shape.journalKey.safeParse(journalKey);
  if (!parsedKey.success) return err(new Error("Execution result journal key is invalid"));
  const read = await sessionAdapter.withSession(
    sessionKey,
    async (sessionManager) => findRecord(sessionManager, parsedKey.data),
  );
  if (!read.ok) return err(new Error(`Execution result journal read failed (${read.error})`));
  return read.value;
}
