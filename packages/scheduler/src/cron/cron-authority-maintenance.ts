// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ClockPort, ErrorKind, FileLockPort } from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import { z } from "zod";
import { replaceDurableFile } from "../persistence/durable-file.js";
import {
  CRON_STORE_FORMAT_VERSION,
  encodeCronStoreRoot,
  type CronStoreRoot,
} from "./cron-store.js";

const RESET_INTENT_FORMAT_VERSION = 1;
const MAX_RESET_INTENT_BYTES = 64 * 1_024;
const LOCK_OPTIONS = { staleMs: 30_000, updateMs: 5_000 } as const;
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdentifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const TargetSchema = z.enum(["store", "ledger", "all"]);
const PhaseSchema = z.enum([
  "prepared",
  "archives_recorded",
  "replacements_recorded",
  "completion_recorded",
]);

const ResetIntentSchema = z.strictObject({
  formatVersion: z.literal(RESET_INTENT_FORMAT_VERSION),
  operationId: IdentifierSchema,
  target: TargetSchema,
  selectedTargets: z.array(z.enum(["store", "ledger"])).min(1).max(2),
  expectedDigests: z.strictObject({
    store: DigestSchema.nullable(),
    ledger: DigestSchema.nullable(),
  }),
  archiveNames: z.strictObject({
    store: z.string().min(1).max(512).nullable(),
    ledger: z.string().min(1).max(512).nullable(),
  }),
  replacementStoreSeed: IdentifierSchema.nullable(),
  phase: PhaseSchema,
  createdAtMs: z.number().int().nonnegative().safe(),
});

type ResetIntent = z.infer<typeof ResetIntentSchema>;
export type CronAuthorityResetTarget = z.infer<typeof TargetSchema>;
type AuthorityTarget = "store" | "ledger";

export type CronAuthorityDurableStep =
  | "intent_prepared"
  | "store_archived"
  | "ledger_archived"
  | "archives_recorded"
  | "store_replaced"
  | "ledger_replaced"
  | "replacements_recorded"
  | "completion_recorded";

export type CronAuthorityMaintenanceErrorCode =
  | "invalid_input"
  | "invalid_path"
  | "confirmation_required"
  | "digest_mismatch"
  | "intent_present"
  | "intent_invalid"
  | "intent_ambiguous"
  | "archive_conflict"
  | "lock_contended"
  | "lock_failed"
  | "io"
  | "interrupted";

export type CronAuthorityMaintenanceError = {
  code: CronAuthorityMaintenanceErrorCode;
  errorKind: ErrorKind;
  message: string;
};

export type CronRawAuthorityState = {
  exists: boolean;
  bytes: number;
  digest: string | null;
};

export type CronAuthorityInspection = {
  store: CronRawAuthorityState;
  ledger: CronRawAuthorityState;
  intent:
    | { status: "none" }
    | {
      status: "pending";
      operationId: string;
      target: CronAuthorityResetTarget;
      phase: ResetIntent["phase"];
      digest: string;
    }
    | { status: "invalid"; digest: string };
};

export type CronAuthorityResetRequest =
  | { target: "store"; expectedDigests: { store: string | null }; confirmed: boolean }
  | { target: "ledger"; expectedDigests: { ledger: string | null }; confirmed: boolean }
  | {
    target: "all";
    expectedDigests: { store: string | null; ledger: string | null };
    confirmed: boolean;
  };

type DigestPair = { store: string | null; ledger: string | null };

export type CronAuthorityResetResult = {
  operationId: string;
  target: CronAuthorityResetTarget;
  beforeDigests: DigestPair;
  afterDigests: DigestPair;
};

export type CronAuthorityRecoveryResult =
  | { status: "none" }
  | {
    status: "recovered";
    operationId: string;
    target: CronAuthorityResetTarget;
    beforeDigests: DigestPair;
    afterDigests: DigestPair;
  };

