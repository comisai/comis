// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
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

function decisionPaths(
  filePath: string,
  keyDigest: string,
): Result<{ directoryPath: string; decisionPath: string }, Error> {
  return tryCatch(() => {
    const parent = dirname(filePath);
    const directoryPath = safePath(parent, `${basename(filePath)}.terminal-decisions`);
    return {
      directoryPath,
      decisionPath: safePath(directoryPath, `${keyDigest}.json`),
    };
  });
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

export function createAnnouncementTerminalDecisionStore(filePath: string): {
  lookup(owner: TerminalDecisionOwner): Promise<Result<AnnouncementTerminalDecision | undefined, Error>>;
  record(owner: TerminalDecisionOwner, outcome: AnnouncementTerminalDecision): Promise<Result<void, Error>>;
} {
  async function lookup(
    owner: TerminalDecisionOwner,
  ): Promise<Result<AnnouncementTerminalDecision | undefined, Error>> {
    const expected = createTerminalDecisionRecord(owner, "no_reply", 0);
    if (!expected.ok) return expected;
    const paths = decisionPaths(filePath, expected.value.keyDigest);
    if (!paths.ok) return paths;
    const loaded = await fromPromise(readFile(paths.value.decisionPath, "utf8"));
    if (!loaded.ok) {
      return "code" in loaded.error && (loaded.error as NodeJS.ErrnoException).code === "ENOENT"
        ? ok(undefined)
        : loaded;
    }
    const parsed = tryCatch(() => JSON.parse(loaded.value) as unknown);
    if (
      !parsed.ok
      || !isAnnouncementTerminalDecisionRecord(parsed.value)
      || parsed.value.keyDigest !== expected.value.keyDigest
    ) {
      return err(new Error("Announcement terminal decision record is invalid"));
    }
    return ok(parsed.value.outcome);
  }

  async function record(
    owner: TerminalDecisionOwner,
    outcome: AnnouncementTerminalDecision,
  ): Promise<Result<void, Error>> {
    const created = createTerminalDecisionRecord(owner, outcome, systemNowMs());
    if (!created.ok) return created;
    const paths = decisionPaths(filePath, created.value.keyDigest);
    if (!paths.ok) return paths;
    const existing = await lookup(owner);
    if (!existing.ok) return existing;
    if (existing.value !== undefined) {
      if (existing.value !== outcome) {
        return err(new Error("Announcement terminal decision conflicts with its durable outcome"));
      }
      const parentSynced = await syncDirectory(dirname(paths.value.directoryPath));
      return parentSynced.ok ? syncDirectory(paths.value.directoryPath) : parentSynced;
    }

    const directoryCreated = await fromPromise(mkdir(paths.value.directoryPath, {
      recursive: true,
      mode: 0o700,
    }));
    if (!directoryCreated.ok) return directoryCreated;
    const nonce = tryCatch(() => randomUUID());
    if (!nonce.ok) return nonce;
    const temporaryPath = tryCatch(() => safePath(
      paths.value.directoryPath,
      `${created.value.keyDigest}.${nonce.value}.tmp`,
    ));
    if (!temporaryPath.ok) return temporaryPath;
    const handle = await fromPromise(open(temporaryPath.value, "wx", 0o600));
    if (!handle.ok) return handle;
    const written = await fromPromise(handle.value.writeFile(`${JSON.stringify(created.value)}\n`, "utf8"));
    const synced = written.ok ? await fromPromise(handle.value.sync()) : written;
    const closed = await fromPromise(handle.value.close());
    if (!written.ok || !synced.ok || !closed.ok) {
      await removeFile(temporaryPath.value);
      return !written.ok ? written : !synced.ok ? synced : closed;
    }
    const linked = await fromPromise(link(temporaryPath.value, paths.value.decisionPath));
    await removeFile(temporaryPath.value);
    if (!linked.ok) {
      if ("code" in linked.error && (linked.error as NodeJS.ErrnoException).code === "EEXIST") {
        const raced = await lookup(owner);
        if (!raced.ok) return raced;
        if (raced.value !== outcome) {
          return err(new Error("Announcement terminal decision conflicts with its durable outcome"));
        }
      } else {
        return linked;
      }
    }
    const parentSynced = await syncDirectory(dirname(paths.value.directoryPath));
    return parentSynced.ok ? syncDirectory(paths.value.directoryPath) : parentSynced;
  }

  return { lookup, record };
}
