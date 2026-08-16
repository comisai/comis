// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
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
      producer: {
        tenantId: producer.tenantId,
        agentId: producer.agentId,
        conversationRef: producer.conversationRef,
      },
      completionKeyDigests,
    }), "utf8")
    .digest("hex")}`);
}

function retirementKeys(owner: TerminalDecisionOwner): Result<readonly string[], Error> {
  const operationId = terminalDecisionIdentity(owner).operationId;
  const logicalKeys = owner.completionKeys?.filter((key) => key !== operationId) ?? [];
  const keys = logicalKeys.length > 0 ? [...new Set(logicalKeys)] : [operationId];
  const digests: string[] = [];
  for (const key of keys) {
    const digest = announcementTerminalRetirementDigest(key);
    if (!digest.ok) return digest;
    digests.push(digest.value);
  }
  return ok(digests);
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
  if (
    typeof producer.tenantId !== "string"
    || producer.tenantId.length === 0
    || typeof producer.agentId !== "string"
    || producer.agentId.length === 0
    || !ConversationRefSchema.safeParse(producer.conversationRef).success
  ) return false;
  const expectedId = retirementIntentId(
    producer as unknown as AnnouncementRetirementProducer,
    record.completionKeyDigests as string[],
  );
  return expectedId.ok && expectedId.value === record.id;
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

  async function load(): Promise<Result<void, Error>> {
    if (loaded) return ok(undefined);
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
      if (!parsed.ok) {
        return err(new Error("Announcement terminal decision index is invalid"));
      }
      if (isAnnouncementTerminalRetirementRecord(parsed.value)) {
        retirements.set(parsed.value.id, parsed.value);
        continue;
      }
      if (!isAnnouncementTerminalDecisionRecord(parsed.value)) {
        return err(new Error("Announcement terminal decision index is invalid"));
      }
      const existing = records.get(parsed.value.keyDigest);
      if (existing && existing.outcome !== parsed.value.outcome) {
        return err(new Error("Announcement terminal decision index conflicts with its durable outcome"));
      }
      records.delete(parsed.value.keyDigest);
      records.set(parsed.value.keyDigest, parsed.value);
    }
    loaded = true;
    return ok(undefined);
  }

  async function persist(): Promise<{
    result: Result<void, Error>;
    snapshotVisible: boolean;
  }> {
    const path = decisionFilePath(filePath);
    if (!path.ok) return { result: path, snapshotVisible: false };
    const directory = dirname(path.value);
    const createdDirectory = await fromPromise(mkdir(directory, { recursive: true, mode: 0o700 }));
    if (!createdDirectory.ok) return { result: createdDirectory, snapshotVisible: false };
    const nonce = tryCatch(() => randomUUID());
    if (!nonce.ok) return { result: nonce, snapshotVisible: false };
    const temporaryPath = tryCatch(() => safePath(
      directory,
      `${basename(path.value)}.${nonce.value}.tmp`,
    ));
    if (!temporaryPath.ok) return { result: temporaryPath, snapshotVisible: false };
    const allRecords = [...records.values(), ...retirements.values()];
    const serialized = tryCatch(() => allRecords.length === 0
      ? ""
      : `${allRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
    if (!serialized.ok) return { result: serialized, snapshotVisible: false };
    const handle = await fromPromise(open(temporaryPath.value, "wx", 0o600));
    if (!handle.ok) return { result: handle, snapshotVisible: false };
    const written = await fromPromise(handle.value.writeFile(serialized.value, "utf8"));
    const synced = written.ok ? await fromPromise(handle.value.sync()) : written;
    const closed = await fromPromise(handle.value.close());
    if (!written.ok || !synced.ok || !closed.ok) {
      await removeFile(temporaryPath.value);
      return {
        result: !written.ok ? written : !synced.ok ? synced : closed,
        snapshotVisible: false,
      };
    }
    const replaced = await fromPromise(rename(temporaryPath.value, path.value));
    if (!replaced.ok) {
      await removeFile(temporaryPath.value);
      return { result: replaced, snapshotVisible: false };
    }
    const directorySynced = await (options.syncDirectory ?? syncDirectory)(directory);
    return { result: directorySynced, snapshotVisible: true };
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
      const persisted = await persist();
      if (!persisted.result.ok && !persisted.snapshotVisible) {
        records.clear();
        for (const [key, record] of previous) records.set(key, record);
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
      const previous = new Map(records);
      for (const [keyDigest, record] of records) {
        const remaining = record.retirementKeyDigests.filter(
          (digest) => !retiredDigests.has(digest),
        );
        if (remaining.length === record.retirementKeyDigests.length) continue;
        if (remaining.length === 0) {
          records.delete(keyDigest);
        } else {
          records.set(keyDigest, { ...record, retirementKeyDigests: remaining });
        }
      }
      if (records.size === previous.size && [...records].every(
        ([key, record]) => previous.get(key) === record,
      )) return ok(undefined);
      const persisted = await persist();
      if (!persisted.result.ok && !persisted.snapshotVisible) {
        records.clear();
        for (const [key, record] of previous) records.set(key, record);
      }
      return persisted.result;
    }),
    prepareRetirement: (completionKeys, producer) => serialize(async () => {
      const loadedIndex = await load();
      if (!loadedIndex.ok) return loadedIndex;
      if (
        completionKeys.length === 0
        || completionKeys.some((key) => typeof key !== "string" || key.length === 0)
        || producer.tenantId.length === 0
        || producer.agentId.length === 0
        || !ConversationRefSchema.safeParse(producer.conversationRef).success
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
      retirements.set(record.id, record);
      const persisted = await persist();
      if (!persisted.result.ok && !persisted.snapshotVisible) retirements.delete(record.id);
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
      const previousRecords = new Map(records);
      const previousRetirements = new Map(retirements);
      const retiredDigests = new Set(collectable.flatMap((retirement) =>
        retirement.completionKeyDigests));
      for (const [keyDigest, record] of records) {
        const remaining = record.retirementKeyDigests.filter(
          (digest) => !retiredDigests.has(digest),
        );
        if (remaining.length === record.retirementKeyDigests.length) continue;
        if (remaining.length === 0) records.delete(keyDigest);
        else records.set(keyDigest, { ...record, retirementKeyDigests: remaining });
      }
      for (const retirement of collectable) retirements.delete(retirement.id);
      const persisted = await persist();
      if (!persisted.result.ok && !persisted.snapshotVisible) {
        records.clear();
        retirements.clear();
        for (const [key, record] of previousRecords) records.set(key, record);
        for (const [key, record] of previousRetirements) retirements.set(key, record);
      }
      if (!persisted.result.ok) return err(persisted.result.error);
      return ok(collectable.length);
    }),
  };
}