export interface CronAuthorityMaintenance {
  inspect(): Promise<Result<CronAuthorityInspection, CronAuthorityMaintenanceError>>;
  recoverPendingReset(): Promise<Result<CronAuthorityRecoveryResult, CronAuthorityMaintenanceError>>;
  reset(request: CronAuthorityResetRequest): Promise<Result<CronAuthorityResetResult, CronAuthorityMaintenanceError>>;
}

export interface CronAuthorityMaintenanceOptions {
  directory: string;
  storePath: string;
  ledgerPath: string;
  intentPath: string;
  storeLockPath: string;
  ledgerLockPath: string;
  fileLock: FileLockPort;
  clock: ClockPort;
  idFactory: () => string;
  durableStepGate?: (
    step: CronAuthorityDurableStep,
  ) => Promise<Result<void, CronAuthorityMaintenanceError>>;
}

type IntentInspection =
  | { status: "none" }
  | { status: "valid"; intent: ResetIntent; digest: string }
  | { status: "invalid"; digest: string };

export function createCronAuthorityMaintenance(
  options: CronAuthorityMaintenanceOptions,
): CronAuthorityMaintenance {
  const optionsError = validateOptions(options);

  async function inspect(): Promise<Result<CronAuthorityInspection, CronAuthorityMaintenanceError>> {
    if (optionsError !== undefined) return err(optionsError);
    return withAuthorityLocks(async () => inspectUnlocked());
  }

  async function inspectUnlocked(): Promise<Result<CronAuthorityInspection, CronAuthorityMaintenanceError>> {
    const store = await inspectRawFile(options.storePath);
    if (!store.ok) return store;
    const ledger = await inspectRawFile(options.ledgerPath);
    if (!ledger.ok) return ledger;
    const intent = await inspectIntent();
    if (!intent.ok) return intent;
    if (intent.value.status === "none") {
      return ok({ store: store.value, ledger: ledger.value, intent: { status: "none" } });
    }
    if (intent.value.status === "invalid") {
      return ok({ store: store.value, ledger: ledger.value, intent: { status: "invalid", digest: intent.value.digest } });
    }
    return ok({
      store: store.value,
      ledger: ledger.value,
      intent: {
        status: "pending",
        operationId: intent.value.intent.operationId,
        target: intent.value.intent.target,
        phase: intent.value.intent.phase,
        digest: intent.value.digest,
      },
    });
  }

  async function recoverPendingReset(): Promise<Result<CronAuthorityRecoveryResult, CronAuthorityMaintenanceError>> {
    if (optionsError !== undefined) return err(optionsError);
    return withAuthorityLocks<CronAuthorityRecoveryResult>(async () => {
      const inspected = await inspectIntent();
      if (!inspected.ok) return inspected;
      if (inspected.value.status === "none") return ok({ status: "none" });
      if (inspected.value.status === "invalid") {
        return err(maintenanceError("intent_invalid", "validation", "Cron reset intent does not match its strict format"));
      }
      const rolled = await rollForward(inspected.value.intent);
      if (!rolled.ok) return rolled;
      return ok({ status: "recovered", ...rolled.value });
    });
  }

  async function reset(
    request: CronAuthorityResetRequest,
  ): Promise<Result<CronAuthorityResetResult, CronAuthorityMaintenanceError>> {
    if (optionsError !== undefined) return err(optionsError);
    const requestError = validateRequest(request);
    if (requestError !== undefined) return err(requestError);
    if (!request.confirmed) {
      return err(maintenanceError("confirmation_required", "precondition", "Cron authority reset requires explicit confirmation"));
    }
    return withAuthorityLocks(async () => {
      const existingIntent = await inspectIntent();
      if (!existingIntent.ok) return existingIntent;
      if (existingIntent.value.status !== "none") {
        return err(maintenanceError(
          existingIntent.value.status === "invalid" ? "intent_invalid" : "intent_present",
          existingIntent.value.status === "invalid" ? "validation" : "precondition",
          "A cron reset intent already requires recovery or operator inspection",
        ));
      }
      const before = await inspectPair();
      if (!before.ok) return before;
      const matches = requestMatches(request, before.value);
      if (!matches) {
        return err(maintenanceError("digest_mismatch", "precondition", "Cron authority changed after status inspection"));
      }

      const operationId = nextIdentifier("reset operation");
      if (!operationId.ok) return operationId;
      const selectedTargets = targetsFor(request.target);
      const replacementStoreSeed = selectedTargets.includes("store")
        ? nextIdentifier("scheduler seed")
        : ok(null);
      if (!replacementStoreSeed.ok) return replacementStoreSeed;
      const intent: ResetIntent = {
        formatVersion: RESET_INTENT_FORMAT_VERSION,
        operationId: operationId.value,
        target: request.target,
        selectedTargets,
        expectedDigests: before.value,
        archiveNames: {
          store: selectedTargets.includes("store") ? path.basename(archivePath("store", operationId.value)) : null,
          ledger: selectedTargets.includes("ledger") ? path.basename(archivePath("ledger", operationId.value)) : null,
        },
        replacementStoreSeed: replacementStoreSeed.value,
        phase: "prepared",
        createdAtMs: options.clock.now(),
      };
      const validIntent = validateIntent(intent);
      if (!validIntent.ok) return validIntent;
      for (const target of selectedTargets) {
        const archive = await inspectRawFile(archivePath(target, operationId.value));
        if (!archive.ok) return archive;
        if (archive.value.exists) {
          return err(maintenanceError("archive_conflict", "precondition", "Cron reset archive name already exists"));
        }
      }
      const written = await writeIntent(intent);
      if (!written.ok) return written;
      const gated = await passStep("intent_prepared");
      if (!gated.ok) return gated;
      return rollForward(intent);
    });
  }

  async function rollForward(
    original: ResetIntent,
  ): Promise<Result<CronAuthorityResetResult, CronAuthorityMaintenanceError>> {
    let intent = original;
    const replacement = replacementBytes(intent);
    if (!replacement.ok) return replacement;
    for (const target of intent.selectedTargets) {
      const archived = await ensureArchived(intent, target, replacement.value[target]);
      if (!archived.ok) return archived;
      const gated = await passStep(target === "store" ? "store_archived" : "ledger_archived");
      if (!gated.ok) return gated;
    }
    if (phaseRank(intent.phase) < phaseRank("archives_recorded")) {
      intent = { ...intent, phase: "archives_recorded" };
      const recorded = await writeIntent(intent);
      if (!recorded.ok) return recorded;
      const gated = await passStep("archives_recorded");
      if (!gated.ok) return gated;
    }

    for (const target of intent.selectedTargets) {
      const replaced = await ensureReplaced(intent, target, replacement.value[target]);
      if (!replaced.ok) return replaced;
      const gated = await passStep(target === "store" ? "store_replaced" : "ledger_replaced");
      if (!gated.ok) return gated;
    }
    if (phaseRank(intent.phase) < phaseRank("replacements_recorded")) {
      intent = { ...intent, phase: "replacements_recorded" };
      const recorded = await writeIntent(intent);
      if (!recorded.ok) return recorded;
      const gated = await passStep("replacements_recorded");
      if (!gated.ok) return gated;
    }
    if (phaseRank(intent.phase) < phaseRank("completion_recorded")) {
      intent = { ...intent, phase: "completion_recorded" };
      const completed = await writeIntent(intent);
      if (!completed.ok) return completed;
      const gated = await passStep("completion_recorded");
      if (!gated.ok) return gated;
    }
    const removed = await removeIntent();
    if (!removed.ok) return removed;
    const after = await inspectPair();
    if (!after.ok) return after;
    return ok({
      operationId: intent.operationId,
      target: intent.target,
      beforeDigests: intent.expectedDigests,
      afterDigests: after.value,
    });
  }

  async function ensureArchived(
    intent: ResetIntent,
    target: AuthorityTarget,
    replacementBytesForTarget: Buffer | null,
  ): Promise<Result<void, CronAuthorityMaintenanceError>> {
    const authority = await inspectRawFile(authorityPath(target));
    if (!authority.ok) return authority;
    const archiveFile = archivePath(target, intent.operationId);
    const archive = await inspectRawFile(archiveFile);
    if (!archive.ok) return archive;
    const expected = intent.expectedDigests[target];
    const replacementDigest = replacementBytesForTarget === null ? null : digest(replacementBytesForTarget);
    if (expected === null) {
      if (archive.value.exists) return ambiguous();
      if (!authority.value.exists || authority.value.digest === replacementDigest) return ok(undefined);
      return ambiguous();
    }
    if (
      archive.value.exists
      && archive.value.digest === expected
      && (!authority.value.exists || authority.value.digest === replacementDigest)
    ) {
      const secured = await secureArchive(archiveFile);
      return secured.ok ? ok(undefined) : secured;
    }
    if (!archive.value.exists && authority.value.digest === expected) {
      const renamed = await fromPromise(fs.rename(authorityPath(target), archiveFile));
      if (!renamed.ok) return err(ioError("Unable to archive cron authority file"));
      return secureArchive(archiveFile);
    }
    return ambiguous();
  }

  async function ensureReplaced(
    intent: ResetIntent,
    target: AuthorityTarget,
    bytes: Buffer | null,
  ): Promise<Result<void, CronAuthorityMaintenanceError>> {
    if (bytes === null) return ambiguous();
    const authority = await inspectRawFile(authorityPath(target));
    if (!authority.ok) return authority;
    const archive = await inspectRawFile(archivePath(target, intent.operationId));
    if (!archive.ok) return archive;
    const expected = intent.expectedDigests[target];
    if (expected === null) {
      if (archive.value.exists) return ambiguous();
    } else if (!archive.value.exists || archive.value.digest !== expected) {
      return ambiguous();
    }
    const replacementDigest = digest(bytes);
    if (authority.value.exists) {
      return authority.value.digest === replacementDigest ? ok(undefined) : ambiguous();
    }
    const replaced = await replaceDurableFile({
      filePath: authorityPath(target),
      bytes,
      temporaryToken: options.idFactory,
    });
    return replaced.ok
      ? replaced
      : err(maintenanceError(
        replaced.error.code === "invalid_input" ? "invalid_input" : "io",
        replaced.error.errorKind,
        "Unable to create strict empty cron authority",
      ));
  }

  async function secureArchive(archiveFile: string): Promise<Result<void, CronAuthorityMaintenanceError>> {
    const secured = await fromPromise(fs.chmod(archiveFile, 0o600));
    if (!secured.ok) return err(ioError("Unable to secure cron reset archive"));
    return syncDirectory();
  }

  async function writeIntent(intent: ResetIntent): Promise<Result<void, CronAuthorityMaintenanceError>> {
    const validated = validateIntent(intent);
    if (!validated.ok) return validated;
    const bytes = Buffer.from(`${JSON.stringify(intent)}\n`, "utf8");
    if (bytes.byteLength > MAX_RESET_INTENT_BYTES) {
      return err(maintenanceError("invalid_input", "validation", "Cron reset intent exceeds its byte ceiling"));
    }
    const replaced = await replaceDurableFile({
      filePath: options.intentPath,
      bytes,
      temporaryToken: options.idFactory,
    });
    return replaced.ok
      ? replaced
      : err(maintenanceError(
        replaced.error.code === "invalid_input" ? "invalid_input" : "io",
        replaced.error.errorKind,
        "Unable to durably write cron reset intent",
      ));
  }

  async function removeIntent(): Promise<Result<void, CronAuthorityMaintenanceError>> {
    const removed = await fromPromise(fs.unlink(options.intentPath));
    if (!removed.ok && !isNodeError(removed.error, "ENOENT")) {
      return err(ioError("Unable to remove completed cron reset intent"));
    }
    return syncDirectory();
  }

  async function syncDirectory(): Promise<Result<void, CronAuthorityMaintenanceError>> {
    const opened = await fromPromise(fs.open(options.directory, "r"));
    if (!opened.ok) return err(ioError("Unable to open cron authority directory for synchronization"));
    const synced = await fromPromise(opened.value.sync());
    const closed = await fromPromise(opened.value.close());
    return synced.ok && closed.ok
      ? ok(undefined)
      : err(ioError("Unable to synchronize cron authority directory"));
  }

  async function inspectPair(): Promise<Result<DigestPair, CronAuthorityMaintenanceError>> {
    const store = await inspectRawFile(options.storePath);
    if (!store.ok) return store;
    const ledger = await inspectRawFile(options.ledgerPath);
    if (!ledger.ok) return ledger;
    return ok({ store: store.value.digest, ledger: ledger.value.digest });
  }

  async function inspectIntent(): Promise<Result<IntentInspection, CronAuthorityMaintenanceError>> {
    const metadata = await inspectRawFile(options.intentPath);
    if (!metadata.ok) return metadata;
    if (!metadata.value.exists) return ok({ status: "none" });
    if (metadata.value.bytes > MAX_RESET_INTENT_BYTES) {
      if (metadata.value.digest === null) {
        return err(maintenanceError("intent_invalid", "internal", "Existing cron reset intent has no raw digest"));
      }
      return ok({ status: "invalid", digest: metadata.value.digest });
    }
    const raw = await readBoundedFile(options.intentPath, MAX_RESET_INTENT_BYTES);
    if (!raw.ok) return raw;
    if (raw.value === null) {
      return err(maintenanceError("intent_ambiguous", "precondition", "Cron reset intent changed during inspection"));
    }
    const bytes = raw.value;
    const rawDigest = digest(bytes);
    const decoded = tryCatch(() => JSON.parse(bytes.toString("utf8")) as unknown);
    if (!decoded.ok) return ok({ status: "invalid", digest: rawDigest });
    const parsed = ResetIntentSchema.safeParse(decoded.value);
    if (!parsed.success || !validIntentSemantics(parsed.data)) {
      return ok({ status: "invalid", digest: rawDigest });
    }
    return ok({ status: "valid", intent: parsed.data, digest: rawDigest });
  }

  async function passStep(step: CronAuthorityDurableStep): Promise<Result<void, CronAuthorityMaintenanceError>> {
    if (options.durableStepGate === undefined) return ok(undefined);
    const called = await fromPromise(options.durableStepGate(step));
    if (!called.ok) {
      return err(maintenanceError("interrupted", "internal", "Cron reset durable-step gate failed"));
    }
    return called.value;
  }

  async function withAuthorityLocks<T>(
    operation: () => Promise<Result<T, CronAuthorityMaintenanceError>>,
  ): Promise<Result<T, CronAuthorityMaintenanceError>> {
    const storeLocked = await options.fileLock.withLock(options.storeLockPath, async () => {
      const ledgerLocked = await options.fileLock.withLock(options.ledgerLockPath, operation, LOCK_OPTIONS);
      return ledgerLocked.ok
        ? ledgerLocked.value
        : err(lockError(ledgerLocked.error.kind, ledgerLocked.error.message));
    }, LOCK_OPTIONS);
    return storeLocked.ok
      ? storeLocked.value
      : err(lockError(storeLocked.error.kind, storeLocked.error.message));
  }

  function authorityPath(target: AuthorityTarget): string {
    return target === "store" ? options.storePath : options.ledgerPath;
  }

  function archivePath(target: AuthorityTarget, operationId: string): string {
    return `${authorityPath(target)}.${operationId}.archive`;
  }

  function nextIdentifier(purpose: string): Result<string, CronAuthorityMaintenanceError> {
    const generated = tryCatch(options.idFactory);
    return generated.ok && IdentifierSchema.safeParse(generated.value).success
      ? ok(generated.value)
      : err(maintenanceError("invalid_input", "validation", `Opaque id factory returned an invalid ${purpose} identifier`));
  }

  return { inspect, recoverPendingReset, reset };
}

