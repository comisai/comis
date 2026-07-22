// SPDX-License-Identifier: Apache-2.0
/** Crash-recoverable maintenance for the single follow-up task authority file. */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ClockPort, ErrorKind, FileLockPort } from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import { z } from "zod";
import { replaceDurableFile } from "../persistence/durable-file.js";
import { encodeFollowupTaskStore } from "./task-store.js";
import type { FollowupTaskStoreFile } from "./task-types.js";

const RESET_INTENT_FORMAT_VERSION = 1;
const MAX_RESET_INTENT_BYTES = 64 * 1_024;
const LOCK_OPTIONS = { staleMs: 30_000, updateMs: 5_000 } as const;
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const IdentifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u);
const PhaseSchema = z.enum(["prepared", "archive_recorded", "replacement_recorded", "completion_recorded"]);

const ResetIntentSchema = z.strictObject({
  formatVersion: z.literal(RESET_INTENT_FORMAT_VERSION),
  operationId: IdentifierSchema,
  expectedDigest: DigestSchema.nullable(),
  archiveName: z.string().min(1).max(512),
  phase: PhaseSchema,
  createdAtMs: z.number().int().nonnegative().safe(),
});

type ResetIntent = z.infer<typeof ResetIntentSchema>;

export type TaskAuthorityDurableStep =
  | "intent_prepared"
  | "store_archived"
  | "archive_recorded"
  | "store_replaced"
  | "replacement_recorded"
  | "completion_recorded";

export type TaskAuthorityMaintenanceErrorCode =
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

export interface TaskAuthorityMaintenanceError {
  readonly code: TaskAuthorityMaintenanceErrorCode;
  readonly errorKind: ErrorKind;
  readonly message: string;
}

export interface TaskRawAuthorityState {
  readonly exists: boolean;
  readonly bytes: number;
  readonly digest: string | null;
}

export interface TaskAuthorityInspection {
  readonly store: TaskRawAuthorityState;
  readonly intent:
    | { readonly status: "none" }
    | {
      readonly status: "pending";
      readonly operationId: string;
      readonly phase: ResetIntent["phase"];
      readonly digest: string;
    }
    | { readonly status: "invalid"; readonly digest: string };
}

export interface TaskAuthorityResetRequest {
  readonly expectedDigest: string | null;
  readonly confirmed: boolean;
}

export interface TaskAuthorityResetResult {
  readonly operationId: string;
  readonly beforeDigest: string | null;
  readonly afterDigest: string;
}

export type TaskAuthorityRecoveryResult =
  | { readonly status: "none" }
  | ({ readonly status: "recovered" } & TaskAuthorityResetResult);

export interface TaskAuthorityMaintenance {
  inspect(): Promise<Result<TaskAuthorityInspection, TaskAuthorityMaintenanceError>>;
  recoverPendingReset(): Promise<Result<TaskAuthorityRecoveryResult, TaskAuthorityMaintenanceError>>;
  reset(request: TaskAuthorityResetRequest): Promise<Result<TaskAuthorityResetResult, TaskAuthorityMaintenanceError>>;
}

export interface TaskAuthorityMaintenanceOptions {
  readonly directory: string;
  readonly storePath: string;
  readonly intentPath: string;
  readonly storeLockPath: string;
  readonly fileLock: FileLockPort;
  readonly clock: ClockPort;
  readonly idFactory: () => string;
  readonly durableStepGate?: (
    step: TaskAuthorityDurableStep,
  ) => Promise<Result<void, TaskAuthorityMaintenanceError>>;
}

type IntentInspection =
  | { readonly status: "none" }
  | { readonly status: "valid"; readonly intent: ResetIntent; readonly digest: string }
  | { readonly status: "invalid"; readonly digest: string };

