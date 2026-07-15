// SPDX-License-Identifier: Apache-2.0
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { err, ok, tryCatch, type Result } from "@comis/shared";

import {
  createProductionRuntimeVaultRecoveryReceipt,
  parseAndVerifyProductionRuntimeVaultRecoveryReceipt,
  serializeProductionRuntimeVaultRecoveryReceipt,
  type ProductionRuntimeVaultRecoveryReceipt,
  type ProductionRuntimeVaultRecoveryReceiptInput,
} from "./production-runtime-vault-authority.js";

const STORE_DIRECTORY = "runtime-vault-receipts";
const RECEIPT_FILE = "recovery-receipt.json";
const RECEIPT_INCOMING_FILE = ".recovery-receipt.json.incoming";
const TERMINAL_FILE = "terminal.json";
const TERMINAL_INCOMING_FILE = ".terminal.json.incoming";
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_TERMINAL_BYTES = 4096;
const MIN_AUTHORITY_KEY_BYTES = 32;
const SAFE_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const ATTEMPT_ID_RE = /^[a-f0-9]{32}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const TERMINAL_SCHEMA = "comis-runtime-vault-terminal-record";
const TERMINAL_HMAC_DOMAIN = "comis-runtime-vault-terminal-record-hmac-v1\0";
const activeAttemptLocks = new Set<string>();

const TERMINAL_DISPOSITIONS = [
  "published",
  "reused_existing",
  "rolled_back",
  "blocked_corrupt",
] as const;

const TERMINAL_UNSIGNED_KEYS = [
  "schema",
  "schemaVersion",
  "runId",
  "attemptId",
  "disposition",
  "authorityKeyIdSha256",
  "receiptAuthorityDigestSha256",
  "receiptDigestSha256",
] as const;
const TERMINAL_KEYS = [...TERMINAL_UNSIGNED_KEYS, "authenticationTagSha256"] as const;

export type ProductionRuntimeVaultTerminalDisposition =
  (typeof TERMINAL_DISPOSITIONS)[number];

export interface ProductionRuntimeVaultTerminalRecord {
  readonly schema: "comis-runtime-vault-terminal-record";
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly attemptId: string;
  readonly disposition: ProductionRuntimeVaultTerminalDisposition;
  readonly authorityKeyIdSha256: string;
  readonly receiptAuthorityDigestSha256: string;
  readonly receiptDigestSha256: string;
  readonly authenticationTagSha256: string;
}

export interface ProductionRuntimeVaultReceiptPaths {
  readonly receiptDirectory: string;
  readonly receiptPath: string;
  readonly receiptIncomingPath: string;
  readonly terminalPath: string;
  readonly terminalIncomingPath: string;
}

export interface ProductionRuntimeVaultReceiptStoreIo {
  readonly write: (
    descriptor: number,
    data: Uint8Array,
    offset: number,
    length: number,
  ) => number;
}

export interface CreateProductionRuntimeVaultReceiptStoreOptions {
  readonly stateRoot: string;
  readonly authorityKey: Uint8Array;
}

export interface CreateProductionRuntimeVaultReceiptStoreTestOptions
  extends CreateProductionRuntimeVaultReceiptStoreOptions {
  readonly io?: ProductionRuntimeVaultReceiptStoreIo;
}

export interface ProductionRuntimeVaultReceiptPersistence {
  readonly status: "created" | "already_present";
  readonly path: string;
}

export interface ProductionRuntimeVaultCreatedReceipt
  extends ProductionRuntimeVaultReceiptPersistence {
  readonly receipt: ProductionRuntimeVaultRecoveryReceipt;
}

export interface ProductionRuntimeVaultReceiptStore {
  readonly createAndPersistReceipt: (
    input: ProductionRuntimeVaultRecoveryReceiptInput,
  ) => Result<ProductionRuntimeVaultCreatedReceipt, ProductionRuntimeVaultReceiptStoreError>;
  readonly paths: (
    runId: string,
    attemptId: string,
  ) => Result<ProductionRuntimeVaultReceiptPaths, ProductionRuntimeVaultReceiptStoreError>;
  readonly readReceipt: (
    runId: string,
    attemptId: string,
  ) => Result<ProductionRuntimeVaultRecoveryReceipt, ProductionRuntimeVaultReceiptStoreError>;
  readonly recordTerminal: (
    receipt: ProductionRuntimeVaultRecoveryReceipt,
    disposition: ProductionRuntimeVaultTerminalDisposition,
  ) => Result<ProductionRuntimeVaultReceiptPersistence, ProductionRuntimeVaultReceiptStoreError>;
  readonly readTerminal: (
    runId: string,
    attemptId: string,
  ) => Result<
    ProductionRuntimeVaultTerminalRecord | undefined,
    ProductionRuntimeVaultReceiptStoreError
  >;
}

export interface ProductionRuntimeVaultReceiptStoreTestHarness
  extends ProductionRuntimeVaultReceiptStore {
  readonly persistReceipt: (
    receipt: ProductionRuntimeVaultRecoveryReceipt,
  ) => Result<ProductionRuntimeVaultReceiptPersistence, ProductionRuntimeVaultReceiptStoreError>;
}

export type ProductionRuntimeVaultReceiptStoreError =
  | {
      readonly kind: "invalid_request";
      readonly field: string;
      readonly message: string;
    }
  | {
      readonly kind: "unsafe_state_root";
      readonly field: "stateRoot";
      readonly message: string;
    }
  | {
      readonly kind: "unsafe_directory";
      readonly field: "receiptDirectory";
      readonly message: string;
    }
  | {
      readonly kind: "unsafe_file";
      readonly field: "receiptFile" | "terminalFile";
      readonly message: string;
    }
  | {
      readonly kind: "invalid_receipt";
      readonly field: "receipt";
      readonly message: string;
    }
  | {
      readonly kind: "invalid_terminal_record";
      readonly field: "terminalRecord";
      readonly message: string;
    }
  | {
      readonly kind: "not_found";
      readonly field: "receipt";
      readonly message: string;
    }
  | {
      readonly kind: "conflict";
      readonly field: "receipt" | "terminalRecord";
      readonly message: string;
    }
  | {
      readonly kind: "unsupported_platform";
      readonly field: "platform" | "toolchain";
      readonly message: string;
    }
  | {
      readonly kind: "operation_locked";
      readonly field: "attempt";
      readonly message: string;
    }
  | {
      readonly kind: "io_failure";
      readonly operation: string;
      readonly message: string;
    };

interface DirectoryGuard {
  readonly path: string;
  readonly descriptor: number;
  readonly identity: BigIntStats;
}

interface OpenHierarchy {
  readonly paths: ProductionRuntimeVaultReceiptPaths;
  readonly runId: string;
  readonly attemptId: string;
  readonly guards: readonly DirectoryGuard[];
}

interface RawFile {
  readonly raw: Buffer;
}