async function inspectRawFile(
  filePath: string,
): Promise<Result<CronRawAuthorityState, CronAuthorityMaintenanceError>> {
  const pathMetadata = await fromPromise(fs.lstat(filePath));
  if (!pathMetadata.ok) {
    return isNodeError(pathMetadata.error, "ENOENT")
      ? ok({ exists: false, bytes: 0, digest: null })
      : err(ioError("Unable to inspect cron authority path"));
  }
  if (!pathMetadata.value.isFile()) {
    return err(maintenanceError("invalid_path", "validation", "Cron authority path must resolve directly to a regular file"));
  }
  const opened = await fromPromise(fs.open(filePath, "r"));
  if (!opened.ok) {
    return isNodeError(opened.error, "ENOENT")
      ? ok({ exists: false, bytes: 0, digest: null })
      : err(ioError("Unable to inspect cron authority file"));
  }
  const handle = opened.value;
  const metadata = await fromPromise(handle.stat());
  if (
    !metadata.ok
    || !metadata.value.isFile()
    || metadata.value.dev !== pathMetadata.value.dev
    || metadata.value.ino !== pathMetadata.value.ino
  ) {
    await fromPromise(handle.close());
    return err(maintenanceError("invalid_path", "validation", "Cron authority path must resolve to a regular file"));
  }
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1_024);
  let bytes = 0;
  while (true) {
    const read = await fromPromise(handle.read(buffer, 0, buffer.byteLength, null));
    if (!read.ok) {
      await fromPromise(handle.close());
      return err(ioError("Unable to hash cron authority file"));
    }
    if (read.value.bytesRead === 0) break;
    bytes += read.value.bytesRead;
    if (!Number.isSafeInteger(bytes)) {
      await fromPromise(handle.close());
      return err(maintenanceError("invalid_input", "resource", "Cron authority byte count exceeds safe integer range"));
    }
    hash.update(buffer.subarray(0, read.value.bytesRead));
  }
  const closed = await fromPromise(handle.close());
  return closed.ok
    ? ok({ exists: true, bytes, digest: hash.digest("hex") })
    : err(ioError("Unable to close cron authority file after inspection"));
}