export function createTaskAuthorityMaintenance(
  options: TaskAuthorityMaintenanceOptions,
): TaskAuthorityMaintenance {
  const optionsError = validateOptions(options);

  async function inspect(): Promise<Result<TaskAuthorityInspection, TaskAuthorityMaintenanceError>> {
    if (optionsError !== undefined) return err(optionsError);
    return withStoreLock<TaskAuthorityInspection>(async () => {
      const store = await inspectRawFile(options.storePath);
      if (!store.ok) return store;
      const intent = await inspectIntent();
      if (!intent.ok) return intent;
      if (intent.value.status === "none") return ok({ store: store.value, intent: { status: "none" } });
      if (intent.value.status === "invalid") {
        return ok({ store: store.value, intent: { status: "invalid", digest: intent.value.digest } });
      }
      return ok({
        store: store.value,
        intent: {
          status: "pending",
          operationId: intent.value.intent.operationId,
          phase: intent.value.intent.phase,
          digest: intent.value.digest,
        },
      });
    });
  }

  async function recoverPendingReset(): Promise<Result<TaskAuthorityRecoveryResult, TaskAuthorityMaintenanceError>> {
    if (optionsError !== undefined) return err(optionsError);
    return withStoreLock<TaskAuthorityRecoveryResult>(async () => {
      const inspected = await inspectIntent();
      if (!inspected.ok) return inspected;
      if (inspected.value.status === "none") return ok({ status: "none" });
      if (inspected.value.status === "invalid") {
        return err(maintenanceError("intent_invalid", "validation", "Task reset intent does not match its strict format"));
      }
      const recovered = await rollForward(inspected.value.intent);
      return recovered.ok ? ok({ status: "recovered", ...recovered.value }) : recovered;
    });
  }

  async function reset(
    request: TaskAuthorityResetRequest,
  ): Promise<Result<TaskAuthorityResetResult, TaskAuthorityMaintenanceError>> {
    if (optionsError !== undefined) return err(optionsError);
    if (request.expectedDigest !== null && !DigestSchema.safeParse(request.expectedDigest).success) {
      return err(maintenanceError("invalid_input", "validation", "Expected task authority digest must be SHA-256 or null"));
    }
    if (!request.confirmed) {
      return err(maintenanceError("confirmation_required", "precondition", "Task authority reset requires explicit confirmation"));
    }
    return withStoreLock(async () => {
      const existingIntent = await inspectIntent();
      if (!existingIntent.ok) return existingIntent;
      if (existingIntent.value.status !== "none") {
        return err(maintenanceError(
          existingIntent.value.status === "invalid" ? "intent_invalid" : "intent_present",
          existingIntent.value.status === "invalid" ? "validation" : "precondition",
          "A task reset intent already requires recovery or operator inspection",
        ));
      }
      const before = await inspectRawFile(options.storePath);
      if (!before.ok) return before;
      if (before.value.digest !== request.expectedDigest) {
        return err(maintenanceError("digest_mismatch", "precondition", "Task authority changed after status inspection"));
      }
      const operationId = nextIdentifier();
      if (!operationId.ok) return operationId;
      const intent: ResetIntent = {
        formatVersion: RESET_INTENT_FORMAT_VERSION,
        operationId: operationId.value,
        expectedDigest: before.value.digest,
        archiveName: path.basename(archivePath(operationId.value)),
        phase: "prepared",
        createdAtMs: options.clock.now(),
      };
      if (!validIntentSemantics(intent)) {
        return err(maintenanceError("invalid_input", "validation", "Task reset intent inputs are invalid"));
      }
      const archive = await inspectRawFile(archivePath(operationId.value));
      if (!archive.ok) return archive;
      if (archive.value.exists) {
        return err(maintenanceError("archive_conflict", "precondition", "Task reset archive name already exists"));
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
  ): Promise<Result<TaskAuthorityResetResult, TaskAuthorityMaintenanceError>> {
    let intent = original;
    const replacement = emptyStoreBytes();
    if (!replacement.ok) return replacement;
    const archived = await ensureArchived(intent, replacement.value);
    if (!archived.ok) return archived;
    let gated = await passStep("store_archived");
    if (!gated.ok) return gated;
    if (phaseRank(intent.phase) < phaseRank("archive_recorded")) {
      intent = { ...intent, phase: "archive_recorded" };
      const recorded = await writeIntent(intent);
      if (!recorded.ok) return recorded;
      gated = await passStep("archive_recorded");
      if (!gated.ok) return gated;
    }
    const replaced = await ensureReplaced(intent, replacement.value);
    if (!replaced.ok) return replaced;
    gated = await passStep("store_replaced");
    if (!gated.ok) return gated;
    if (phaseRank(intent.phase) < phaseRank("replacement_recorded")) {
      intent = { ...intent, phase: "replacement_recorded" };
      const recorded = await writeIntent(intent);
      if (!recorded.ok) return recorded;
      gated = await passStep("replacement_recorded");
      if (!gated.ok) return gated;
    }
    if (phaseRank(intent.phase) < phaseRank("completion_recorded")) {
      intent = { ...intent, phase: "completion_recorded" };
      const recorded = await writeIntent(intent);
      if (!recorded.ok) return recorded;
      gated = await passStep("completion_recorded");
      if (!gated.ok) return gated;
    }
    const removed = await removeIntent();
    if (!removed.ok) return removed;
    const after = await inspectRawFile(options.storePath);
    if (!after.ok) return after;
    if (after.value.digest === null) return ambiguous();
    return ok({
      operationId: intent.operationId,
      beforeDigest: intent.expectedDigest,
      afterDigest: after.value.digest,
    });
  }

  async function ensureArchived(
    intent: ResetIntent,
    replacement: Buffer,
  ): Promise<Result<void, TaskAuthorityMaintenanceError>> {
    const authority = await inspectRawFile(options.storePath);
    if (!authority.ok) return authority;
    const archiveFile = archivePath(intent.operationId);
    const archive = await inspectRawFile(archiveFile);
    if (!archive.ok) return archive;
    const replacementDigest = digest(replacement);
    if (intent.expectedDigest === null) {
      if (archive.value.exists) return ambiguous();
      return !authority.value.exists || authority.value.digest === replacementDigest ? ok(undefined) : ambiguous();
    }
    if (
      archive.value.digest === intent.expectedDigest
      && (!authority.value.exists || authority.value.digest === replacementDigest)
    ) return secureArchive(archiveFile);
    if (!archive.value.exists && authority.value.digest === intent.expectedDigest) {
      const renamed = await fromPromise(fs.rename(options.storePath, archiveFile));
      if (!renamed.ok) return err(ioError("Unable to archive task authority file"));
      return secureArchive(archiveFile);
    }
    return ambiguous();
  }

  async function ensureReplaced(
    intent: ResetIntent,
    replacement: Buffer,
  ): Promise<Result<void, TaskAuthorityMaintenanceError>> {
    const authority = await inspectRawFile(options.storePath);
    if (!authority.ok) return authority;
    const archive = await inspectRawFile(archivePath(intent.operationId));
    if (!archive.ok) return archive;
    if (intent.expectedDigest === null) {
      if (archive.value.exists) return ambiguous();
    } else if (archive.value.digest !== intent.expectedDigest) {
      return ambiguous();
    }
    const replacementDigest = digest(replacement);
    if (authority.value.exists) {
      return authority.value.digest === replacementDigest ? ok(undefined) : ambiguous();
    }
    const replaced = await replaceDurableFile({
      filePath: options.storePath,
      bytes: replacement,
      temporaryToken: options.idFactory,
    });
    return replaced.ok
      ? replaced
      : err(maintenanceError(
        replaced.error.code === "invalid_input" ? "invalid_input" : "io",
        replaced.error.errorKind,
        "Unable to create strict empty task authority",
      ));
  }

  async function inspectIntent(): Promise<Result<IntentInspection, TaskAuthorityMaintenanceError>> {
    const metadata = await inspectRawFile(options.intentPath);
    if (!metadata.ok) return metadata;
    if (!metadata.value.exists) return ok({ status: "none" });
    if (metadata.value.digest === null) return ambiguous();
    if (metadata.value.bytes > MAX_RESET_INTENT_BYTES) {
      return ok({ status: "invalid", digest: metadata.value.digest });
    }
    const raw = await readBoundedFile(options.intentPath, MAX_RESET_INTENT_BYTES);
    if (!raw.ok) return raw;
    if (raw.value === null) return ambiguous();
    const rawBytes = raw.value;
    const rawDigest = digest(rawBytes);
    const decoded = tryCatch(() => JSON.parse(rawBytes.toString("utf8")) as unknown);
    if (!decoded.ok) return ok({ status: "invalid", digest: rawDigest });
    const parsed = ResetIntentSchema.safeParse(decoded.value);
    return parsed.success && validIntentSemantics(parsed.data)
      ? ok({ status: "valid", intent: parsed.data, digest: rawDigest })
      : ok({ status: "invalid", digest: rawDigest });
  }

  async function writeIntent(intent: ResetIntent): Promise<Result<void, TaskAuthorityMaintenanceError>> {
    if (!ResetIntentSchema.safeParse(intent).success || !validIntentSemantics(intent)) {
      return err(maintenanceError("intent_invalid", "validation", "Task reset intent does not match its strict format"));
    }
    const bytes = Buffer.from(`${JSON.stringify(intent)}\n`, "utf8");
    if (bytes.byteLength > MAX_RESET_INTENT_BYTES) {
      return err(maintenanceError("invalid_input", "validation", "Task reset intent exceeds its byte ceiling"));
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
        "Unable to durably write task reset intent",
      ));
  }

  async function removeIntent(): Promise<Result<void, TaskAuthorityMaintenanceError>> {
    const removed = await fromPromise(fs.unlink(options.intentPath));
    if (!removed.ok && !isNodeError(removed.error, "ENOENT")) {
      return err(ioError("Unable to remove completed task reset intent"));
    }
    return syncDirectory();
  }

  async function secureArchive(archiveFile: string): Promise<Result<void, TaskAuthorityMaintenanceError>> {
    const secured = await fromPromise(fs.chmod(archiveFile, 0o600));
    return secured.ok ? syncDirectory() : err(ioError("Unable to secure task reset archive"));
  }

  async function syncDirectory(): Promise<Result<void, TaskAuthorityMaintenanceError>> {
    const opened = await fromPromise(fs.open(options.directory, "r"));
    if (!opened.ok) return err(ioError("Unable to open task authority directory for synchronization"));
    const synced = await fromPromise(opened.value.sync());
    const closed = await fromPromise(opened.value.close());
    return synced.ok && closed.ok
      ? ok(undefined)
      : err(ioError("Unable to synchronize task authority directory"));
  }

  async function passStep(step: TaskAuthorityDurableStep): Promise<Result<void, TaskAuthorityMaintenanceError>> {
    if (options.durableStepGate === undefined) return ok(undefined);
    const called = await fromPromise(options.durableStepGate(step));
    if (!called.ok) return err(maintenanceError("interrupted", "internal", "Task reset durable-step gate failed"));
    return called.value;
  }

  async function withStoreLock<T>(
    operation: () => Promise<Result<T, TaskAuthorityMaintenanceError>>,
  ): Promise<Result<T, TaskAuthorityMaintenanceError>> {
    const locked = await options.fileLock.withLock(options.storeLockPath, operation, LOCK_OPTIONS);
    return locked.ok ? locked.value : err(lockError(locked.error.kind, locked.error.message));
  }

  function archivePath(operationId: string): string {
    return `${options.storePath}.${operationId}.archive`;
  }

  function nextIdentifier(): Result<string, TaskAuthorityMaintenanceError> {
    const generated = tryCatch(options.idFactory);
    return generated.ok && IdentifierSchema.safeParse(generated.value).success
      ? ok(generated.value)
      : err(maintenanceError("invalid_input", "validation", "Opaque id factory returned an invalid task reset identifier"));
  }

  return { inspect, recoverPendingReset, reset };
}

async function inspectRawFile(
  filePath: string,
): Promise<Result<TaskRawAuthorityState, TaskAuthorityMaintenanceError>> {
  const pathMetadata = await fromPromise(fs.lstat(filePath));
  if (!pathMetadata.ok) {
    return isNodeError(pathMetadata.error, "ENOENT")
      ? ok({ exists: false, bytes: 0, digest: null })
      : err(ioError("Unable to inspect task authority path"));
  }
  if (!pathMetadata.value.isFile()) {
    return err(maintenanceError("invalid_path", "validation", "Task authority path must resolve directly to a regular file"));
  }
  const opened = await fromPromise(fs.open(filePath, "r"));
  if (!opened.ok) return err(ioError("Unable to open task authority file"));
  const metadata = await fromPromise(opened.value.stat());
  if (
    !metadata.ok
    || !metadata.value.isFile()
    || metadata.value.dev !== pathMetadata.value.dev
    || metadata.value.ino !== pathMetadata.value.ino
  ) {
    await fromPromise(opened.value.close());
    return err(maintenanceError("invalid_path", "validation", "Task authority path must resolve to a regular file"));
  }
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1_024);
  let bytes = 0;
  while (true) {
    const read = await fromPromise(opened.value.read(buffer, 0, buffer.byteLength, null));
    if (!read.ok) {
      await fromPromise(opened.value.close());
      return err(ioError("Unable to hash task authority file"));
    }
    if (read.value.bytesRead === 0) break;
    bytes += read.value.bytesRead;
    if (!Number.isSafeInteger(bytes)) {
      await fromPromise(opened.value.close());
      return err(maintenanceError("invalid_input", "resource", "Task authority byte count exceeds safe integer range"));
    }
    hash.update(buffer.subarray(0, read.value.bytesRead));
  }
  const closed = await fromPromise(opened.value.close());
  return closed.ok
    ? ok({ exists: true, bytes, digest: hash.digest("hex") })
    : err(ioError("Unable to close task authority file after inspection"));
}

async function readBoundedFile(
  filePath: string,
  maxBytes: number,
): Promise<Result<Buffer | null, TaskAuthorityMaintenanceError>> {
  const metadata = await fromPromise(fs.lstat(filePath));
  if (!metadata.ok) {
    return isNodeError(metadata.error, "ENOENT") ? ok(null) : err(ioError("Unable to inspect task reset intent"));
  }
  if (!metadata.value.isFile() || metadata.value.size > maxBytes) {
    return err(maintenanceError("intent_invalid", "validation", "Task reset intent is not a bounded regular file"));
  }
  const read = await fromPromise(fs.readFile(filePath));
  return read.ok ? ok(read.value) : err(ioError("Unable to read task reset intent"));
}

function emptyStoreBytes(): Result<Buffer, TaskAuthorityMaintenanceError> {
  const root: FollowupTaskStoreFile = { formatVersion: 1, tasks: [], attempts: [], policySnapshots: [] };
  const encoded = encodeFollowupTaskStore(root);
  return encoded.ok
    ? ok(encoded.value)
    : err(maintenanceError("intent_invalid", encoded.error.errorKind, "Task reset cannot create a strict empty store"));
}

function validateOptions(options: TaskAuthorityMaintenanceOptions): TaskAuthorityMaintenanceError | undefined {
  const paths = [options.directory, options.storePath, options.intentPath, options.storeLockPath];
  if (paths.some((candidate) => !path.isAbsolute(candidate)) || path.resolve(options.directory) !== options.directory) {
    return maintenanceError("invalid_path", "validation", "Task authority maintenance requires normalized absolute paths");
  }
  if (paths.slice(1).some((candidate) => path.dirname(candidate) !== options.directory)) {
    return maintenanceError("invalid_path", "validation", "Task authority files and lock must share one directory");
  }
  if (new Set(paths.slice(1)).size !== paths.length - 1) {
    return maintenanceError("invalid_path", "validation", "Task authority files and lock must use distinct paths");
  }
  return undefined;
}

function validIntentSemantics(intent: ResetIntent): boolean {
  return intent.archiveName === `tasks.json.${intent.operationId}.archive`;
}

function phaseRank(phase: ResetIntent["phase"]): number {
  switch (phase) {
    case "prepared": return 0;
    case "archive_recorded": return 1;
    case "replacement_recorded": return 2;
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

function ambiguous(): Result<never, TaskAuthorityMaintenanceError> {
  return err(maintenanceError(
    "intent_ambiguous",
    "precondition",
    "Task reset intent facts do not unambiguously match a recoverable transaction",
  ));
}

function lockError(kind: "locked" | "error", message: string): TaskAuthorityMaintenanceError {
  return maintenanceError(
    kind === "locked" ? "lock_contended" : "lock_failed",
    kind === "locked" ? "precondition" : "internal",
    message,
  );
}

function ioError(message: string): TaskAuthorityMaintenanceError {
  return maintenanceError("io", "internal", message);
}

function maintenanceError(
  code: TaskAuthorityMaintenanceErrorCode,
  errorKind: ErrorKind,
  message: string,
): TaskAuthorityMaintenanceError {
  return { code, errorKind, message };
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
