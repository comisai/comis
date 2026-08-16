// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type {
  AnnouncementDeadLetterEntryInput,
  AnnouncementParentDecisionReservation,
  AnnouncementRetirementProducer,
  QuarantineReleaseOutcome,
} from "@comis/core";
import { ConversationRefSchema, safePath, systemNowMs } from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import { announcementRecoveryKey } from "./announcement-dead-letter-identity.js";

export type AnnouncementTerminalDecision = QuarantineReleaseOutcome | "no_reply";

export interface AnnouncementTerminalDecisionRecord {
  readonly recordType: "terminal_decision";
  readonly id: string;
  readonly keyDigest: string;
  readonly outcome: AnnouncementTerminalDecision;
  readonly decidedAt: number;
  readonly retirementKeyDigests: readonly string[];
}

export interface AnnouncementTerminalRetirementRecord {
  readonly recordType: "terminal_retirement";
  readonly id: string;
  readonly producer: AnnouncementRetirementProducer;
  readonly completionKeyDigests: readonly string[];
  readonly preparedAt: number;
}

type TerminalDecisionOwner = AnnouncementDeadLetterEntryInput
  | AnnouncementParentDecisionReservation;

interface TerminalDecisionStoreOptions {
  readonly syncDirectory?: (path: string) => Promise<Result<void, Error>>;
}

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

export function announcementTerminalRetirementDigest(key: string): Result<string, Error> {
  return tryCatch(() => createHash("sha256").update(key, "utf8").digest("hex"));
}

function retirementIntentId(
  producer: AnnouncementRetirementProducer,
  completionKeyDigests: readonly string[],
): Result<string, Error> {
  return tryCatch(() => `retirement:${createHash("sha256")
    .update(JSON.stringify({
      producer,
      completionKeyDigests,
    }), "utf8")
    .digest("hex")}`);
}

function retirementKeys(owner: TerminalDecisionOwner): Result<readonly string[], Error> {
  const operationId = terminalDecisionIdentity(owner).operationId;
  const explicitKeys = owner.retirementKeys ?? [];
  const logicalKeys = explicitKeys.length > 0
    ? explicitKeys
    : owner.completionKeys?.filter((key) => key !== operationId) ?? [];
  const keys = logicalKeys.length > 0 ? [...new Set(logicalKeys)] : [operationId];
  const digests: string[] = [];
  for (const key of keys) {
    const digest = announcementTerminalRetirementDigest(key);
    if (!digest.ok) return digest;
    digests.push(digest.value);
  }
  return ok(digests);
}

interface TerminalDecisionStoragePaths {
  readonly root: string;
  readonly decisions: string;
  readonly retirements: string;
}

function decisionStoragePaths(filePath: string): Result<TerminalDecisionStoragePaths, Error> {
  return tryCatch(() => {
    const root = safePath(
      dirname(filePath),
      `${basename(filePath)}.terminal-decisions`,
    );
    return {
      root,
      decisions: safePath(root, "decisions"),
      retirements: safePath(root, "retirements"),
    };
  });
}

function terminalRecordPath(
  paths: TerminalDecisionStoragePaths,
  record: AnnouncementTerminalDecisionRecord | AnnouncementTerminalRetirementRecord,
): Result<string, Error> {
  const digest = record.recordType === "terminal_decision"
    ? record.keyDigest
    : record.id.slice("retirement:".length);
  const collection = record.recordType === "terminal_decision"
    ? paths.decisions
    : paths.retirements;
  return tryCatch(() => safePath(
    safePath(collection, digest.slice(0, 2)),
    `${digest}.json`,
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

export function createTerminalDecisionRecord(
  owner: TerminalDecisionOwner,
  outcome: AnnouncementTerminalDecision,
  decidedAt: number,
): Result<AnnouncementTerminalDecisionRecord, Error> {
  const keyDigest = decisionDigest(owner);
  if (!keyDigest.ok) return keyDigest;
  const retirementKeyDigests = retirementKeys(owner);
  return retirementKeyDigests.ok
    ? {
        ok: true,
        value: {
          recordType: "terminal_decision",
          id: `terminal:${keyDigest.value}`,
          keyDigest: keyDigest.value,
          outcome,
          decidedAt,
          retirementKeyDigests: retirementKeyDigests.value,
        },
      }
    : retirementKeyDigests;
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
    && Number.isFinite(record.decidedAt)
    && Array.isArray(record.retirementKeyDigests)
    && record.retirementKeyDigests.length > 0
    && record.retirementKeyDigests.every((digest) =>
      typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest))
    && new Set(record.retirementKeyDigests).size === record.retirementKeyDigests.length;
}

export function isAnnouncementTerminalRetirementRecord(
  value: unknown,
): value is AnnouncementTerminalRetirementRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.recordType !== "terminal_retirement"
    || typeof record.id !== "string"
    || !/^retirement:[a-f0-9]{64}$/u.test(record.id)
    || typeof record.producer !== "object"
    || record.producer === null
    || Array.isArray(record.producer)
    || !Array.isArray(record.completionKeyDigests)
    || record.completionKeyDigests.length === 0
    || !record.completionKeyDigests.every((digest) =>
      typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest))
    || new Set(record.completionKeyDigests).size !== record.completionKeyDigests.length
    || typeof record.preparedAt !== "number"
    || !Number.isFinite(record.preparedAt)
  ) return false;
  const producer = record.producer as Record<string, unknown>;
  if (!isRetirementProducer(producer)) return false;
  const expectedId = retirementIntentId(
    producer as unknown as AnnouncementRetirementProducer,
    record.completionKeyDigests as string[],
  );
  return expectedId.ok && expectedId.value === record.id;
}