async function readBoundedFile(
  filePath: string,
  maxBytes: number,
): Promise<Result<Buffer | null, CronAuthorityMaintenanceError>> {
  const metadata = await fromPromise(fs.lstat(filePath));
  if (!metadata.ok) {
    return isNodeError(metadata.error, "ENOENT")
      ? ok(null)
      : err(ioError("Unable to inspect cron reset intent"));
  }
  if (!metadata.value.isFile() || metadata.value.size > maxBytes) {
    return err(maintenanceError("intent_invalid", "validation", "Cron reset intent is not a bounded regular file"));
  }
  const read = await fromPromise(fs.readFile(filePath));
  return read.ok ? ok(read.value) : err(ioError("Unable to read cron reset intent"));
}

function replacementBytes(
  intent: ResetIntent,
): Result<Record<AuthorityTarget, Buffer | null>, CronAuthorityMaintenanceError> {
  let store: Buffer | null = null;
  if (intent.selectedTargets.includes("store")) {
    if (intent.replacementStoreSeed === null) return ambiguous();
    const root: CronStoreRoot = {
      formatVersion: CRON_STORE_FORMAT_VERSION,
      agentSchedulerSeed: intent.replacementStoreSeed,
      jobs: [],
      activeClaims: [],
    };
    const encoded = encodeCronStoreRoot(root);
    if (!encoded.ok) {
      return err(maintenanceError("intent_invalid", encoded.error.errorKind, "Cron reset intent cannot create a strict empty store"));
    }
    store = encoded.value;
  }
  return ok({ store, ledger: intent.selectedTargets.includes("ledger") ? Buffer.alloc(0) : null });
}

