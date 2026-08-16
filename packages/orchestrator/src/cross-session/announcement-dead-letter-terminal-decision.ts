// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type {
  AnnouncementDeadLetterEntryInput,
  AnnouncementParentDecisionReservation,
  AnnouncementRetirementProducer,
  QuarantinedInvalidAnnouncementRecord,
  QuarantineReleaseOutcome,
} from "@comis/core";
import { ConversationRefSchema, safePath, systemNowMs } from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import { announcementRecoveryKey } from "./announcement-dead-letter-identity.js";
import { MAX_DEAD_LETTER_ROW_BYTES } from "./announcement-dead-letter-invalid.js";

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

type TerminalRecordKind = "terminal_decision" | "terminal_retirement";

interface TerminalStoreCorruption {
  readonly row: QuarantinedInvalidAnnouncementRecord;
  readonly kind: TerminalRecordKind;
  readonly blockedDigests: ReadonlySet<string>;
}

interface LoadedTerminalCollection {
  readonly decisions: ReadonlyMap<string, AnnouncementTerminalDecisionRecord>;
  readonly retirements: ReadonlyMap<string, AnnouncementTerminalRetirementRecord>;
  readonly corruptions: ReadonlyMap<string, TerminalStoreCorruption>;
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

function terminalCorruption(
  kind: TerminalRecordKind,
  relativePath: string,
  reason: QuarantinedInvalidAnnouncementRecord["reason"],
  rawBytes: number,
  evidence: Uint8Array | string,
  blockedDigests: readonly string[] = [],
): Result<TerminalStoreCorruption, Error> {
  return tryCatch(() => {
    const rawDigest = createHash("sha256")
      .update(kind, "utf8")
      .update("\u0000", "utf8")
      .update(relativePath, "utf8")
      .update("\u0000", "utf8")
      .update(String(rawBytes), "utf8")
      .update("\u0000", "utf8")
      .update(evidence)
      .digest("hex");
    const idDigest = createHash("sha256")
      .update(`${kind}\u0000${relativePath}`, "utf8")
      .digest("hex");
    return {
      kind,
      row: {
        id: `invalid:${idDigest}`,
        kind: "invalid_record",
        reason,
        sourceLine: 1,
        detectedAt: systemNowMs(),
        rawDigest,
        rawBytes,
      },
      blockedDigests: new Set(blockedDigests),
    };
  });
}

async function readBoundedTerminalRecord(path: string): Promise<Result<{
  readonly content?: string;
  readonly evidence: Uint8Array;
  readonly rawBytes: number;
  readonly oversized: boolean;
}, Error>> {
  const opened = await fromPromise(open(path, "r"));
  if (!opened.ok) return opened;
  const stats = await fromPromise(opened.value.stat({ bigint: true }));
  if (!stats.ok) {
    await fromPromise(opened.value.close());
    return stats;
  }
  const readLimit = stats.value.size > BigInt(MAX_DEAD_LETTER_ROW_BYTES)
    ? 4_096
    : Number(stats.value.size) + 1;
  const buffer = Buffer.alloc(readLimit);
  let offset = 0;
  let readFailure: Error | undefined;
  while (offset < buffer.length) {
    const next = await fromPromise(opened.value.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    ));
    if (!next.ok) {
      readFailure = next.error;
      break;
    }
    if (next.value.bytesRead === 0) break;
    offset += next.value.bytesRead;
  }
  const finalStats = await fromPromise(opened.value.stat({ bigint: true }));
  const closed = await fromPromise(opened.value.close());
  if (readFailure !== undefined) return err(readFailure);
  if (!finalStats.ok) return finalStats;
  if (!closed.ok) return closed;
  if (
    finalStats.value.dev !== stats.value.dev
    || finalStats.value.ino !== stats.value.ino
    || finalStats.value.size !== stats.value.size
    || finalStats.value.mtimeNs !== stats.value.mtimeNs
    || finalStats.value.ctimeNs !== stats.value.ctimeNs
  ) {
    return err(new Error("Announcement terminal record changed while reading"));
  }
  const evidence = buffer.subarray(0, offset);
  const rawBytes = stats.value.size > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Math.max(Number(stats.value.size), offset);
  const oversized = rawBytes > MAX_DEAD_LETTER_ROW_BYTES;
  return ok({
    ...(oversized ? {} : { content: evidence.toString("utf8") }),
    evidence,
    rawBytes,
    oversized,
  });
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
  listInvalid(): Promise<Result<readonly QuarantinedInvalidAnnouncementRecord[], Error>>;
} {
  const records = new Map<string, AnnouncementTerminalDecisionRecord>();
  const retirements = new Map<string, AnnouncementTerminalRetirementRecord>();
  const corruptions = new Map<string, TerminalStoreCorruption>();
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
    kind: TerminalRecordKind,
  ): Promise<Result<LoadedTerminalCollection, Error>> {
    const nextDecisions = new Map<string, AnnouncementTerminalDecisionRecord>();
    const nextRetirements = new Map<string, AnnouncementTerminalRetirementRecord>();
    const nextCorruptions = new Map<string, TerminalStoreCorruption>();
    const retainCorruption = (
      relativePath: string,
      reason: QuarantinedInvalidAnnouncementRecord["reason"],
      rawBytes: number,
      evidence: Uint8Array | string,
      blockedDigests: readonly string[] = [],
    ): Result<void, Error> => {
      const created = terminalCorruption(
        kind,
        relativePath,
        reason,
        rawBytes,
        evidence,
        blockedDigests,
      );
      if (!created.ok) return created;
      nextCorruptions.set(created.value.row.id, created.value);
      return ok(undefined);
    };
    const shards = await fromPromise(readdir(directory, { withFileTypes: true }));
    if (!shards.ok) return isMissingFile(shards.error)
      ? ok({
          decisions: nextDecisions,
          retirements: nextRetirements,
          corruptions: nextCorruptions,
        })
      : shards;
    for (const shard of shards.value) {
      if (!shard.isDirectory() || !/^[a-f0-9]{2}$/u.test(shard.name)) {
        const retained = retainCorruption(
          shard.name,
          "schema_mismatch",
          0,
          shard.name,
        );
        if (!retained.ok) return retained;
        continue;
      }
      const shardPath = tryCatch(() => safePath(directory, shard.name));
      if (!shardPath.ok) return shardPath;
      const files = await fromPromise(readdir(shardPath.value, { withFileTypes: true }));
      if (!files.ok) {
        const retained = retainCorruption(
          shard.name,
          "schema_mismatch",
          0,
          files.error.message,
        );
        if (!retained.ok) return retained;
        continue;
      }
      for (const file of files.value) {
        const relativePath = `${shard.name}/${file.name}`;
        if (/^[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/u.test(file.name)) {
          const temporaryPath = tryCatch(() => safePath(shardPath.value, file.name));
          if (!temporaryPath.ok) return temporaryPath;
          const removed = await fromPromise(unlink(temporaryPath.value));
          if (!removed.ok && !isMissingFile(removed.error)) {
            const retained = retainCorruption(
              relativePath,
              "schema_mismatch",
              0,
              file.name,
            );
            if (!retained.ok) return retained;
          }
          continue;
        }
        if (!file.isFile() || !/^[a-f0-9]{64}\.json$/u.test(file.name)) {
          const retained = retainCorruption(
            relativePath,
            "schema_mismatch",
            0,
            file.name,
          );
          if (!retained.ok) return retained;
          continue;
        }
        const path = tryCatch(() => safePath(shardPath.value, file.name));
        if (!path.ok) return path;
        const fileDigest = file.name.slice(0, 64);
        const content = await readBoundedTerminalRecord(path.value);
        if (!content.ok) {
          const retained = retainCorruption(
            relativePath,
            "schema_mismatch",
            0,
            content.error.message,
            [fileDigest],
          );
          if (!retained.ok) return retained;
          continue;
        }
        if (content.value.oversized) {
          const retained = retainCorruption(
            relativePath,
            "oversized_row",
            content.value.rawBytes,
            content.value.evidence,
            [fileDigest],
          );
          if (!retained.ok) return retained;
          continue;
        }
        const parsed = tryCatch(() => JSON.parse(content.value.content!) as unknown);
        if (!parsed.ok) {
          const retained = retainCorruption(
            relativePath,
            "invalid_json",
            content.value.rawBytes,
            content.value.evidence,
            [fileDigest],
          );
          if (!retained.ok) return retained;
          continue;
        }
        if (kind === "terminal_decision") {
          if (
            !isAnnouncementTerminalDecisionRecord(parsed.value)
            || file.name !== `${parsed.value.keyDigest}.json`
            || shard.name !== parsed.value.keyDigest.slice(0, 2)
          ) {
            const parsedDigest = isAnnouncementTerminalDecisionRecord(parsed.value)
              ? parsed.value.keyDigest
              : undefined;
            const retained = retainCorruption(
              relativePath,
              "schema_mismatch",
              content.value.rawBytes,
              content.value.evidence,
              parsedDigest === undefined ? [fileDigest] : [fileDigest, parsedDigest],
            );
            if (!retained.ok) return retained;
            continue;
          }
          nextDecisions.set(parsed.value.keyDigest, parsed.value);
        } else {
          if (
            !isAnnouncementTerminalRetirementRecord(parsed.value)
            || file.name !== `${parsed.value.id.slice("retirement:".length)}.json`
            || shard.name !== parsed.value.id.slice("retirement:".length, "retirement:".length + 2)
          ) {
            const parsedDigest = isAnnouncementTerminalRetirementRecord(parsed.value)
              ? parsed.value.id.slice("retirement:".length)
              : undefined;
            const retained = retainCorruption(
              relativePath,
              "schema_mismatch",
              content.value.rawBytes,
              content.value.evidence,
              parsedDigest === undefined ? [fileDigest] : [fileDigest, parsedDigest],
            );
            if (!retained.ok) return retained;
            continue;
          }
          nextRetirements.set(parsed.value.id, parsed.value);
        }
      }
    }
    return ok({
      decisions: nextDecisions,
      retirements: nextRetirements,
      corruptions: nextCorruptions,
    });
  }

  async function inspectCollections(): Promise<Result<LoadedTerminalCollection, Error>> {
    const paths = decisionStoragePaths(filePath);
    if (!paths.ok) return paths;
    const loadedDecisions = await loadCollection(paths.value.decisions, "terminal_decision");
    if (!loadedDecisions.ok) return loadedDecisions;
    const loadedRetirements = await loadCollection(paths.value.retirements, "terminal_retirement");
    if (!loadedRetirements.ok) return loadedRetirements;
    return ok({
      decisions: loadedDecisions.value.decisions,
      retirements: loadedRetirements.value.retirements,
      corruptions: new Map([
        ...loadedDecisions.value.corruptions,
        ...loadedRetirements.value.corruptions,
      ]),
    });
  }

  function adoptCollection(collection: LoadedTerminalCollection): void {
    records.clear();
    retirements.clear();
    corruptions.clear();
    for (const [digest, record] of collection.decisions) records.set(digest, record);
    for (const [id, record] of collection.retirements) retirements.set(id, record);
    for (const [id, corruption] of collection.corruptions) corruptions.set(id, corruption);
    loaded = true;
  }

  async function refresh(): Promise<Result<void, Error>> {
    const inspected = await inspectCollections();
    if (!inspected.ok) return inspected;
    adoptCollection(inspected.value);
    return ok(undefined);
  }

  async function load(): Promise<Result<void, Error>> {
    if (loaded) return ok(undefined);
    return refresh();
  }

  function isDigestBlocked(kind: TerminalRecordKind, digest: string): boolean {
    return [...corruptions.values()].some((corruption) =>
      corruption.kind === kind && corruption.blockedDigests.has(digest));
  }

  async function refreshTerminalRecord(
    expected: AnnouncementTerminalDecisionRecord | AnnouncementTerminalRetirementRecord,
  ): Promise<Result<void, Error>> {
    const kind: TerminalRecordKind = expected.recordType === "terminal_decision"
      ? "terminal_decision"
      : "terminal_retirement";
    const digest = expected.recordType === "terminal_decision"
      ? expected.keyDigest
      : expected.id.slice("retirement:".length);
    const cached = expected.recordType === "terminal_decision"
      ? records.has(expected.keyDigest)
      : retirements.has(expected.id);
    if (cached && !isDigestBlocked(kind, digest)) return ok(undefined);
    const paths = decisionStoragePaths(filePath);
    if (!paths.ok) return paths;
    const path = terminalRecordPath(paths.value, expected);
    if (!path.ok) return path;
    const relativePath = `${digest.slice(0, 2)}/${digest}.json`;
    const corruptionIdentity = terminalCorruption(
      kind,
      relativePath,
      "schema_mismatch",
      0,
      "",
    );
    if (!corruptionIdentity.ok) return corruptionIdentity;
    const content = await readBoundedTerminalRecord(path.value);
    if (!content.ok && isMissingFile(content.error)) {
      corruptions.delete(corruptionIdentity.value.row.id);
      if (expected.recordType === "terminal_decision") records.delete(expected.keyDigest);
      else retirements.delete(expected.id);
      return ok(undefined);
    }
    const rejectRecord = (
      reason: QuarantinedInvalidAnnouncementRecord["reason"],
      rawBytes: number,
      evidence: Uint8Array | string,
    ): Result<void, Error> => {
      const corruption = terminalCorruption(
        kind,
        relativePath,
        reason,
        rawBytes,
        evidence,
        [digest],
      );
      if (!corruption.ok) return corruption;
      corruptions.set(corruption.value.row.id, corruption.value);
      if (expected.recordType === "terminal_decision") records.delete(expected.keyDigest);
      else retirements.delete(expected.id);
      return err(new Error("Announcement terminal record is invalid"));
    };
    if (!content.ok) return rejectRecord("schema_mismatch", 0, content.error.message);
    if (content.value.oversized) {
      return rejectRecord(
        "oversized_row",
        content.value.rawBytes,
        content.value.evidence,
      );
    }
    const parsed = tryCatch(() => JSON.parse(content.value.content!) as unknown);
    if (!parsed.ok) {
      return rejectRecord("invalid_json", content.value.rawBytes, content.value.evidence);
    }
    if (expected.recordType === "terminal_decision") {
      if (
        !isAnnouncementTerminalDecisionRecord(parsed.value)
        || parsed.value.keyDigest !== expected.keyDigest
      ) {
        return rejectRecord("schema_mismatch", content.value.rawBytes, content.value.evidence);
      }
      records.set(parsed.value.keyDigest, parsed.value);
    } else {
      if (
        !isAnnouncementTerminalRetirementRecord(parsed.value)
        || parsed.value.id !== expected.id
      ) {
        return rejectRecord("schema_mismatch", content.value.rawBytes, content.value.evidence);
      }
      retirements.set(parsed.value.id, parsed.value);
    }
    corruptions.delete(corruptionIdentity.value.row.id);
    return ok(undefined);
  }

  async function lookupLoaded(
    owner: TerminalDecisionOwner,
  ): Promise<Result<AnnouncementTerminalDecision | undefined, Error>> {
    const loadedIndex = await load();
    if (!loadedIndex.ok) return loadedIndex;
    const expected = createTerminalDecisionRecord(owner, "no_reply", 0);
    if (!expected.ok) return expected;
    const refreshed = await refreshTerminalRecord(expected.value);
    if (!refreshed.ok) return refreshed;
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
      const refreshed = await refreshTerminalRecord(created.value);
      if (!refreshed.ok) return refreshed;
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
      const record: AnnouncementTerminalRetirementRecord = {
        recordType: "terminal_retirement",
        id: id.value,
        producer,
        completionKeyDigests,
        preparedAt: systemNowMs(),
      };
      const refreshed = await refreshTerminalRecord(record);
      if (!refreshed.ok) return refreshed;
      if (retirements.has(id.value)) return ok(undefined);
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
    listInvalid: () => serialize(async () => {
      if (!loaded || corruptions.size > 0) {
        const refreshed = await refresh();
        if (!refreshed.ok) return refreshed;
      }
      return ok([...corruptions.values()]
        .map((corruption) => corruption.row)
        .sort((left, right) => left.id.localeCompare(right.id)));
    }),
  };
}
