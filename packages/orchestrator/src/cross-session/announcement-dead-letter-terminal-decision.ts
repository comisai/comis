// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type {
  AnnouncementDeadLetterEntryInput,
  AnnouncementParentDecisionReservation,
  QuarantineReleaseOutcome,
} from "@comis/core";
import { safePath, systemNowMs } from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import { announcementRecoveryKey } from "./announcement-dead-letter-identity.js";

export type AnnouncementTerminalDecision = QuarantineReleaseOutcome | "no_reply";

export interface AnnouncementTerminalDecisionRecord {
  readonly recordType: "terminal_decision";
  readonly id: string;
  readonly keyDigest: string;
  readonly outcome: AnnouncementTerminalDecision;
  readonly decidedAt: number;
}

type TerminalDecisionOwner = AnnouncementDeadLetterEntryInput
  | AnnouncementParentDecisionReservation;

interface TerminalDecisionStoreOptions {
  readonly maxRecords?: number;
}

const DEFAULT_MAX_TERMINAL_DECISIONS = 10_000;

export function terminalDecisionIdentity(owner: TerminalDecisionOwner): {
  rootRunId: string;
  operationId: string;
} {
  return {
    rootRunId: owner.rootRunId ?? `announcement:${owner.sessionKey}`,
    operationId: owner.idempotencyKey ?? announcementRecoveryKey(owner),
  };
}

function decisionDigest(owner: TerminalDecisionOwner): Result<string, Error> {
  const identity = terminalDecisionIdentity(owner);
  return tryCatch(() => createHash("sha256")
    .update(`${identity.rootRunId}\u0000${identity.operationId}`, "utf8")
    .digest("hex"));
}

function decisionFilePath(filePath: string): Result<string, Error> {
  return tryCatch(() => safePath(
    dirname(filePath),
    `${basename(filePath)}.terminal-decisions.jsonl`,
  ));
}

function isMissingFile(error: Error): boolean {
  return "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function syncDirectory(path: string): Promise<Result<void, Error>> {
  const opened = await fromPromise(open(path, "r"));
  if (!opened.ok) return opened;
  const synced = await fromPromise(opened.value.sync());
  const closed = await fromPromise(opened.value.close());
  return synced.ok ? closed : synced;
}

async function removeFile(path: string): Promise<void> {
  await fromPromise(unlink(path));
}

export function createTerminalDecisionRecord(
  owner: TerminalDecisionOwner,
  outcome: AnnouncementTerminalDecision,
  decidedAt: number,
): Result<AnnouncementTerminalDecisionRecord, Error> {
  const keyDigest = decisionDigest(owner);
  return keyDigest.ok
    ? {
        ok: true,
        value: {
          recordType: "terminal_decision",
          id: `terminal:${keyDigest.value}`,
          keyDigest: keyDigest.value,
          outcome,
          decidedAt,
        },
      }
    : keyDigest;
}

export function isAnnouncementTerminalDecisionRecord(
  value: unknown,
): value is AnnouncementTerminalDecisionRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.recordType === "terminal_decision"
    && typeof record.id === "string"
    && /^terminal:[a-f0-9]{64}$/u.test(record.id)
    && typeof record.keyDigest === "string"
    && /^[a-f0-9]{64}$/u.test(record.keyDigest)
    && record.id === `terminal:${record.keyDigest}`
    && (
      record.outcome === "delivered"
      || record.outcome === "discarded"
      || record.outcome === "no_reply"
    )
    && typeof record.decidedAt === "number"
    && Number.isFinite(record.decidedAt);
}