function validateOptions(options: CronAuthorityMaintenanceOptions): CronAuthorityMaintenanceError | undefined {
  const paths = [
    options.directory,
    options.storePath,
    options.ledgerPath,
    options.intentPath,
    options.storeLockPath,
    options.ledgerLockPath,
  ];
  if (paths.some((candidate) => !path.isAbsolute(candidate)) || path.resolve(options.directory) !== options.directory) {
    return maintenanceError("invalid_path", "validation", "Cron authority maintenance requires normalized absolute paths");
  }
  if (paths.slice(1).some((candidate) => path.dirname(candidate) !== options.directory)) {
    return maintenanceError("invalid_path", "validation", "Cron authority files and locks must share one directory");
  }
  if (new Set(paths.slice(1)).size !== paths.length - 1) {
    return maintenanceError("invalid_path", "validation", "Cron authority files and locks must use distinct paths");
  }
  return undefined;
}

function validateRequest(request: CronAuthorityResetRequest): CronAuthorityMaintenanceError | undefined {
  let values: (string | null)[];
  switch (request.target) {
    case "store": values = [request.expectedDigests.store]; break;
    case "ledger": values = [request.expectedDigests.ledger]; break;
    case "all": values = [request.expectedDigests.store, request.expectedDigests.ledger]; break;
    default: {
      const _exhaustive: never = request;
      return _exhaustive;
    }
  }
  if (values.some((value) => value !== null && !DigestSchema.safeParse(value).success)) {
    return maintenanceError("invalid_input", "validation", "Expected cron authority digests must be SHA-256 values or null");
  }
  return undefined;
}