function isRetirementProducer(
  producer: Record<string, unknown>,
): producer is Record<string, unknown> & AnnouncementRetirementProducer {
  if (typeof producer.tenantId !== "string" || producer.tenantId.length === 0) return false;
  switch (producer.kind) {
    case "session":
      return typeof producer.agentId === "string"
        && producer.agentId.length > 0
        && ConversationRefSchema.safeParse(producer.conversationRef).success;
    case "tool_result":
      return typeof producer.agentId === "string"
        && producer.agentId.length > 0
        && ConversationRefSchema.safeParse(producer.conversationRef).success
        && typeof producer.toolCallId === "string"
        && producer.toolCallId.length > 0;
    case "graph":
      return typeof producer.graphId === "string" && producer.graphId.length > 0;
    default:
      return false;
  }
}

export function createAnnouncementTerminalDecisionStore(
  filePath: string,
  options: TerminalDecisionStoreOptions = {},
): {
  lookup(owner: TerminalDecisionOwner): Promise<Result<AnnouncementTerminalDecision | undefined, Error>>;
  record(owner: TerminalDecisionOwner, outcome: AnnouncementTerminalDecision): Promise<Result<void, Error>>;
  retire(completionKeys: readonly string[]): Promise<Result<void, Error>>;
  prepareRetirement(
    completionKeys: readonly string[],
    producer: AnnouncementRetirementProducer,
  ): Promise<Result<void, Error>>;
  collectRetirements(
    producerExists: (
      producer: AnnouncementRetirementProducer,
    ) => Promise<Result<boolean, Error>>,
    retainedOwnershipExists?: (
      completionKeyDigests: readonly string[],
    ) => Result<boolean, Error>,
  ): Promise<Result<number, Error>>;
} {
  const records = new Map<string, AnnouncementTerminalDecisionRecord>();
  const retirements = new Map<string, AnnouncementTerminalRetirementRecord>();
  let loaded = false;
  let operationTail: Promise<void> = Promise.resolve();

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function ensureRecordDirectory(
    directory: string,
    root: string,
  ): Promise<Result<void, Error>> {
    const created = await fromPromise(mkdir(directory, { recursive: true, mode: 0o700 }));
    if (!created.ok) return created;
    for (const durableDirectory of new Set([
      directory,
      dirname(directory),
      root,
      dirname(root),
    ])) {
      const synced = await syncDirectory(durableDirectory);
      if (!synced.ok) return synced;
    }
    return ok(undefined);
  }

  async function writeRecord(
    record: AnnouncementTerminalDecisionRecord | AnnouncementTerminalRetirementRecord,
  ): Promise<{
    result: Result<void, Error>;
    snapshotVisible: boolean;
  }> {
    const paths = decisionStoragePaths(filePath);
    if (!paths.ok) return { result: paths, snapshotVisible: false };
    const target = terminalRecordPath(paths.value, record);
    if (!target.ok) return { result: target, snapshotVisible: false };
    const directory = dirname(target.value);
    const createdDirectory = await ensureRecordDirectory(directory, paths.value.root);
    if (!createdDirectory.ok) return { result: createdDirectory, snapshotVisible: false };
    const nonce = tryCatch(() => randomUUID());
    if (!nonce.ok) return { result: nonce, snapshotVisible: false };
    const temporaryPath = tryCatch(() => safePath(
      directory,
      `${basename(target.value)}.${nonce.value}.tmp`,
    ));
    if (!temporaryPath.ok) return { result: temporaryPath, snapshotVisible: false };
    const serialized = tryCatch(() => JSON.stringify(record));
    if (!serialized.ok) return { result: serialized, snapshotVisible: false };
    const handle = await fromPromise(open(temporaryPath.value, "wx", 0o600));
    if (!handle.ok) return { result: handle, snapshotVisible: false };
    const written = await fromPromise(handle.value.writeFile(serialized.value, "utf8"));
    const synced = written.ok ? await fromPromise(handle.value.sync()) : written;
    const closed = await fromPromise(handle.value.close());
    if (!written.ok || !synced.ok || !closed.ok) {
      await fromPromise(unlink(temporaryPath.value));
      return {
        result: !written.ok ? written : !synced.ok ? synced : closed,
        snapshotVisible: false,
      };
    }
    const replaced = await fromPromise(rename(temporaryPath.value, target.value));
    if (!replaced.ok) {
      await fromPromise(unlink(temporaryPath.value));
      return { result: replaced, snapshotVisible: false };
    }
    const directorySynced = await (options.syncDirectory ?? syncDirectory)(directory);
    return { result: directorySynced, snapshotVisible: true };
  }

  async function removeRecord(
    record: AnnouncementTerminalDecisionRecord | AnnouncementTerminalRetirementRecord,
  ): Promise<{
    result: Result<void, Error>;
    snapshotVisible: boolean;
  }> {
    const paths = decisionStoragePaths(filePath);
    if (!paths.ok) return { result: paths, snapshotVisible: false };
    const target = terminalRecordPath(paths.value, record);
    if (!target.ok) return { result: target, snapshotVisible: false };
    const removed = await fromPromise(unlink(target.value));
    if (!removed.ok && !isMissingFile(removed.error)) {
      return { result: removed, snapshotVisible: false };
    }
    if (!removed.ok) return { result: ok(undefined), snapshotVisible: true };
    const directorySynced = await (options.syncDirectory ?? syncDirectory)(dirname(target.value));
    return { result: directorySynced, snapshotVisible: true };
  }

  async function loadCollection(
    directory: string,
    kind: "terminal_decision" | "terminal_retirement",
  ): Promise<Result<void, Error>> {
    const shards = await fromPromise(readdir(directory, { withFileTypes: true }));
    if (!shards.ok) return isMissingFile(shards.error) ? ok(undefined) : shards;
    for (const shard of shards.value) {
      if (!shard.isDirectory() || !/^[a-f0-9]{2}$/u.test(shard.name)) {
        return err(new Error("Announcement terminal decision store is invalid"));
      }
      const shardPath = tryCatch(() => safePath(directory, shard.name));
      if (!shardPath.ok) return shardPath;
      const files = await fromPromise(readdir(shardPath.value, { withFileTypes: true }));
      if (!files.ok) return files;
      for (const file of files.value) {
        if (/^[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/u.test(file.name)) {
          const temporaryPath = tryCatch(() => safePath(shardPath.value, file.name));
          if (!temporaryPath.ok) return temporaryPath;
          const removed = await fromPromise(unlink(temporaryPath.value));
          if (!removed.ok && !isMissingFile(removed.error)) return removed;
          continue;
        }
        if (!file.isFile() || !/^[a-f0-9]{64}\.json$/u.test(file.name)) {
          return err(new Error("Announcement terminal decision store is invalid"));
        }
        const path = tryCatch(() => safePath(shardPath.value, file.name));
        if (!path.ok) return path;
        const content = await fromPromise(readFile(path.value, "utf8"));
        if (!content.ok) return content;
        const parsed = tryCatch(() => JSON.parse(content.value) as unknown);
        if (!parsed.ok) return err(new Error("Announcement terminal decision store is invalid"));
        if (kind === "terminal_decision") {
          if (
            !isAnnouncementTerminalDecisionRecord(parsed.value)
            || file.name !== `${parsed.value.keyDigest}.json`
          ) return err(new Error("Announcement terminal decision store is invalid"));
          records.set(parsed.value.keyDigest, parsed.value);
        } else {
          if (
            !isAnnouncementTerminalRetirementRecord(parsed.value)
            || file.name !== `${parsed.value.id.slice("retirement:".length)}.json`
          ) return err(new Error("Announcement terminal retirement store is invalid"));
          retirements.set(parsed.value.id, parsed.value);
        }
      }
    }
    return ok(undefined);
  }

  async function load(): Promise<Result<void, Error>> {
    if (loaded) return ok(undefined);
    const paths = decisionStoragePaths(filePath);
    if (!paths.ok) return paths;
    const loadedDecisions = await loadCollection(paths.value.decisions, "terminal_decision");
    if (!loadedDecisions.ok) return loadedDecisions;
    const loadedRetirements = await loadCollection(paths.value.retirements, "terminal_retirement");
    if (!loadedRetirements.ok) return loadedRetirements;
    loaded = true;
    return ok(undefined);
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

  async function updateDecisionRecord(
    previous: AnnouncementTerminalDecisionRecord,
    next?: AnnouncementTerminalDecisionRecord,
  ): Promise<Result<void, Error>> {
    const persisted = next ? await writeRecord(next) : await removeRecord(previous);
    if (persisted.result.ok || persisted.snapshotVisible) {
      if (next) records.set(next.keyDigest, next);
      else records.delete(previous.keyDigest);
    }
    return persisted.result;
  }

  async function removeRetirementRecord(
    retirement: AnnouncementTerminalRetirementRecord,
  ): Promise<Result<void, Error>> {
    const persisted = await removeRecord(retirement);
    if (persisted.result.ok || persisted.snapshotVisible) retirements.delete(retirement.id);
    return persisted.result;
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
      const persisted = await writeRecord(created.value);
      if (persisted.result.ok || persisted.snapshotVisible) {
        records.set(created.value.keyDigest, created.value);
      }
      return persisted.result;
    }),
    retire: (completionKeys) => serialize(async () => {
      const loadedIndex = await load();
      if (!loadedIndex.ok) return loadedIndex;
      if (
        completionKeys.length === 0
        || completionKeys.some((key) => typeof key !== "string" || key.length === 0)
      ) {
        return err(new Error("Announcement terminal decision retirement is invalid"));
      }
      const retiredDigests = new Set<string>();
      for (const key of new Set(completionKeys)) {
        const digest = announcementTerminalRetirementDigest(key);
        if (!digest.ok) return digest;
        retiredDigests.add(digest.value);
      }
      for (const record of [...records.values()]) {
        const remaining = record.retirementKeyDigests.filter(
          (digest) => !retiredDigests.has(digest),
        );
        if (remaining.length === record.retirementKeyDigests.length) continue;
        const persisted = await updateDecisionRecord(
          record,
          remaining.length === 0
            ? undefined
            : { ...record, retirementKeyDigests: remaining },
        );
        if (!persisted.ok) return persisted;
      }
      return ok(undefined);
    }),
    prepareRetirement: (completionKeys, producer) => serialize(async () => {
      const loadedIndex = await load();
      if (!loadedIndex.ok) return loadedIndex;
      if (
        completionKeys.length === 0
        || completionKeys.some((key) => typeof key !== "string" || key.length === 0)
        || !isRetirementProducer(producer as unknown as Record<string, unknown>)
      ) {
        return err(new Error("Announcement terminal decision retirement intent is invalid"));
      }
      const completionKeyDigests: string[] = [];
      for (const key of [...new Set(completionKeys)].sort()) {
        const digest = announcementTerminalRetirementDigest(key);
        if (!digest.ok) return digest;
        completionKeyDigests.push(digest.value);
      }
      const id = retirementIntentId(producer, completionKeyDigests);
      if (!id.ok) return id;
      if (retirements.has(id.value)) return ok(undefined);
      const record: AnnouncementTerminalRetirementRecord = {
        recordType: "terminal_retirement",
        id: id.value,
        producer,
        completionKeyDigests,
        preparedAt: systemNowMs(),
      };
      const persisted = await writeRecord(record);
      if (persisted.result.ok || persisted.snapshotVisible) retirements.set(record.id, record);
      return persisted.result;
    }),
    collectRetirements: (producerExists, retainedOwnershipExists) => serialize(async () => {
      const loadedIndex = await load();
      if (!loadedIndex.ok) return loadedIndex;
      const collectable: AnnouncementTerminalRetirementRecord[] = [];
      for (const retirement of retirements.values()) {
        const exists = await producerExists(retirement.producer);
        if (!exists.ok) return exists;
        if (exists.value) continue;
        const retained = retainedOwnershipExists?.(retirement.completionKeyDigests);
        if (retained && !retained.ok) return retained;
        if (!retained?.value) collectable.push(retirement);
      }
      if (collectable.length === 0) return ok(0);
      const retiredDigests = new Set(collectable.flatMap((retirement) =>
        retirement.completionKeyDigests));
      for (const record of [...records.values()]) {
        const remaining = record.retirementKeyDigests.filter(
          (digest) => !retiredDigests.has(digest),
        );
        if (remaining.length === record.retirementKeyDigests.length) continue;
        const persisted = await updateDecisionRecord(
          record,
          remaining.length === 0
            ? undefined
            : { ...record, retirementKeyDigests: remaining },
        );
        if (!persisted.ok) return persisted;
      }
      for (const retirement of collectable) {
        const removed = await removeRetirementRecord(retirement);
        if (!removed.ok) return removed;
      }
      return ok(collectable.length);
    }),
  };
}
