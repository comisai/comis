// SPDX-License-Identifier: Apache-2.0
// @allow-throw: filesystem guard callbacks throw only inside tryCatch boundaries that immediately return Result errors.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, normalize } from "node:path";
import type Database from "better-sqlite3";
import {
  ManagedRunActivationDescriptorSchema,
  ManagedRunReportBodySchema,
  MAX_MANAGED_EVIDENCE_PRIVATE_BYTES,
  safePath,
  systemNowMs,
  type ManagedRunActivationDescriptor,
  type ManagedRunContentPort,
  type ManagedRunContentScope,
  type ManagedRunPrivateContentReceipt,
  type ManagedRunReportBody,
} from "@comis/core";
import { err, isFsyncDisabledByPermissionModel, ok, tryCatch, type Result } from "@comis/shared";
import {
  ManagedRunContentDbRowSchema,
  type ManagedRunContentDbRow,
} from "./managed-run-content-row-schema.js";
import { createRowMapper } from "./row-mapper.js";

const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/;
const MAX_ATTENTION_BYTES = 16_384;
const contentMapper = createRowMapper(ManagedRunContentDbRowSchema);
type ContentKind = ManagedRunContentDbRow["kind"];

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function scopeDigest(scope: ManagedRunContentScope): string {
  return digest(JSON.stringify([scope.tenantId, scope.agentId, scope.managedRunId]));
}

function contentFilename(kind: ContentKind, contentRef: string): string {
  return `${digest(JSON.stringify([kind, contentRef]))}.body`;
}

function receipt(row: ManagedRunContentDbRow): ManagedRunPrivateContentReceipt {
  return {
    contentRef: row.content_ref,
    contentHash: row.content_hash,
    byteLength: row.byte_length,
    ...(row.expires_at_ms === null ? {} : { expiresAtMs: row.expires_at_ms }),
  };
}

function fromCause(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function relativePathParts(relativePath: string): Result<readonly [string, string], Error> {
  const parsed = /^([a-f0-9]{64})\/([a-f0-9]{64}\.body)$/.exec(relativePath);
  return parsed?.[1] !== undefined && parsed[2] !== undefined
    ? ok([parsed[1], parsed[2]] as const)
    : err(new Error("managed-run content index path is invalid"));
}

function syncFile(fd: number): void {
  try {
    fsyncSync(fd);
  } catch (cause) {
    if (!isFsyncDisabledByPermissionModel(cause)) throw cause;
  }
}

function ensureOwnerOnlyDirectory(path: string): Result<void, Error> {
  const checked = tryCatch(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- factory preflight inspects only the caller-supplied absolute canonical content root
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
      throw new Error("managed-run content directory must be a real owner-only directory");
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- canonicality is checked on the same caller-supplied root before any child path is derived
    if (realpathSync(path) !== path) {
      throw new Error("managed-run content directory must be canonical");
    }
  });
  return checked.ok ? ok(undefined) : err(fromCause(checked.error));
}

function ensureScopeDirectory(root: string, scope: ManagedRunContentScope): Result<string, Error> {
  const resolved = tryCatch(() => safePath(root, scopeDigest(scope)));
  if (!resolved.ok) return err(fromCause(resolved.error));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved is safePath-confined beneath the verified owner-only content root
  const created = tryCatch(() => mkdirSync(resolved.value, { mode: 0o700 }));
  if (!created.ok && (created.error as NodeJS.ErrnoException).code !== "EEXIST") {
    return err(fromCause(created.error));
  }
  const checked = ensureOwnerOnlyDirectory(resolved.value);
  return checked.ok ? ok(resolved.value) : checked;
}

function filePathFromRow(root: string, row: ManagedRunContentDbRow): Result<string, Error> {
  const parts = relativePathParts(row.relative_path);
  if (!parts.ok) return parts;
  const resolved = tryCatch(() => safePath(root, ...parts.value));
  return resolved.ok ? resolved : err(fromCause(resolved.error));
}

function readVerifiedBody(root: string, row: ManagedRunContentDbRow): Result<Uint8Array, Error> {
  const path = filePathFromRow(root, row);
  if (!path.ok) return path;
  const loaded = tryCatch(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is reconstructed from a strict indexed relative path through safePath
    const fd = openSync(path.value, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
        throw new Error("managed-run content body is not a 0600 regular file");
      }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- numeric descriptor was opened O_NOFOLLOW from the safePath-confined body path
      const bytes = readFileSync(fd);
      if (bytes.byteLength !== row.byte_length || digest(bytes) !== row.content_hash) {
        throw new Error("managed-run content body failed its durable hash check");
      }
      return new Uint8Array(bytes);
    } finally {
      closeSync(fd);
    }
  });
  return loaded.ok ? ok(loaded.value) : err(fromCause(loaded.error));
}