interface StrictFile extends RawFile {
  readonly identity: BigIntStats;
}

interface StrictReceipt extends RawFile {
  readonly receipt: ProductionRuntimeVaultRecoveryReceipt;
}

interface UnsignedTerminalRecord {
  readonly schema: "comis-runtime-vault-terminal-record";
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly attemptId: string;
  readonly disposition: ProductionRuntimeVaultTerminalDisposition;
  readonly authorityKeyIdSha256: string;
  readonly receiptAuthorityDigestSha256: string;
  readonly receiptDigestSha256: string;
}

function failure(
  error: ProductionRuntimeVaultReceiptStoreError,
): Result<never, ProductionRuntimeVaultReceiptStoreError> {
  return err(error);
}

function invalidRequest(
  field: string,
  message: string,
): Result<never, ProductionRuntimeVaultReceiptStoreError> {
  return failure({ kind: "invalid_request", field, message });
}

function unsafeRoot(): Result<never, ProductionRuntimeVaultReceiptStoreError> {
  return failure({
    kind: "unsafe_state_root",
    field: "stateRoot",
    message: "Controller state root must be an existing canonical private directory owned by the effective user",
  });
}

function unsafeDirectory(): Result<never, ProductionRuntimeVaultReceiptStoreError> {
  return failure({
    kind: "unsafe_directory",
    field: "receiptDirectory",
    message: "Receipt directory hierarchy failed its private directory invariant",
  });
}

function unsafeFile(
  field: "receiptFile" | "terminalFile",
): Result<never, ProductionRuntimeVaultReceiptStoreError> {
  return failure({
    kind: "unsafe_file",
    field,
    message: "Stored file failed its regular private single-link invariant",
  });
}

function ioFailure(operation: string): Result<never, ProductionRuntimeVaultReceiptStoreError> {
  return failure({
    kind: "io_failure",
    operation,
    message: "Controller receipt store filesystem operation failed",
  });
}

function operationLocked(): Result<never, ProductionRuntimeVaultReceiptStoreError> {
  return failure({
    kind: "operation_locked",
    field: "attempt",
    message: "Another controller operation holds the runtime-vault attempt lock",
  });
}

function withAttemptLock<T>(
  stateRoot: string,
  runId: string,
  attemptId: string,
  operation: () => Result<T, ProductionRuntimeVaultReceiptStoreError>,
): Result<T, ProductionRuntimeVaultReceiptStoreError> {
  const key = `${stateRoot}\0${runId}\0${attemptId}`;
  if (activeAttemptLocks.has(key)) return operationLocked();
  activeAttemptLocks.add(key);
  const outcome = tryCatch(operation);
  activeAttemptLocks.delete(key);
  return outcome.ok ? outcome.value : ioFailure("attempt_lock_operation");
}