export function createAnnouncementTerminalDecisionStore(
  filePath: string,
  options: TerminalDecisionStoreOptions = {},
): {
  lookup(owner: TerminalDecisionOwner): Promise<Result<AnnouncementTerminalDecision | undefined, Error>>;
  record(owner: TerminalDecisionOwner, outcome: AnnouncementTerminalDecision): Promise<Result<void, Error>>;
} {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_TERMINAL_DECISIONS;
  const records = new Map<string, AnnouncementTerminalDecisionRecord>();
  let loaded = false;
  let operationTail: Promise<void> = Promise.resolve();

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  function trimIndex(): void {
    while (records.size > maxRecords) {
      const oldest = records.keys().next().value;
      if (oldest === undefined) return;
      records.delete(oldest);
    }
  }

  async function load(): Promise<Result<void, Error>> {
    if (loaded) return ok(undefined);
    if (!Number.isInteger(maxRecords) || maxRecords <= 0) {
      return err(new Error("Announcement terminal decision capacity is invalid"));
    }
    const path = decisionFilePath(filePath);
    if (!path.ok) return path;
    const content = await fromPromise(readFile(path.value, "utf8"));
    if (!content.ok) {
      if (isMissingFile(content.error)) {
        loaded = true;
        return ok(undefined);
      }
      return content;
    }
    const lines = content.value.split("\n").filter((line) => line.length > 0);
    for (const line of lines) {
      const parsed = tryCatch(() => JSON.parse(line) as unknown);
      if (!parsed.ok || !isAnnouncementTerminalDecisionRecord(parsed.value)) {
        return err(new Error("Announcement terminal decision index is invalid"));
      }
      const existing = records.get(parsed.value.keyDigest);
      if (existing && existing.outcome !== parsed.value.outcome) {
        return err(new Error("Announcement terminal decision index conflicts with its durable outcome"));
      }
      records.delete(parsed.value.keyDigest);
      records.set(parsed.value.keyDigest, parsed.value);
    }
    trimIndex();
    loaded = true;
    return ok(undefined);
  }

  async function persist(): Promise<Result<void, Error>> {
    const path = decisionFilePath(filePath);
    if (!path.ok) return path;
    const directory = dirname(path.value);
    const createdDirectory = await fromPromise(mkdir(directory, { recursive: true, mode: 0o700 }));
    if (!createdDirectory.ok) return createdDirectory;
    const nonce = tryCatch(() => randomUUID());
    if (!nonce.ok) return nonce;
    const temporaryPath = tryCatch(() => safePath(
      directory,
      `${basename(path.value)}.${nonce.value}.tmp`,
    ));
    if (!temporaryPath.ok) return temporaryPath;
    const serialized = tryCatch(() => records.size === 0
      ? ""
      : `${[...records.values()].map((record) => JSON.stringify(record)).join("\n")}\n`);
    if (!serialized.ok) return serialized;
    const handle = await fromPromise(open(temporaryPath.value, "wx", 0o600));
    if (!handle.ok) return handle;
    const written = await fromPromise(handle.value.writeFile(serialized.value, "utf8"));
    const synced = written.ok ? await fromPromise(handle.value.sync()) : written;
    const closed = await fromPromise(handle.value.close());
    if (!written.ok || !synced.ok || !closed.ok) {
      await removeFile(temporaryPath.value);
      return !written.ok ? written : !synced.ok ? synced : closed;
    }
    const replaced = await fromPromise(rename(temporaryPath.value, path.value));
    if (!replaced.ok) {
      await removeFile(temporaryPath.value);
      return replaced;
    }
    return syncDirectory(directory);
  }

  async function lookupLoaded(
    owner: TerminalDecisionOwner,
  ): Promise<Result<AnnouncementTerminalDecision | undefined, Error>> {
    const loadedIndex = await load();
    if (!loadedIndex.ok) return loadedIndex;
    const expected = createTerminalDecisionRecord(owner, "no_reply", 0);
    if (!expected.ok) return expected;
    return ok(records.get(expected.value.keyDigest)?.outcome);
  }

  return {
    lookup: (owner) => serialize(() => lookupLoaded(owner)),
    record: (owner, outcome) => serialize(async () => {
      const loadedIndex = await load();
      if (!loadedIndex.ok) return loadedIndex;
      const created = createTerminalDecisionRecord(owner, outcome, systemNowMs());
      if (!created.ok) return created;
      const existing = records.get(created.value.keyDigest);
      if (existing !== undefined) {
        return existing.outcome === outcome
          ? ok(undefined)
          : err(new Error("Announcement terminal decision conflicts with its durable outcome"));
      }
      const previous = new Map(records);
      records.set(created.value.keyDigest, created.value);
      trimIndex();
      const persisted = await persist();
      if (!persisted.ok) {
        records.clear();
        for (const [key, record] of previous) records.set(key, record);
      }
      return persisted;
    }),
  };
}