function writeAtomicBody(
  directory: string,
  targetPath: string,
  bytes: Uint8Array,
): Result<"created" | "existing", Error> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- targetPath is safePath-confined beneath a verified scope directory
  const existing = tryCatch(() => lstatSync(targetPath));
  if (existing.ok) {
    const loaded = tryCatch(() => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- targetPath is safePath-confined and reopened with O_NOFOLLOW before orphan recovery
      const existingFd = openSync(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(existingFd);
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
          throw new Error("managed-run content path is not a 0600 regular file");
        }
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- numeric descriptor was opened O_NOFOLLOW from the safePath-confined orphan path
        return readFileSync(existingFd);
      } finally {
        closeSync(existingFd);
      }
    });
    if (
      existing.value.isFile()
      && !existing.value.isSymbolicLink()
      && (existing.value.mode & 0o777) === 0o600
      && loaded.ok
      && digest(loaded.value) === digest(bytes)
    ) return ok("existing");
    return err(new Error("managed-run content path is occupied by different data"));
  }
  if ((existing.error as NodeJS.ErrnoException).code !== "ENOENT") return err(fromCause(existing.error));

  const temporary = tryCatch(() => safePath(
    directory,
    `${digest(bytes)}.${randomBytes(8).toString("hex")}.tmp`,
  ));
  if (!temporary.ok) return err(fromCause(temporary.error));
  let fd: number | undefined;
  const written = tryCatch(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- temporary.value is safePath-confined and opened with exclusive no-follow flags
    const openedFd = openSync(
      temporary.value,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    fd = openedFd;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- numeric descriptor is the exclusive O_NOFOLLOW temp file opened immediately above
    writeFileSync(openedFd, bytes);
    syncFile(openedFd);
    closeSync(openedFd);
    fd = undefined;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- hard-link publication is atomic and cannot replace an authoritative body created by a concurrent writer
    linkSync(temporary.value, targetPath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- removes only the exact safePath-confined temp name after atomic publication
    unlinkSync(temporary.value);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- directory is a verified owner-only safePath-confined scope directory
    const directoryFd = openSync(directory, constants.O_RDONLY);
    try {
      syncFile(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  });
  if (written.ok) return ok("created");
  const danglingFd = fd;
  if (danglingFd !== undefined) tryCatch(() => closeSync(danglingFd));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- removes only the exact safePath-confined temp name created by this write
  tryCatch(() => unlinkSync(temporary.value));
  if ((written.error as NodeJS.ErrnoException).code === "EEXIST") {
    return writeAtomicBody(directory, targetPath, bytes);
  }
  return err(fromCause(written.error));
}

export interface SqliteManagedRunContentStoreOptions {
  readonly directoryPath: string;
  readonly nowMs?: () => number;
}

/** Create an owner-confined file-body store with a content-free SQLite index. */
export function createSqliteManagedRunContentStore(
  db: Database.Database,
  options: SqliteManagedRunContentStoreOptions,
): Result<ManagedRunContentPort, Error> {
  if (!isAbsolute(options.directoryPath) || normalize(options.directoryPath) !== options.directoryPath) {
    return err(new Error("managed-run content root must be an absolute canonical path"));
  }
  const rootCheck = ensureOwnerOnlyDirectory(options.directoryPath);
  if (!rootCheck.ok) return rootCheck;
  const nowMs = options.nowMs ?? systemNowMs;
  const selectContent = db.prepare(`
    SELECT * FROM managed_run_content_index
    WHERE tenant_id = ? AND agent_id = ? AND managed_run_id = ? AND content_ref = ?
  `);
  const insertContent = db.prepare(`
    INSERT INTO managed_run_content_index (
      tenant_id, agent_id, managed_run_id, content_ref, kind, content_hash,
      byte_length, relative_path, expires_at_ms, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteContent = db.prepare(`
    DELETE FROM managed_run_content_index
    WHERE tenant_id = ? AND agent_id = ? AND managed_run_id = ? AND content_ref = ? AND kind = ?
  `);
  const selectExpired = db.prepare(`
    SELECT * FROM managed_run_content_index
    WHERE expires_at_ms IS NOT NULL AND expires_at_ms <= ?
    ORDER BY expires_at_ms ASC, content_ref ASC
    LIMIT ?
  `);

  function selectRow(
    scope: ManagedRunContentScope,
    contentRef: string,
  ): Result<ManagedRunContentDbRow | undefined, Error> {
    const row = contentMapper.parseOptionalRow(selectContent.get(
      scope.tenantId,
      scope.agentId,
      scope.managedRunId,
      contentRef,
    ));
    return row.ok ? row : err(new Error(row.error.message));
  }

  function put(
    scope: ManagedRunContentScope,
    contentRef: string,
    kind: ContentKind,
    bytes: Uint8Array,
    expiresAtMs?: number,
  ): Result<ManagedRunPrivateContentReceipt, Error> {
    if (!OPAQUE_REF_PATTERN.test(contentRef) || bytes.byteLength === 0) {
      return err(new Error("managed-run private content identity or body is invalid"));
    }
    const existing = selectRow(scope, contentRef);
    if (!existing.ok) return existing;
    const contentHash = digest(bytes);
    if (existing.value !== undefined) {
      if (existing.value.kind !== kind || existing.value.content_hash !== contentHash) {
        return err(new Error("managed-run private content replay conflicts with the original body"));
      }
      const verified = readVerifiedBody(options.directoryPath, existing.value);
      return verified.ok ? ok(receipt(existing.value)) : verified;
    }
    const directory = ensureScopeDirectory(options.directoryPath, scope);
    if (!directory.ok) return directory;
    const filename = contentFilename(kind, contentRef);
    const target = tryCatch(() => safePath(directory.value, filename));
    if (!target.ok) return err(fromCause(target.error));
    const persisted = writeAtomicBody(directory.value, target.value, bytes);
    if (!persisted.ok) return persisted;
    const scopeSegment = scopeDigest(scope);
    const relativePath = `${scopeSegment}/${filename}`;
    const indexed = tryCatch(() => insertContent.run(
      scope.tenantId,
      scope.agentId,
      scope.managedRunId,
      contentRef,
      kind,
      contentHash,
      bytes.byteLength,
      relativePath,
      expiresAtMs ?? null,
      nowMs(),
    ));
    if (!indexed.ok) {
      const raced = selectRow(scope, contentRef);
      if (
        raced.ok
        && raced.value !== undefined
        && raced.value.kind === kind
        && raced.value.content_hash === contentHash
        && raced.value.byte_length === bytes.byteLength
        && raced.value.relative_path === relativePath
      ) {
        const verified = readVerifiedBody(options.directoryPath, raced.value);
        if (verified.ok) return ok(receipt(raced.value));
      }
      if (raced.ok && raced.value !== undefined) {
        return err(new Error("managed-run private content replay conflicts with the original body"));
      }
      if (persisted.value === "created" && raced.ok) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- removes only the exact safePath-confined body created by this writer after proving no index owns it
        tryCatch(() => unlinkSync(target.value));
      }
      return err(fromCause(indexed.error));
    }
    return ok({
      contentRef,
      contentHash,
      byteLength: bytes.byteLength,
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    });
  }

  function read(
    scope: ManagedRunContentScope,
    contentRef: string,
    kind: ContentKind,
    includeExpired = false,
  ): Result<Uint8Array | undefined, Error> {
    const row = selectRow(scope, contentRef);
    if (!row.ok) return row;
    if (row.value === undefined) return ok(undefined);
    if (row.value.kind !== kind) return ok(undefined);
    if (!includeExpired && row.value.expires_at_ms !== null && row.value.expires_at_ms <= nowMs()) {
      return ok(undefined);
    }
    return readVerifiedBody(options.directoryPath, row.value);
  }

  function removeRow(row: ManagedRunContentDbRow): Result<boolean, Error> {
    const path = filePathFromRow(options.directoryPath, row);
    if (!path.ok) return path;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- removes only the strict indexed path reconstructed through safePath
    const removedFile = tryCatch(() => unlinkSync(path.value));
    if (!removedFile.ok && (removedFile.error as NodeJS.ErrnoException).code !== "ENOENT") {
      return err(fromCause(removedFile.error));
    }
    const removedIndex = tryCatch(() => deleteContent.run(
      row.tenant_id,
      row.agent_id,
      row.managed_run_id,
      row.content_ref,
      row.kind,
    ));
    return removedIndex.ok
      ? ok(removedIndex.value.changes === 1)
      : err(fromCause(removedIndex.error));
  }

  async function boundary<T>(operation: () => Result<T, Error>): Promise<Result<T, Error>> {
    try {
      return operation();
    } catch (cause) {
      return err(fromCause(cause));
    }
  }

  const store: ManagedRunContentPort = {
    putActivationDescriptor: (scope, descriptorRef, descriptor) => boundary(() => {
      const parsed = ManagedRunActivationDescriptorSchema.safeParse(descriptor);
      return parsed.success
        ? put(scope, descriptorRef, "activation", Buffer.from(JSON.stringify(parsed.data)), parsed.data.expiresAtMs)
        : err(new Error(`managed-run activation descriptor is invalid: ${parsed.error.message}`));
    }),
    getActivationDescriptor: (scope, descriptorRef) => boundary<ManagedRunActivationDescriptor | undefined>(() => {
      const body = read(scope, descriptorRef, "activation");
      if (!body.ok) return body;
      if (body.value === undefined) return ok(undefined);
      const bytes = body.value;
      const decoded = tryCatch(() => JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown);
      if (!decoded.ok) return err(fromCause(decoded.error));
      const parsed = ManagedRunActivationDescriptorSchema.safeParse(decoded.value);
      return parsed.success ? ok(parsed.data) : err(new Error("stored activation descriptor is invalid"));
    }),
    getActivationDescriptorForRecovery: (scope, descriptorRef) => boundary<ManagedRunActivationDescriptor | undefined>(() => {
      const body = read(scope, descriptorRef, "activation", true);
      if (!body.ok) return body;
      if (body.value === undefined) return ok(undefined);
      const bytes = body.value;
      const decoded = tryCatch(() => JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown);
      if (!decoded.ok) return err(fromCause(decoded.error));
      const parsed = ManagedRunActivationDescriptorSchema.safeParse(decoded.value);
      return parsed.success ? ok(parsed.data) : err(new Error("stored activation descriptor is invalid"));
    }),
    deleteActivationDescriptor: (scope, descriptorRef) => boundary(() => {
      const row = selectRow(scope, descriptorRef);
      if (!row.ok || row.value === undefined) return row.ok ? ok(false) : row;
      return row.value.kind === "activation" ? removeRow(row.value) : ok(false);
    }),
    putReportBody: (scope, body, retainedUntilMs) => boundary(() => {
      const parsed = ManagedRunReportBodySchema.safeParse(body);
      return parsed.success
        ? put(scope, parsed.data.serviceReportId, "report", Buffer.from(JSON.stringify(parsed.data)), retainedUntilMs)
        : err(new Error(`managed-run report body is invalid: ${parsed.error.message}`));
    }),
    getReportBody: (scope, contentRef) => boundary<ManagedRunReportBody | undefined>(() => {
      const body = read(scope, contentRef, "report");
      if (!body.ok) return body;
      if (body.value === undefined) return ok(undefined);
      const bytes = body.value;
      const decoded = tryCatch(() => JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown);
      if (!decoded.ok) return err(fromCause(decoded.error));
      const parsed = ManagedRunReportBodySchema.safeParse(decoded.value);
      return parsed.success ? ok(parsed.data) : err(new Error("stored report body is invalid"));
    }),
    deleteReportBody: (scope, contentRef) => boundary(() => {
      const row = selectRow(scope, contentRef);
      if (!row.ok || row.value === undefined) return row.ok ? ok(false) : row;
      return row.value.kind === "report" ? removeRow(row.value) : ok(false);
    }),
    putEvidence: (scope, evidenceRef, input) => boundary(() => input.body.byteLength <= MAX_MANAGED_EVIDENCE_PRIVATE_BYTES
      ? put(scope, evidenceRef, "evidence", input.body, input.expiresAtMs)
      : err(new Error("managed-run evidence body exceeds its byte limit"))),
    getEvidence: (scope, contentRef) => boundary(() => read(scope, contentRef, "evidence")),
    deleteEvidence: (scope, contentRef) => boundary(() => {
      const row = selectRow(scope, contentRef);
      if (!row.ok || row.value === undefined) return row.ok ? ok(false) : row;
      return row.value.kind === "evidence" ? removeRow(row.value) : ok(false);
    }),
    putAttentionBody: (scope, attentionRef, input) => boundary(() => input.body.byteLength <= MAX_ATTENTION_BYTES
      ? put(scope, attentionRef, "attention", input.body, input.expiresAtMs)
      : err(new Error("managed-run attention body exceeds its byte limit"))),
    getAttentionBody: (scope, contentRef) => boundary(() => read(scope, contentRef, "attention")),
    deleteAttentionBody: (scope, contentRef) => boundary(() => {
      const row = selectRow(scope, contentRef);
      if (!row.ok || row.value === undefined) return row.ok ? ok(false) : row;
      return row.value.kind === "attention" ? removeRow(row.value) : ok(false);
    }),
    purgeExpired: (input) => boundary(() => {
      if (!Number.isInteger(input.limit) || input.limit <= 0 || input.limit > 10_000) {
        return err(new Error("managed-run content purge limit is invalid"));
      }
      const rows = contentMapper.parseRows(selectExpired.all(input.expiredBeforeMs, input.limit));
      if (!rows.ok) return err(new Error(rows.error.message));
      let removed = 0;
      for (const row of rows.value) {
        const result = removeRow(row);
        if (!result.ok) return result;
        if (result.value) removed += 1;
      }
      return ok(removed);
    }),
  };
  return ok(Object.freeze(store));
}