function errorCode(value: Error): string | undefined {
  const code = (value as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return "null";
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function terminalAuthenticationTag(unsigned: UnsignedTerminalRecord, key: Uint8Array): string {
  return createHmac("sha256", key)
    .update(TERMINAL_HMAC_DOMAIN)
    .update(canonicalJson(unsigned))
    .digest("hex");
}

function equalDigest(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function currentEffectiveUid(): Result<number, ProductionRuntimeVaultReceiptStoreError> {
  if (typeof process.geteuid !== "function") {
    return invalidRequest("platform", "Controller receipt store requires effective-user ownership checks");
  }
  return ok(process.geteuid());
}

function sameInode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameInode(left, right) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isPrivateDirectory(value: BigIntStats, effectiveUid: number): boolean {
  return (
    value.isDirectory() &&
    value.uid === BigInt(effectiveUid) &&
    (value.mode & 0o7777n) === 0o700n
  );
}

function isPrivateFile(
  value: BigIntStats,
  effectiveUid: number,
  maximumBytes: number,
  allowedLinks: readonly bigint[] = [1n],
  allowEmpty = false,
): boolean {
  return (
    value.isFile() &&
    value.uid === BigInt(effectiveUid) &&
    (value.mode & 0o7777n) === 0o600n &&
    allowedLinks.includes(value.nlink) &&
    (allowEmpty || value.size > 0n) &&
    value.size <= BigInt(maximumBytes)
  );
}

function closeDescriptor(descriptor: number): Result<void, ProductionRuntimeVaultReceiptStoreError> {
  const closed = tryCatch(() => closeSync(descriptor));
  if (!closed.ok) return ioFailure("close_descriptor");
  return ok(undefined);
}

function closeGuards(
  guards: readonly DirectoryGuard[],
): Result<void, ProductionRuntimeVaultReceiptStoreError> {
  let failed = false;
  for (const guard of [...guards].reverse()) {
    if (!tryCatch(() => closeSync(guard.descriptor)).ok) failed = true;
  }
  return failed ? ioFailure("close_directory_guards") : ok(undefined);
}

function openDirectoryGuard(
  path: string,
  effectiveUid: number,
  root: boolean,
): Result<DirectoryGuard, ProductionRuntimeVaultReceiptStoreError> {
  const before = tryCatch(() => lstatSync(path, { bigint: true }));
  if (!before.ok || !isPrivateDirectory(before.value, effectiveUid)) {
    return root ? unsafeRoot() : unsafeDirectory();
  }
  const canonical = tryCatch(() => realpathSync(path));
  if (!canonical.ok || canonical.value !== path) return root ? unsafeRoot() : unsafeDirectory();

  const opened = tryCatch(() =>
    openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    ),
  );
  if (!opened.ok) return root ? unsafeRoot() : unsafeDirectory();
  const after = tryCatch(() => fstatSync(opened.value, { bigint: true }));
  if (
    !after.ok ||
    !sameInode(before.value, after.value) ||
    !isPrivateDirectory(after.value, effectiveUid)
  ) {
    const closed = closeDescriptor(opened.value);
    if (!closed.ok) return closed;
    return root ? unsafeRoot() : unsafeDirectory();
  }
  return ok({ path, descriptor: opened.value, identity: after.value });
}

function validateGuard(
  guard: DirectoryGuard,
  effectiveUid: number,
  root: boolean,
): Result<void, ProductionRuntimeVaultReceiptStoreError> {
  const pathValue = tryCatch(() => lstatSync(guard.path, { bigint: true }));
  const descriptorValue = tryCatch(() => fstatSync(guard.descriptor, { bigint: true }));
  const canonical = tryCatch(() => realpathSync(guard.path));
  if (
    !pathValue.ok ||
    !descriptorValue.ok ||
    !canonical.ok ||
    canonical.value !== guard.path ||
    !sameInode(guard.identity, pathValue.value) ||
    !sameInode(guard.identity, descriptorValue.value) ||
    !isPrivateDirectory(pathValue.value, effectiveUid) ||
    !isPrivateDirectory(descriptorValue.value, effectiveUid)
  ) {
    return root ? unsafeRoot() : unsafeDirectory();
  }
  return ok(undefined);
}

function validateGuards(
  guards: readonly DirectoryGuard[],
  effectiveUid: number,
): Result<void, ProductionRuntimeVaultReceiptStoreError> {
  for (const [index, guard] of guards.entries()) {
    const valid = validateGuard(guard, effectiveUid, index === 0);
    if (!valid.ok) return valid;
  }
  return ok(undefined);
}

function synchronizeGuards(
  guards: readonly DirectoryGuard[],
): Result<void, ProductionRuntimeVaultReceiptStoreError> {
  for (const guard of [...guards].reverse()) {
    const synchronized = tryCatch(() => fsyncSync(guard.descriptor));
    if (!synchronized.ok) return ioFailure("synchronize_directory");
  }
  return ok(undefined);
}

function ensureChildDirectory(
  parentGuards: readonly DirectoryGuard[],
  path: string,
  effectiveUid: number,
  create: boolean,
): Result<DirectoryGuard, ProductionRuntimeVaultReceiptStoreError> {
  const stable = validateGuards(parentGuards, effectiveUid);
  if (!stable.ok) return stable;

  const existing = tryCatch(() => lstatSync(path, { bigint: true }));
  let created = false;
  if (!existing.ok) {
    if (errorCode(existing.error) !== "ENOENT") return unsafeDirectory();
    if (!create) {
      return failure({
        kind: "not_found",
        field: "receipt",
        message: "Stored recovery receipt does not exist",
      });
    }
    const made = tryCatch(() => mkdirSync(path, { mode: 0o700 }));
    if (!made.ok && errorCode(made.error) !== "EEXIST") return ioFailure("create_directory");
    created = made.ok;
  }

  if (created) {
    const parentStable = validateGuards(parentGuards, effectiveUid);
    if (!parentStable.ok) return parentStable;
    const createdValue = tryCatch(() => lstatSync(path, { bigint: true }));
    const createdCanonical = tryCatch(() => realpathSync(path));
    if (
      !createdValue.ok ||
      !createdCanonical.ok ||
      createdCanonical.value !== path ||
      !createdValue.value.isDirectory() ||
      createdValue.value.uid !== BigInt(effectiveUid) ||
      (createdValue.value.mode & 0o7077n) !== 0n
    ) {
      return unsafeDirectory();
    }
    const restricted = tryCatch(() => chmodSync(path, 0o700));
    const restrictedValue = tryCatch(() => lstatSync(path, { bigint: true }));
    if (
      !restricted.ok ||
      !restrictedValue.ok ||
      !sameInode(createdValue.value, restrictedValue.value) ||
      !isPrivateDirectory(restrictedValue.value, effectiveUid)
    ) {
      return unsafeDirectory();
    }
  }

  const guard = openDirectoryGuard(path, effectiveUid, false);
  if (!guard.ok) return guard;
  if (created) {
    const restricted = tryCatch(() => fchmodSync(guard.value.descriptor, 0o700));
    if (!restricted.ok) {
      const closed = closeDescriptor(guard.value.descriptor);
      if (!closed.ok) return closed;
      return ioFailure("restrict_directory");
    }
    const parentSynchronized = tryCatch(() =>
      fsyncSync(parentGuards[parentGuards.length - 1]!.descriptor),
    );
    const childSynchronized = tryCatch(() => fsyncSync(guard.value.descriptor));
    if (!parentSynchronized.ok || !childSynchronized.ok) {
      const closed = closeDescriptor(guard.value.descriptor);
      if (!closed.ok) return closed;
      return ioFailure("synchronize_directory_creation");
    }
  }
  return ok(guard.value);
}

function resolvePaths(
  stateRoot: string,
  runId: string,
  attemptId: string,
): Result<ProductionRuntimeVaultReceiptPaths, ProductionRuntimeVaultReceiptStoreError> {
  if (typeof runId !== "string" || !SAFE_RUN_ID_RE.test(runId)) {
    return invalidRequest("runId", "Recovery receipt run identifier is invalid");
  }
  if (typeof attemptId !== "string" || !ATTEMPT_ID_RE.test(attemptId)) {
    return invalidRequest("attemptId", "Recovery receipt attempt identifier is invalid");
  }
  const receiptDirectory = resolve(stateRoot, STORE_DIRECTORY, runId, attemptId);
  return ok({
    receiptDirectory,
    receiptPath: resolve(receiptDirectory, RECEIPT_FILE),
    receiptIncomingPath: resolve(receiptDirectory, RECEIPT_INCOMING_FILE),
    terminalPath: resolve(receiptDirectory, TERMINAL_FILE),
    terminalIncomingPath: resolve(receiptDirectory, TERMINAL_INCOMING_FILE),
  });
}

function openHierarchy(
  stateRoot: string,
  runId: string,
  attemptId: string,
  effectiveUid: number,
  create: boolean,
): Result<OpenHierarchy, ProductionRuntimeVaultReceiptStoreError> {
  const paths = resolvePaths(stateRoot, runId, attemptId);
  if (!paths.ok) return paths;
  const root = openDirectoryGuard(stateRoot, effectiveUid, true);
  if (!root.ok) return root;
  const guards: DirectoryGuard[] = [root.value];
  const components = [
    resolve(stateRoot, STORE_DIRECTORY),
    resolve(stateRoot, STORE_DIRECTORY, runId),
    paths.value.receiptDirectory,
  ];
  for (const component of components) {
    const child = ensureChildDirectory(guards, component, effectiveUid, create);
    if (!child.ok) {
      const closed = closeGuards(guards);
      if (!closed.ok) return closed;
      return child;
    }
    guards.push(child.value);
  }
  const stable = validateGuards(guards, effectiveUid);
  if (!stable.ok) {
    const closed = closeGuards(guards);
    if (!closed.ok) return closed;
    return stable;
  }
  return ok({ paths: paths.value, runId, attemptId, guards });
}

function readStrictFile(
  path: string,
  field: "receiptFile" | "terminalFile",
  maximumBytes: number,
  hierarchy: OpenHierarchy,
  effectiveUid: number,
  missingAllowed: boolean,
  allowedLinks: readonly bigint[] = [1n],
  allowEmpty = false,
): Result<StrictFile | undefined, ProductionRuntimeVaultReceiptStoreError> {
  const stableBefore = validateGuards(hierarchy.guards, effectiveUid);
  if (!stableBefore.ok) return stableBefore;
  const pathValue = tryCatch(() => lstatSync(path, { bigint: true }));
  if (!pathValue.ok) {
    if (errorCode(pathValue.error) === "ENOENT" && missingAllowed) return ok(undefined);
    if (errorCode(pathValue.error) === "ENOENT") {
      return failure({
        kind: "not_found",
        field: "receipt",
        message: "Stored recovery receipt does not exist",
      });
    }
    return unsafeFile(field);
  }
  if (
    !isPrivateFile(pathValue.value, effectiveUid, maximumBytes, allowedLinks, allowEmpty)
  ) {
    return unsafeFile(field);
  }

  const opened = tryCatch(() => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW));
  if (!opened.ok) return unsafeFile(field);
  const before = tryCatch(() => fstatSync(opened.value, { bigint: true }));
  if (
    !before.ok ||
    !sameStableFile(pathValue.value, before.value) ||
    !isPrivateFile(before.value, effectiveUid, maximumBytes, allowedLinks, allowEmpty)
  ) {
    const closed = closeDescriptor(opened.value);
    if (!closed.ok) return closed;
    return unsafeFile(field);
  }

  const raw = Buffer.alloc(Number(before.value.size));
  let offset = 0;
  while (offset < raw.length) {
    const read = tryCatch(() =>
      readSync(opened.value, raw, offset, raw.length - offset, offset),
    );
    if (!read.ok || read.value <= 0 || read.value > raw.length - offset) {
      const closed = closeDescriptor(opened.value);
      if (!closed.ok) return closed;
      return unsafeFile(field);
    }
    offset += read.value;
  }

  const after = tryCatch(() => fstatSync(opened.value, { bigint: true }));
  const closed = closeDescriptor(opened.value);
  if (!closed.ok) return closed;
  const finalPathValue = tryCatch(() => lstatSync(path, { bigint: true }));
  if (
    !after.ok ||
    !finalPathValue.ok ||
    !sameStableFile(before.value, after.value) ||
    !sameStableFile(after.value, finalPathValue.value) ||
    !isPrivateFile(
      finalPathValue.value,
      effectiveUid,
      maximumBytes,
      allowedLinks,
      allowEmpty,
    )
  ) {
    return unsafeFile(field);
  }
  const stableAfter = validateGuards(hierarchy.guards, effectiveUid);
  if (!stableAfter.ok) return stableAfter;
  return ok({ raw, identity: after.value });
}

function decodeStrictUtf8(
  raw: Buffer,
  field: "receipt" | "terminalRecord",
): Result<string, ProductionRuntimeVaultReceiptStoreError> {
  const decoded = tryCatch(() => new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (!decoded.ok || !Buffer.from(decoded.value, "utf8").equals(raw)) {
    return field === "receipt"
      ? failure({
          kind: "invalid_receipt",
          field: "receipt",
          message: "Stored recovery receipt is not strict canonical UTF-8",
        })
      : failure({
          kind: "invalid_terminal_record",
          field: "terminalRecord",
          message: "Stored terminal record is not strict canonical UTF-8",
        });
  }
  return ok(decoded.value);
}

function parseStrictReceipt(
  strictFile: RawFile,
  authorityKey: Uint8Array,
  runId: string,
  attemptId: string,
): Result<StrictReceipt, ProductionRuntimeVaultReceiptStoreError> {
  const decoded = decodeStrictUtf8(strictFile.raw, "receipt");
  if (!decoded.ok) return decoded;
  const parsed = parseAndVerifyProductionRuntimeVaultRecoveryReceipt(
    decoded.value,
    authorityKey,
  );
  if (!parsed.ok || parsed.value.runId !== runId || parsed.value.attemptId !== attemptId) {
    return failure({
      kind: "invalid_receipt",
      field: "receipt",
      message: "Stored recovery receipt failed strict authority verification",
    });
  }
  return ok({ raw: strictFile.raw, receipt: parsed.value });
}

function authenticateReceiptValue(
  receipt: ProductionRuntimeVaultRecoveryReceipt,
  authorityKey: Uint8Array,
): Result<StrictReceipt, ProductionRuntimeVaultReceiptStoreError> {
  const encoded = tryCatch(() => {
    if (
      !isRecord(receipt) ||
      typeof receipt.runId !== "string" ||
      typeof receipt.attemptId !== "string"
    ) {
      return undefined;
    }
    return {
      runId: receipt.runId,
      attemptId: receipt.attemptId,
      raw: Buffer.from(serializeProductionRuntimeVaultRecoveryReceipt(receipt), "utf8"),
    };
  });
  if (!encoded.ok || encoded.value === undefined || encoded.value.raw.length > MAX_RECEIPT_BYTES) {
    return failure({
      kind: "invalid_receipt",
      field: "receipt",
      message: "Recovery receipt failed its bounded canonical input contract",
    });
  }
  return parseStrictReceipt(
    { raw: encoded.value.raw },
    authorityKey,
    encoded.value.runId,
    encoded.value.attemptId,
  );
}

function readReceiptFromHierarchy(
  hierarchy: OpenHierarchy,
  authorityKey: Uint8Array,
  effectiveUid: number,
): Result<StrictReceipt, ProductionRuntimeVaultReceiptStoreError> {
  const raw = readStrictFile(
    hierarchy.paths.receiptPath,
    "receiptFile",
    MAX_RECEIPT_BYTES,
    hierarchy,
    effectiveUid,
    false,
  );
  if (!raw.ok) return raw;
  if (raw.value === undefined) {
    return failure({
      kind: "not_found",
      field: "receipt",
      message: "Stored recovery receipt does not exist",
    });
  }
  return parseStrictReceipt(raw.value, authorityKey, hierarchy.runId, hierarchy.attemptId);
}

type PublicationField = "receiptFile" | "terminalFile";

type ExistingPublication =
  | { readonly kind: "absent" }
  | { readonly kind: "exact" }
  | { readonly kind: "other" };

function publicationConflict(
  field: PublicationField,
): Result<never, ProductionRuntimeVaultReceiptStoreError> {
  return failure({
    kind: "conflict",
    field: field === "receiptFile" ? "receipt" : "terminalRecord",
    message: "A different crash-recovery file already occupies the deterministic publication slot",
  });
}

function isExactPrefix(actual: Buffer, expected: Buffer): boolean {
  return actual.length <= expected.length && expected.subarray(0, actual.length).equals(actual);
}

function synchronizeFile(
  path: string,
  expected: BigIntStats,
  field: PublicationField,
  maximumBytes: number,
  hierarchy: OpenHierarchy,
  effectiveUid: number,
  allowedLinks: readonly bigint[],
  allowEmpty: boolean,
): Result<void, ProductionRuntimeVaultReceiptStoreError> {
  const stableBefore = validateGuards(hierarchy.guards, effectiveUid);
  if (!stableBefore.ok) return stableBefore;
  const opened = tryCatch(() => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW));
  if (!opened.ok) return unsafeFile(field);
  const before = tryCatch(() => fstatSync(opened.value, { bigint: true }));
  if (
    !before.ok ||
    !sameStableFile(expected, before.value) ||
    !isPrivateFile(before.value, effectiveUid, maximumBytes, allowedLinks, allowEmpty)
  ) {
    const closed = closeDescriptor(opened.value);
    if (!closed.ok) return closed;
    return unsafeFile(field);
  }
  const synchronized = tryCatch(() => fsyncSync(opened.value));
  const after = tryCatch(() => fstatSync(opened.value, { bigint: true }));
  const closed = closeDescriptor(opened.value);
  if (!closed.ok) return closed;
  const pathValue = tryCatch(() => lstatSync(path, { bigint: true }));
  if (
    !synchronized.ok ||
    !after.ok ||
    !pathValue.ok ||
    !sameStableFile(before.value, after.value) ||
    !sameStableFile(after.value, pathValue.value) ||
    !isPrivateFile(pathValue.value, effectiveUid, maximumBytes, allowedLinks, allowEmpty)
  ) {
    return unsafeFile(field);
  }
  return validateGuards(hierarchy.guards, effectiveUid);
}

function unlinkPairedIncoming(
  finalPath: string,
  incomingPath: string,
  expectedIdentity: BigIntStats,
  field: PublicationField,
  maximumBytes: number,
  hierarchy: OpenHierarchy,
  effectiveUid: number,
): Result<void, ProductionRuntimeVaultReceiptStoreError> {
  const stableBefore = validateGuards(hierarchy.guards, effectiveUid);
  if (!stableBefore.ok) return stableBefore;
  const finalValue = tryCatch(() => lstatSync(finalPath, { bigint: true }));
  const incomingValue = tryCatch(() => lstatSync(incomingPath, { bigint: true }));
  if (
    !finalValue.ok ||
    !incomingValue.ok ||
    !sameInode(expectedIdentity, finalValue.value) ||
    !sameInode(finalValue.value, incomingValue.value) ||
    !isPrivateFile(finalValue.value, effectiveUid, maximumBytes, [2n], false) ||
    !isPrivateFile(incomingValue.value, effectiveUid, maximumBytes, [2n], false)
  ) {
    return unsafeFile(field);
  }
  const linkDurable = synchronizeGuards(hierarchy.guards);
  if (!linkDurable.ok) return linkDurable;
  const removed = tryCatch(() => unlinkSync(incomingPath));
  if (!removed.ok) return ioFailure("unlink_paired_incoming");
  const unlinkDurable = synchronizeGuards(hierarchy.guards);
  if (!unlinkDurable.ok) return unlinkDurable;
  const finalAfter = tryCatch(() => lstatSync(finalPath, { bigint: true }));
  if (
    !finalAfter.ok ||
    !sameInode(expectedIdentity, finalAfter.value) ||
    !isPrivateFile(finalAfter.value, effectiveUid, maximumBytes, [1n], false)
  ) {
    return unsafeFile(field);
  }
  return ok(undefined);
}

function reconcileExistingPublication(
  finalPath: string,
  incomingPath: string,
  expectedRaw: Buffer,
  field: PublicationField,
  maximumBytes: number,
  hierarchy: OpenHierarchy,
  effectiveUid: number,
): Result<ExistingPublication, ProductionRuntimeVaultReceiptStoreError> {
  const finalFile = readStrictFile(
    finalPath,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
    true,
    [1n, 2n],
    true,
  );
  if (!finalFile.ok) return finalFile;
  if (finalFile.value === undefined) return ok({ kind: "absent" });

  const incomingFile = readStrictFile(
    incomingPath,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
    true,
    [1n, 2n],
    true,
  );
  if (!incomingFile.ok) return incomingFile;
  if (!finalFile.value.raw.equals(expectedRaw)) {
    if (finalFile.value.identity.nlink !== 1n || incomingFile.value !== undefined) {
      return unsafeFile(field);
    }
    return ok({ kind: "other" });
  }

  if (finalFile.value.identity.nlink === 1n) {
    if (incomingFile.value !== undefined) return unsafeFile(field);
    const fileDurable = synchronizeFile(
      finalPath,
      finalFile.value.identity,
      field,
      maximumBytes,
      hierarchy,
      effectiveUid,
      [1n],
      false,
    );
    if (!fileDurable.ok) return fileDurable;
    const directoriesDurable = synchronizeGuards(hierarchy.guards);
    return directoriesDurable.ok ? ok({ kind: "exact" }) : directoriesDurable;
  }

  if (
    incomingFile.value === undefined ||
    incomingFile.value.identity.nlink !== 2n ||
    !sameInode(finalFile.value.identity, incomingFile.value.identity) ||
    !incomingFile.value.raw.equals(expectedRaw)
  ) {
    return unsafeFile(field);
  }
  const fileDurable = synchronizeFile(
    finalPath,
    finalFile.value.identity,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
    [2n],
    false,
  );
  if (!fileDurable.ok) return fileDurable;
  const unlinked = unlinkPairedIncoming(
    finalPath,
    incomingPath,
    finalFile.value.identity,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
  );
  if (!unlinked.ok) return unlinked;
  const normalized = readStrictFile(
    finalPath,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
    false,
  );
  if (!normalized.ok || normalized.value === undefined || !normalized.value.raw.equals(expectedRaw)) {
    return normalized.ok ? unsafeFile(field) : normalized;
  }
  return ok({ kind: "exact" });
}

function createEmptyIncoming(
  incomingPath: string,
  field: PublicationField,
  maximumBytes: number,
  hierarchy: OpenHierarchy,
  effectiveUid: number,
): Result<"created" | "exists", ProductionRuntimeVaultReceiptStoreError> {
  const stable = validateGuards(hierarchy.guards, effectiveUid);
  if (!stable.ok) return stable;
  const opened = tryCatch(() =>
    openSync(
      incomingPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    ),
  );
  if (!opened.ok) {
    return errorCode(opened.error) === "EEXIST" ? ok("exists") : ioFailure("create_incoming");
  }
  const restricted = tryCatch(() => fchmodSync(opened.value, 0o600));
  const value = tryCatch(() => fstatSync(opened.value, { bigint: true }));
  const synchronized = tryCatch(() => fsyncSync(opened.value));
  const closed = closeDescriptor(opened.value);
  if (!closed.ok) return closed;
  const pathValue = tryCatch(() => lstatSync(incomingPath, { bigint: true }));
  if (
    !restricted.ok ||
    !value.ok ||
    !synchronized.ok ||
    !pathValue.ok ||
    !sameStableFile(value.value, pathValue.value) ||
    !isPrivateFile(pathValue.value, effectiveUid, maximumBytes, [1n], true) ||
    pathValue.value.size !== 0n
  ) {
    return unsafeFile(field);
  }
  const directoriesDurable = synchronizeGuards(hierarchy.guards);
  return directoriesDurable.ok ? ok("created") : directoriesDurable;
}

function preserveFailedIncomingWrite(
  descriptor: number,
  hierarchy: OpenHierarchy,
): Result<void, ProductionRuntimeVaultReceiptStoreError> {
  const fileSynchronized = tryCatch(() => fsyncSync(descriptor));
  const closed = closeDescriptor(descriptor);
  if (!closed.ok) return closed;
  const directoriesSynchronized = synchronizeGuards(hierarchy.guards);
  if (!fileSynchronized.ok || !directoriesSynchronized.ok) {
    return ioFailure("preserve_partial_incoming");
  }
  return ok(undefined);
}

function ensureCompleteIncoming(
  incomingPath: string,
  expectedRaw: Buffer,
  field: PublicationField,
  maximumBytes: number,
  hierarchy: OpenHierarchy,
  effectiveUid: number,
  io: ProductionRuntimeVaultReceiptStoreIo,
): Result<StrictFile, ProductionRuntimeVaultReceiptStoreError> {
  let incoming = readStrictFile(
    incomingPath,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
    true,
    [1n, 2n],
    true,
  );
  if (!incoming.ok) return incoming;
  if (incoming.value === undefined) {
    const created = createEmptyIncoming(
      incomingPath,
      field,
      maximumBytes,
      hierarchy,
      effectiveUid,
    );
    if (!created.ok) return created;
    incoming = readStrictFile(
      incomingPath,
      field,
      maximumBytes,
      hierarchy,
      effectiveUid,
      false,
      [1n, 2n],
      true,
    );
    if (!incoming.ok || incoming.value === undefined) {
      return incoming.ok ? unsafeFile(field) : incoming;
    }
  }
  if (incoming.value.identity.nlink !== 1n) return unsafeFile(field);
  if (!isExactPrefix(incoming.value.raw, expectedRaw)) return publicationConflict(field);

  if (incoming.value.raw.length < expectedRaw.length) {
    const opened = tryCatch(() =>
      openSync(
        incomingPath,
        constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
      ),
    );
    if (!opened.ok) return unsafeFile(field);
    const before = tryCatch(() => fstatSync(opened.value, { bigint: true }));
    if (
      !before.ok ||
      !sameStableFile(incoming.value.identity, before.value) ||
      !isPrivateFile(before.value, effectiveUid, maximumBytes, [1n], true)
    ) {
      const closed = closeDescriptor(opened.value);
      if (!closed.ok) return closed;
      return unsafeFile(field);
    }

    let offset = incoming.value.raw.length;
    while (offset < expectedRaw.length) {
      const written = tryCatch(() =>
        io.write(opened.value, expectedRaw, offset, expectedRaw.length - offset),
      );
      if (!written.ok || written.value <= 0 || written.value > expectedRaw.length - offset) {
        const preserved = preserveFailedIncomingWrite(opened.value, hierarchy);
        if (!preserved.ok) return preserved;
        return ioFailure("write_incoming");
      }
      offset += written.value;
    }
    const fileSynchronized = tryCatch(() => fsyncSync(opened.value));
    const finalValue = tryCatch(() => fstatSync(opened.value, { bigint: true }));
    const closed = closeDescriptor(opened.value);
    if (!closed.ok) return closed;
    if (
      !fileSynchronized.ok ||
      !finalValue.ok ||
      !sameInode(before.value, finalValue.value) ||
      !isPrivateFile(finalValue.value, effectiveUid, maximumBytes, [1n], false) ||
      finalValue.value.size !== BigInt(expectedRaw.length)
    ) {
      return ioFailure("complete_incoming");
    }
  }

  const completed = readStrictFile(
    incomingPath,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
    false,
    [1n],
    false,
  );
  if (!completed.ok || completed.value === undefined) {
    return completed.ok ? unsafeFile(field) : completed;
  }
  if (!completed.value.raw.equals(expectedRaw)) return publicationConflict(field);
  const fileDurable = synchronizeFile(
    incomingPath,
    completed.value.identity,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
    [1n],
    false,
  );
  if (!fileDurable.ok) return fileDurable;
  const directoriesDurable = synchronizeGuards(hierarchy.guards);
  if (!directoriesDurable.ok) return directoriesDurable;
  return ok(completed.value);
}

function publishCrashSafeFile(
  finalPath: string,
  incomingPath: string,
  raw: Buffer,
  field: PublicationField,
  maximumBytes: number,
  hierarchy: OpenHierarchy,
  effectiveUid: number,
  io: ProductionRuntimeVaultReceiptStoreIo,
): Result<"created" | "exists", ProductionRuntimeVaultReceiptStoreError> {
  const existing = reconcileExistingPublication(
    finalPath,
    incomingPath,
    raw,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
  );
  if (!existing.ok) return existing;
  if (existing.value.kind !== "absent") return ok("exists");

  const incoming = ensureCompleteIncoming(
    incomingPath,
    raw,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
    io,
  );
  if (!incoming.ok) return incoming;
  const linked = tryCatch(() => linkSync(incomingPath, finalPath));
  if (!linked.ok && errorCode(linked.error) !== "EEXIST") {
    return ioFailure("publish_final_link");
  }
  const reconciled = reconcileExistingPublication(
    finalPath,
    incomingPath,
    raw,
    field,
    maximumBytes,
    hierarchy,
    effectiveUid,
  );
  if (!reconciled.ok) return reconciled;
  if (reconciled.value.kind !== "exact") return unsafeFile(field);
  return ok(linked.ok ? "created" : "exists");
}

function makeTerminalRecord(
  receipt: ProductionRuntimeVaultRecoveryReceipt,
  rawReceipt: Buffer,
  disposition: ProductionRuntimeVaultTerminalDisposition,
  authorityKey: Uint8Array,
): ProductionRuntimeVaultTerminalRecord {
  const unsigned: UnsignedTerminalRecord = {
    schema: TERMINAL_SCHEMA,
    schemaVersion: 1,
    runId: receipt.runId,
    attemptId: receipt.attemptId,
    disposition,
    authorityKeyIdSha256: receipt.seal.authorityKeyIdSha256,
    receiptAuthorityDigestSha256: receipt.seal.authorityDigestSha256,
    receiptDigestSha256: sha256(rawReceipt),
  };
  return { ...unsigned, authenticationTagSha256: terminalAuthenticationTag(unsigned, authorityKey) };
}

function serializeTerminalRecord(record: ProductionRuntimeVaultTerminalRecord): Buffer {
  return Buffer.from(`${canonicalJson(record)}\n`, "utf8");
}

function parseTerminalRecord(
  raw: Buffer,
  receipt: StrictReceipt,
  authorityKey: Uint8Array,
): Result<ProductionRuntimeVaultTerminalRecord, ProductionRuntimeVaultReceiptStoreError> {
  const decodedText = decodeStrictUtf8(raw, "terminalRecord");
  if (!decodedText.ok) return decodedText;
  const text = decodedText.value;
  const decoded = tryCatch(() => JSON.parse(text.slice(0, -1)) as unknown);
  if (
    raw.length > MAX_TERMINAL_BYTES ||
    !text.endsWith("\n") ||
    text.slice(0, -1).includes("\n") ||
    text.includes("\r") ||
    text.includes("\0") ||
    !decoded.ok ||
    !isRecord(decoded.value) ||
    !hasExactKeys(decoded.value, TERMINAL_KEYS) ||
    `${canonicalJson(decoded.value)}\n` !== text
  ) {
    return failure({
      kind: "invalid_terminal_record",
      field: "terminalRecord",
      message: "Stored terminal record is not a strict canonical authenticated record",
    });
  }

  const value = decoded.value;
  const disposition = value.disposition;
  if (
    value.schema !== TERMINAL_SCHEMA ||
    value.schemaVersion !== 1 ||
    typeof value.runId !== "string" ||
    !SAFE_RUN_ID_RE.test(value.runId) ||
    typeof value.attemptId !== "string" ||
    !ATTEMPT_ID_RE.test(value.attemptId) ||
    typeof disposition !== "string" ||
    !TERMINAL_DISPOSITIONS.includes(disposition as ProductionRuntimeVaultTerminalDisposition) ||
    typeof value.authorityKeyIdSha256 !== "string" ||
    !SHA256_RE.test(value.authorityKeyIdSha256) ||
    typeof value.receiptAuthorityDigestSha256 !== "string" ||
    !SHA256_RE.test(value.receiptAuthorityDigestSha256) ||
    typeof value.receiptDigestSha256 !== "string" ||
    !SHA256_RE.test(value.receiptDigestSha256) ||
    typeof value.authenticationTagSha256 !== "string" ||
    !SHA256_RE.test(value.authenticationTagSha256)
  ) {
    return failure({
      kind: "invalid_terminal_record",
      field: "terminalRecord",
      message: "Stored terminal record fields are invalid",
    });
  }

  const unsigned: UnsignedTerminalRecord = {
    schema: TERMINAL_SCHEMA,
    schemaVersion: 1,
    runId: value.runId,
    attemptId: value.attemptId,
    disposition: disposition as ProductionRuntimeVaultTerminalDisposition,
    authorityKeyIdSha256: value.authorityKeyIdSha256,
    receiptAuthorityDigestSha256: value.receiptAuthorityDigestSha256,
    receiptDigestSha256: value.receiptDigestSha256,
  };
  const valid =
    unsigned.runId === receipt.receipt.runId &&
    unsigned.attemptId === receipt.receipt.attemptId &&
    equalDigest(unsigned.authorityKeyIdSha256, receipt.receipt.seal.authorityKeyIdSha256) &&
    equalDigest(
      unsigned.receiptAuthorityDigestSha256,
      receipt.receipt.seal.authorityDigestSha256,
    ) &&
    equalDigest(unsigned.receiptDigestSha256, sha256(receipt.raw)) &&
    equalDigest(value.authenticationTagSha256, terminalAuthenticationTag(unsigned, authorityKey));
  if (!valid) {
    return failure({
      kind: "invalid_terminal_record",
      field: "terminalRecord",
      message: "Stored terminal record failed receipt binding or authority verification",
    });
  }
  return ok({ ...unsigned, authenticationTagSha256: value.authenticationTagSha256 });
}

export function createProductionRuntimeVaultReceiptStoreForTests(
  options: CreateProductionRuntimeVaultReceiptStoreTestOptions,
): Result<ProductionRuntimeVaultReceiptStoreTestHarness, ProductionRuntimeVaultReceiptStoreError> {
  if (!isRecord(options)) return invalidRequest("options", "Receipt store options are required");
  if (
    typeof options.stateRoot !== "string" ||
    !isAbsolute(options.stateRoot) ||
    resolve(options.stateRoot) !== options.stateRoot
  ) {
    return unsafeRoot();
  }
  if (!(options.authorityKey instanceof Uint8Array) || options.authorityKey.byteLength < MIN_AUTHORITY_KEY_BYTES) {
    return invalidRequest("authorityKey", "Receipt authority key must contain at least 32 bytes");
  }
  if (options.io !== undefined && typeof options.io.write !== "function") {
    return invalidRequest("io", "Receipt store I/O dependency is invalid");
  }
  const effectiveUid = currentEffectiveUid();
  if (!effectiveUid.ok) return effectiveUid;
  const uid = effectiveUid.value;
  const root = openDirectoryGuard(options.stateRoot, uid, true);
  if (!root.ok) return root;
  const rootClosed = closeDescriptor(root.value.descriptor);
  if (!rootClosed.ok) return rootClosed;

  const stateRoot = options.stateRoot;
  const authorityKey = Uint8Array.from(options.authorityKey);
  const io: ProductionRuntimeVaultReceiptStoreIo =
    options.io ?? {
      write(descriptor, data, offset, length) {
        return writeSync(descriptor, data, offset, length);
      },
    };

  function paths(
    runId: string,
    attemptId: string,
  ): Result<ProductionRuntimeVaultReceiptPaths, ProductionRuntimeVaultReceiptStoreError> {
    return resolvePaths(stateRoot, runId, attemptId);
  }

  function createAndPersistReceipt(
    input: ProductionRuntimeVaultRecoveryReceiptInput,
  ): Result<ProductionRuntimeVaultCreatedReceipt, ProductionRuntimeVaultReceiptStoreError> {
    const createdBoundary = tryCatch(() =>
      createProductionRuntimeVaultRecoveryReceipt(input, authorityKey),
    );
    if (!createdBoundary.ok || !createdBoundary.value.ok) {
      return failure({
        kind: "invalid_receipt",
        field: "receipt",
        message: "Recovery receipt input failed strict authority validation",
      });
    }
    const persisted = persistReceipt(createdBoundary.value.value);
    if (!persisted.ok) return persisted;
    return ok({ ...persisted.value, receipt: createdBoundary.value.value });
  }

  function persistReceipt(
    receipt: ProductionRuntimeVaultRecoveryReceipt,
  ): Result<ProductionRuntimeVaultReceiptPersistence, ProductionRuntimeVaultReceiptStoreError> {
    const authenticated = authenticateReceiptValue(receipt, authorityKey);
    if (!authenticated.ok) return authenticated;
    return withAttemptLock(
      stateRoot,
      authenticated.value.receipt.runId,
      authenticated.value.receipt.attemptId,
      () => persistAuthenticatedReceipt(authenticated.value),
    );
  }

  function persistAuthenticatedReceipt(
    authenticated: StrictReceipt,
  ): Result<ProductionRuntimeVaultReceiptPersistence, ProductionRuntimeVaultReceiptStoreError> {
    const raw = authenticated.raw;
    const canonicalReceipt = authenticated.receipt;
    const hierarchy = openHierarchy(
      stateRoot,
      canonicalReceipt.runId,
      canonicalReceipt.attemptId,
      uid,
      true,
    );
    if (!hierarchy.ok) return hierarchy;
    const written = publishCrashSafeFile(
      hierarchy.value.paths.receiptPath,
      hierarchy.value.paths.receiptIncomingPath,
      raw,
      "receiptFile",
      MAX_RECEIPT_BYTES,
      hierarchy.value,
      uid,
      io,
    );
    if (!written.ok) {
      const closed = closeGuards(hierarchy.value.guards);
      if (!closed.ok) return closed;
      return written;
    }
    if (written.value === "exists") {
      const existing = readReceiptFromHierarchy(
        hierarchy.value,
        authorityKey,
        uid,
      );
      const closed = closeGuards(hierarchy.value.guards);
      if (!closed.ok) return closed;
      if (!existing.ok) return existing;
      if (!existing.value.raw.equals(raw)) {
        return failure({
          kind: "conflict",
          field: "receipt",
          message: "A different authenticated recovery receipt already exists for this attempt",
        });
      }
      return ok({ status: "already_present", path: hierarchy.value.paths.receiptPath });
    }
    const closed = closeGuards(hierarchy.value.guards);
    if (!closed.ok) return closed;
    return ok({ status: "created", path: hierarchy.value.paths.receiptPath });
  }

  function readReceipt(
    runId: string,
    attemptId: string,
  ): Result<ProductionRuntimeVaultRecoveryReceipt, ProductionRuntimeVaultReceiptStoreError> {
    const hierarchy = openHierarchy(stateRoot, runId, attemptId, uid, false);
    if (!hierarchy.ok) return hierarchy;
    const receipt = readReceiptFromHierarchy(hierarchy.value, authorityKey, uid);
    const closed = closeGuards(hierarchy.value.guards);
    if (!closed.ok) return closed;
    return receipt.ok ? ok(receipt.value.receipt) : receipt;
  }

  function recordTerminal(
    receipt: ProductionRuntimeVaultRecoveryReceipt,
    disposition: ProductionRuntimeVaultTerminalDisposition,
  ): Result<ProductionRuntimeVaultReceiptPersistence, ProductionRuntimeVaultReceiptStoreError> {
    if (!TERMINAL_DISPOSITIONS.includes(disposition)) {
      return invalidRequest("disposition", "Terminal disposition is not part of the closed contract");
    }
    const proposedReceipt = authenticateReceiptValue(receipt, authorityKey);
    if (!proposedReceipt.ok) return proposedReceipt;
    return withAttemptLock(
      stateRoot,
      proposedReceipt.value.receipt.runId,
      proposedReceipt.value.receipt.attemptId,
      () => recordTerminalAuthenticated(proposedReceipt.value, disposition),
    );
  }

  function recordTerminalAuthenticated(
    proposedReceipt: StrictReceipt,
    disposition: ProductionRuntimeVaultTerminalDisposition,
  ): Result<ProductionRuntimeVaultReceiptPersistence, ProductionRuntimeVaultReceiptStoreError> {
    const hierarchy = openHierarchy(
      stateRoot,
      proposedReceipt.receipt.runId,
      proposedReceipt.receipt.attemptId,
      uid,
      false,
    );
    if (!hierarchy.ok) return hierarchy;
    const storedReceipt = readReceiptFromHierarchy(
      hierarchy.value,
      authorityKey,
      uid,
    );
    if (!storedReceipt.ok) {
      const closed = closeGuards(hierarchy.value.guards);
      if (!closed.ok) return closed;
      return storedReceipt;
    }
    const proposedRaw = proposedReceipt.raw;
    if (!storedReceipt.value.raw.equals(proposedRaw)) {
      const closed = closeGuards(hierarchy.value.guards);
      if (!closed.ok) return closed;
      return failure({
        kind: "conflict",
        field: "receipt",
        message: "Terminal record receipt does not match the durable recovery authority",
      });
    }
    const record = makeTerminalRecord(
      proposedReceipt.receipt,
      proposedRaw,
      disposition,
      authorityKey,
    );
    const raw = serializeTerminalRecord(record);
    const written = publishCrashSafeFile(
      hierarchy.value.paths.terminalPath,
      hierarchy.value.paths.terminalIncomingPath,
      raw,
      "terminalFile",
      MAX_TERMINAL_BYTES,
      hierarchy.value,
      uid,
      io,
    );
    if (!written.ok) {
      const closed = closeGuards(hierarchy.value.guards);
      if (!closed.ok) return closed;
      return written;
    }
    if (written.value === "exists") {
      const existingRaw = readStrictFile(
        hierarchy.value.paths.terminalPath,
        "terminalFile",
        MAX_TERMINAL_BYTES,
        hierarchy.value,
        uid,
        false,
      );
      if (!existingRaw.ok || existingRaw.value === undefined) {
        const closed = closeGuards(hierarchy.value.guards);
        if (!closed.ok) return closed;
        return existingRaw.ok
          ? failure({
              kind: "invalid_terminal_record",
              field: "terminalRecord",
              message: "Stored terminal record disappeared during verification",
            })
          : existingRaw;
      }
      const parsed = parseTerminalRecord(existingRaw.value.raw, storedReceipt.value, authorityKey);
      const closed = closeGuards(hierarchy.value.guards);
      if (!closed.ok) return closed;
      if (!parsed.ok) return parsed;
      if (!existingRaw.value.raw.equals(raw)) {
        return failure({
          kind: "conflict",
          field: "terminalRecord",
          message: "A different authenticated terminal disposition already exists",
        });
      }
      return ok({ status: "already_present", path: hierarchy.value.paths.terminalPath });
    }
    const closed = closeGuards(hierarchy.value.guards);
    if (!closed.ok) return closed;
    return ok({ status: "created", path: hierarchy.value.paths.terminalPath });
  }

  function readTerminal(
    runId: string,
    attemptId: string,
  ): Result<
    ProductionRuntimeVaultTerminalRecord | undefined,
    ProductionRuntimeVaultReceiptStoreError
  > {
    const hierarchy = openHierarchy(stateRoot, runId, attemptId, uid, false);
    if (!hierarchy.ok) return hierarchy;
    const receipt = readReceiptFromHierarchy(hierarchy.value, authorityKey, uid);
    if (!receipt.ok) {
      const closed = closeGuards(hierarchy.value.guards);
      if (!closed.ok) return closed;
      return receipt;
    }
    const terminal = readStrictFile(
      hierarchy.value.paths.terminalPath,
      "terminalFile",
      MAX_TERMINAL_BYTES,
      hierarchy.value,
      uid,
      true,
    );
    if (!terminal.ok) {
      const closed = closeGuards(hierarchy.value.guards);
      if (!closed.ok) return closed;
      return terminal;
    }
    if (terminal.value === undefined) {
      const closed = closeGuards(hierarchy.value.guards);
      if (!closed.ok) return closed;
      return ok(undefined);
    }
    const parsed = parseTerminalRecord(terminal.value.raw, receipt.value, authorityKey);
    const closed = closeGuards(hierarchy.value.guards);
    if (!closed.ok) return closed;
    return parsed;
  }

  return ok({
    createAndPersistReceipt,
    paths,
    persistReceipt,
    readReceipt,
    recordTerminal,
    readTerminal,
  });
}