function validateIntent(intent: ResetIntent): Result<void, CronAuthorityMaintenanceError> {
  return ResetIntentSchema.safeParse(intent).success && validIntentSemantics(intent)
    ? ok(undefined)
    : err(maintenanceError("intent_invalid", "validation", "Cron reset intent does not match its strict format"));
}

function validIntentSemantics(intent: ResetIntent): boolean {
  const targets = targetsFor(intent.target);
  if (intent.selectedTargets.length !== targets.length) return false;
  if (intent.selectedTargets.some((target, index) => target !== targets[index])) return false;
  for (const target of ["store", "ledger"] as const) {
    const selected = targets.includes(target);
    const expectedArchive = selected ? `${target === "store" ? "cron-jobs.json" : "cron-executions.jsonl"}.${intent.operationId}.archive` : null;
    if (intent.archiveNames[target] !== expectedArchive) return false;
  }
  return targets.includes("store") === (intent.replacementStoreSeed !== null);
}

function requestMatches(request: CronAuthorityResetRequest, actual: DigestPair): boolean {
  switch (request.target) {
    case "store": return request.expectedDigests.store === actual.store;
    case "ledger": return request.expectedDigests.ledger === actual.ledger;
    case "all": return request.expectedDigests.store === actual.store
      && request.expectedDigests.ledger === actual.ledger;
    default: {
      const _exhaustive: never = request;
      return _exhaustive;
    }
  }
}

function targetsFor(target: CronAuthorityResetTarget): AuthorityTarget[] {
  switch (target) {
    case "store": return ["store"];
    case "ledger": return ["ledger"];
    case "all": return ["store", "ledger"];
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

function phaseRank(phase: ResetIntent["phase"]): number {
  switch (phase) {
    case "prepared": return 0;
    case "archives_recorded": return 1;
    case "replacements_recorded": return 2;
    case "completion_recorded": return 3;
    default: {
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function ambiguous(): Result<never, CronAuthorityMaintenanceError> {
  return err(maintenanceError(
    "intent_ambiguous",
    "precondition",
    "Cron reset intent facts do not unambiguously match a recoverable transaction",
  ));
}

function lockError(kind: "locked" | "error", message: string): CronAuthorityMaintenanceError {
  return maintenanceError(
    kind === "locked" ? "lock_contended" : "lock_failed",
    kind === "locked" ? "precondition" : "internal",
    message,
  );
}

function ioError(message: string): CronAuthorityMaintenanceError {
  return maintenanceError("io", "internal", message);
}

function maintenanceError(
  code: CronAuthorityMaintenanceErrorCode,
  errorKind: ErrorKind,
  message: string,
): CronAuthorityMaintenanceError {
  return { code, errorKind, message };
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
