// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ErrorKind, FileLockPort } from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import { replaceDurableFile } from "../persistence/durable-file.js";
import {
  CronExecutionRowSchema,
  CronExecutionStartedRowSchema,
  CronExecutionTerminalRowSchema,
  encodeCronExecutionRow,
  type CronExecutionRow,
  type CronExecutionStartedRow,
  type CronExecutionTerminalRow,
} from "./cron-execution-record.js";

export const DEFAULT_EXECUTION_LOG_BYTES = 2_000_000;
export const DEFAULT_RETAINED_EXECUTIONS = 2_000;
export const MAX_CRON_TERMINAL_ROW_BYTES = 64 * 1_024;
const MAX_EXECUTION_LOG_BYTES = 32 * 1_024 * 1_024;
const LOCK_OPTIONS = { staleMs: 30_000, updateMs: 5_000 } as const;

export type ExecutionTrackerErrorCode =
  | "not_initialized"
  | "invalid_path"
  | "invalid_state"
  | "lock_contended"
  | "lock_failed"
  | "io"
  | "not_found"
  | "conflict"
  | "capacity";

export type ExecutionTrackerError = {
  code: ExecutionTrackerErrorCode;
  errorKind: ErrorKind;
  message: string;
  line?: number;
  fileDigest?: string;
};

export type CronExecutionGroup = {
  start: CronExecutionStartedRow;
  terminal?: CronExecutionTerminalRow;
};

export type ExecutionTrackerInitialization = {
  executions: number;
  fileDigest: string;
};

export interface ExecutionTrackerOptions {
  logPath: string;
  lockPath: string;
  fileLock: FileLockPort;
  idFactory: () => string;
  maxLogBytes?: number;
  retainedExecutions?: number;
}

export interface ExecutionTracker {
  initialize(): Promise<Result<ExecutionTrackerInitialization, ExecutionTrackerError>>;
  appendRecoveredExecution(
    start: CronExecutionStartedRow,
    terminal: CronExecutionTerminalRow,
    protectedExecutionIds?: readonly string[],
  ): Promise<Result<void, ExecutionTrackerError>>;
  appendStart(
    row: CronExecutionStartedRow,
    protectedExecutionIds?: readonly string[],
  ): Promise<Result<void, ExecutionTrackerError>>;
  appendTerminal(
    row: CronExecutionTerminalRow,
    protectedExecutionIds?: readonly string[],
  ): Promise<Result<void, ExecutionTrackerError>>;
  readExecution(executionId: string): Promise<Result<CronExecutionGroup | undefined, ExecutionTrackerError>>;
  listHistory(input: {
    jobId?: string;
    limit: number;
  }): Promise<Result<readonly CronExecutionGroup[], ExecutionTrackerError>>;
  listOwnershipGroups(): Promise<Result<readonly CronExecutionGroup[], ExecutionTrackerError>>;
  prune(protectedExecutionIds?: readonly string[]): Promise<Result<void, ExecutionTrackerError>>;
}

type LedgerScan = {
  raw: Buffer;
  rows: CronExecutionRow[];
  groups: Map<string, CronExecutionGroup>;
  digest: string;
};

export function createExecutionTracker(options: ExecutionTrackerOptions): ExecutionTracker {
  const maxLogBytes = options.maxLogBytes ?? DEFAULT_EXECUTION_LOG_BYTES;
  const retainedExecutions = options.retainedExecutions ?? DEFAULT_RETAINED_EXECUTIONS;
  const optionsError = validateOptions(options, maxLogBytes, retainedExecutions);
  const mutex = createMutex();
  let initialized = false;

  async function initialize(): Promise<Result<ExecutionTrackerInitialization, ExecutionTrackerError>> {
    return mutex.serialize(async () => {
      if (optionsError !== undefined) return err(optionsError);
      const locked = await options.fileLock.withLock(options.lockPath, async () => {
        const read = await readLedger(true);
        if (!read.ok) return read;
        initialized = true;
        return ok({ executions: read.value.groups.size, fileDigest: read.value.digest });
      }, LOCK_OPTIONS);
      return locked.ok ? locked.value : err(lockError(locked.error.kind, locked.error.message));
    });
  }

  async function appendStart(
    rowInput: CronExecutionStartedRow,
    protectedExecutionIds: readonly string[] = [],
  ): Promise<Result<void, ExecutionTrackerError>> {
    const parsed = CronExecutionStartedRowSchema.safeParse(rowInput);
    if (!parsed.success) return err(trackerError("invalid_state", "validation", "Invalid cron execution start row"));
    return mutate(async (scan) => {
      if (scan.groups.has(parsed.data.executionId)) {
        return err(trackerError("conflict", "precondition", "Cron execution already has a ledger start"));
      }
      const protectedIds = new Set(protectedExecutionIds);
      const rows = pruneRows([...scan.rows, parsed.data], protectedIds, retainedExecutions, maxLogBytes);
      if (!rows.ok) return rows;
      return writeRows(rows.value);
    });
  }

  async function appendRecoveredExecution(
    startInput: CronExecutionStartedRow,
    terminalInput: CronExecutionTerminalRow,
    protectedExecutionIds: readonly string[] = [],
  ): Promise<Result<void, ExecutionTrackerError>> {
    const parsedStart = CronExecutionStartedRowSchema.safeParse(startInput);
    const parsedTerminal = CronExecutionTerminalRowSchema.safeParse(terminalInput);
    if (!parsedStart.success || !parsedTerminal.success) {
      return err(trackerError("invalid_state", "validation", "Invalid recovered cron execution rows"));
    }
    const pairError = validatePair(parsedStart.data, parsedTerminal.data);
    if (pairError !== undefined) return err(pairError);
    const encodedTerminal = encodeCronExecutionRow(parsedTerminal.data);
    if (!encodedTerminal.ok || encodedTerminal.value.byteLength > MAX_CRON_TERMINAL_ROW_BYTES) {
      return err(trackerError("capacity", "resource", "Recovered cron execution terminal exceeds its reserved byte ceiling"));
    }
    return mutate(async (scan) => {
      if (scan.groups.has(parsedStart.data.executionId)) {
        return err(trackerError("conflict", "precondition", "Cron execution already has a ledger group"));
      }
      const rows = pruneRows(
        [...scan.rows, parsedStart.data, parsedTerminal.data],
        new Set(protectedExecutionIds),
        retainedExecutions,
        maxLogBytes,
      );
      if (!rows.ok) return rows;
      return writeRows(rows.value);
    });
  }

  async function appendTerminal(
    rowInput: CronExecutionTerminalRow,
    protectedExecutionIds: readonly string[] = [],
  ): Promise<Result<void, ExecutionTrackerError>> {
    const parsed = CronExecutionTerminalRowSchema.safeParse(rowInput);
    if (!parsed.success) return err(trackerError("invalid_state", "validation", "Invalid cron execution terminal row"));
    const encoded = encodeCronExecutionRow(parsed.data);
    if (!encoded.ok || encoded.value.byteLength > MAX_CRON_TERMINAL_ROW_BYTES) {
      return err(trackerError("capacity", "resource", "Cron execution terminal exceeds its reserved byte ceiling"));
    }
    return mutate(async (scan) => {
      const group = scan.groups.get(parsed.data.executionId);
      if (group === undefined) {
        return err(trackerError("not_found", "validation", "Cron execution terminal has no matching start"));
      }
      if (group.terminal !== undefined) {
        return err(trackerError("conflict", "precondition", "Cron execution already has an immutable terminal"));
      }
      const pairError = validatePair(group.start, parsed.data);
      if (pairError !== undefined) return err(pairError);
      const rows = pruneRows(
        [...scan.rows, parsed.data],
        new Set(protectedExecutionIds),
        retainedExecutions,
        maxLogBytes,
      );
      if (!rows.ok) return rows;
      return writeRows(rows.value);
    });
  }

  async function readExecution(
    executionId: string,
  ): Promise<Result<CronExecutionGroup | undefined, ExecutionTrackerError>> {
    if (!validIdentifier(executionId)) {
      return err(trackerError("invalid_state", "validation", "Invalid cron execution id"));
    }
    return readLocked((scan) => ok(cloneGroup(scan.groups.get(executionId))));
  }

  async function listHistory(input: {
    jobId?: string;
    limit: number;
  }): Promise<Result<readonly CronExecutionGroup[], ExecutionTrackerError>> {
    if (
      !Number.isSafeInteger(input.limit)
      || input.limit <= 0
      || input.limit > 100_000
      || (input.jobId !== undefined && !validIdentifier(input.jobId))
    ) {
      return err(trackerError("invalid_state", "validation", "Invalid cron history query"));
    }
    return readLocked((scan) => {
      const groups = [...scan.groups.values()]
        .filter((group) => input.jobId === undefined || group.start.jobId === input.jobId)
        .sort((left, right) => groupTime(right) - groupTime(left))
        .slice(0, input.limit)
        .map((group) => cloneGroup(group)!);
      return ok(groups);
    });
  }

  async function listOwnershipGroups(): Promise<Result<readonly CronExecutionGroup[], ExecutionTrackerError>> {
    return readLocked((scan) => ok([...scan.groups.values()].map((group) => cloneGroup(group)!)));
  }

  async function prune(
    protectedExecutionIds: readonly string[] = [],
  ): Promise<Result<void, ExecutionTrackerError>> {
    return mutate(async (scan) => {
      const rows = pruneRows(
        scan.rows,
        new Set(protectedExecutionIds),
        retainedExecutions,
        maxLogBytes,
      );
      if (!rows.ok) return rows;
      if (sameRows(scan.rows, rows.value)) return ok(undefined);
      return writeRows(rows.value);
    });
  }

  async function mutate(
    operation: (scan: LedgerScan) => Promise<Result<void, ExecutionTrackerError>>,
  ): Promise<Result<void, ExecutionTrackerError>> {
    return mutex.serialize(async () => {
      if (!initialized) return err(trackerError("not_initialized", "precondition", "Cron execution tracker is not initialized"));
      const locked = await options.fileLock.withLock(options.lockPath, async () => {
        const read = await readLedger(false);
        return read.ok ? operation(read.value) : read;
      }, LOCK_OPTIONS);
      return locked.ok ? locked.value : err(lockError(locked.error.kind, locked.error.message));
    });
  }

  async function readLocked<T>(
    project: (scan: LedgerScan) => Result<T, ExecutionTrackerError>,
  ): Promise<Result<T, ExecutionTrackerError>> {
    return mutex.serialize(async () => {
      if (!initialized) return err(trackerError("not_initialized", "precondition", "Cron execution tracker is not initialized"));
      const locked = await options.fileLock.withLock(options.lockPath, async () => {
        const read = await readLedger(false);
        return read.ok ? project(read.value) : read;
      }, LOCK_OPTIONS);
      return locked.ok ? locked.value : err(lockError(locked.error.kind, locked.error.message));
    });
  }

  async function readLedger(createMissing: boolean): Promise<Result<LedgerScan, ExecutionTrackerError>> {
    const read = await fromPromise(fs.readFile(options.logPath));
    if (!read.ok) {
      if (createMissing && isNodeError(read.error, "ENOENT")) {
        const created = await writeRows([]);
        if (!created.ok) return created;
        return scanLedger(Buffer.alloc(0), maxLogBytes);
      }
      return err(trackerError("io", "internal", "Unable to read cron execution ledger"));
    }
    return scanLedger(read.value, maxLogBytes);
  }

  async function writeRows(rows: readonly CronExecutionRow[]): Promise<Result<void, ExecutionTrackerError>> {
    const buffers: Buffer[] = [];
    for (const row of rows) {
      const encoded = encodeCronExecutionRow(row);
      if (!encoded.ok) return err(trackerError("invalid_state", "validation", encoded.error.message));
      buffers.push(encoded.value);
    }
    const output = Buffer.concat(buffers);
    if (output.byteLength > maxLogBytes) {
      return err(trackerError("capacity", "resource", "Cron execution ledger byte capacity reached"));
    }
    const replaced = await replaceDurableFile({
      filePath: options.logPath,
      bytes: output,
      temporaryToken: options.idFactory,
    });
    if (replaced.ok) return replaced;
    return replaced.error.code === "invalid_input"
      ? err(trackerError("invalid_state", replaced.error.errorKind, "Opaque id factory returned an invalid temporary-file token"))
      : err(trackerError("io", replaced.error.errorKind, "Unable to durably replace cron execution ledger"));
  }

  return {
    initialize,
    appendRecoveredExecution,
    appendStart,
    appendTerminal,
    readExecution,
    listHistory,
    listOwnershipGroups,
    prune,
  };
}

function scanLedger(raw: Buffer, maxLogBytes: number): Result<LedgerScan, ExecutionTrackerError> {
  const digest = createHash("sha256").update(raw).digest("hex");
  if (raw.byteLength > maxLogBytes) {
    return err(corruption("Cron execution ledger exceeds its byte ceiling", undefined, digest));
  }
  if (raw.byteLength === 0) return ok({ raw, rows: [], groups: new Map(), digest });
  if (raw.at(-1) !== 0x0a) {
    return err(corruption("Cron execution ledger is not newline terminated", undefined, digest));
  }
  const lines = raw.toString("utf8").split("\n");
  lines.pop();
  const rows: CronExecutionRow[] = [];
  const groups = new Map<string, CronExecutionGroup>();
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (line.length === 0 || Buffer.byteLength(line, "utf8") + 1 > MAX_CRON_TERMINAL_ROW_BYTES) {
      return err(corruption("Cron execution ledger contains an empty or oversized row", lineNumber, digest));
    }
    const decoded = tryCatch(() => JSON.parse(line) as unknown);
    if (!decoded.ok) return err(corruption("Cron execution ledger contains invalid JSON", lineNumber, digest));
    const parsed = CronExecutionRowSchema.safeParse(decoded.value);
    if (!parsed.success) return err(corruption("Cron execution ledger contains an invalid row", lineNumber, digest));
    const row = parsed.data;
    const existing = groups.get(row.executionId);
    if (row.recordType === "started") {
      if (existing !== undefined) return err(corruption("Cron execution ledger contains a duplicate start", lineNumber, digest));
      groups.set(row.executionId, { start: row });
    } else {
      if (existing === undefined) return err(corruption("Cron execution terminal has no start", lineNumber, digest));
      if (existing.terminal !== undefined) return err(corruption("Cron execution ledger contains a duplicate terminal", lineNumber, digest));
      const pairError = validatePair(existing.start, row, lineNumber, digest);
      if (pairError !== undefined) return err(pairError);
      existing.terminal = row;
    }
    rows.push(row);
  }
  const reserved = logicalBytes(rows);
  if (!reserved.ok || reserved.value > maxLogBytes) {
    return err(corruption("Cron execution ledger cannot honor unmatched terminal reservations", undefined, digest));
  }
  return ok({ raw, rows, groups, digest });
}

function pruneRows(
  input: readonly CronExecutionRow[],
  protectedIds: ReadonlySet<string>,
  retainedExecutions: number,
  maxLogBytes: number,
): Result<CronExecutionRow[], ExecutionTrackerError> {
  let rows = [...input];
  const complete = completeGroups(rows);
  while (complete.length > retainedExecutions) {
    const candidate = complete.find((group) => !protectedIds.has(group.start.executionId));
    if (candidate === undefined) break;
    rows = rows.filter((row) => row.executionId !== candidate.start.executionId);
    complete.splice(complete.indexOf(candidate), 1);
  }
  let size = logicalBytes(rows);
  if (!size.ok) return size;
  while (size.value > maxLogBytes) {
    const candidates = completeGroups(rows);
    const candidate = candidates.find((group) => !protectedIds.has(group.start.executionId));
    if (candidate === undefined) {
      return err(trackerError("capacity", "resource", "Cron execution ledger has no safely prunable capacity"));
    }
    rows = rows.filter((row) => row.executionId !== candidate.start.executionId);
    size = logicalBytes(rows);
    if (!size.ok) return size;
  }
  return ok(rows);
}

function logicalBytes(rows: readonly CronExecutionRow[]): Result<number, ExecutionTrackerError> {
  let bytes = 0;
  const starts = new Set<string>();
  const terminals = new Set<string>();
  for (const row of rows) {
    const encoded = encodeCronExecutionRow(row);
    if (!encoded.ok) return err(trackerError("invalid_state", "validation", encoded.error.message));
    bytes += encoded.value.byteLength;
    if (!Number.isSafeInteger(bytes)) return err(trackerError("capacity", "resource", "Cron execution ledger byte count overflow"));
    if (row.recordType === "started") starts.add(row.executionId);
    else terminals.add(row.executionId);
  }
  for (const executionId of starts) {
    if (!terminals.has(executionId)) bytes += MAX_CRON_TERMINAL_ROW_BYTES;
    if (!Number.isSafeInteger(bytes)) return err(trackerError("capacity", "resource", "Cron execution reservation overflow"));
  }
  return ok(bytes);
}

function completeGroups(rows: readonly CronExecutionRow[]): CronExecutionGroup[] {
  const groups = new Map<string, CronExecutionGroup>();
  for (const row of rows) {
    if (row.recordType === "started") groups.set(row.executionId, { start: row });
    else {
      const group = groups.get(row.executionId);
      if (group !== undefined) group.terminal = row;
    }
  }
  return [...groups.values()]
    .filter((group): group is CronExecutionGroup & { terminal: CronExecutionTerminalRow } => group.terminal !== undefined)
    .sort((left, right) => left.terminal.terminalAtMs - right.terminal.terminalAtMs);
}

function validatePair(
  start: CronExecutionStartedRow,
  terminal: CronExecutionTerminalRow,
  line?: number,
  digest?: string,
): ExecutionTrackerError | undefined {
  if (
    start.executionId !== terminal.executionId
    || start.bootId !== terminal.bootId
    || start.jobId !== terminal.jobId
    || start.agentId !== terminal.agentId
    || start.scheduledForMs !== terminal.scheduledForMs
    || start.trigger !== terminal.trigger
    || start.workKind !== terminal.workKind
  ) {
    return corruption("Cron execution start and terminal identities differ", line, digest);
  }
  const outcomeRoot = terminalOutcomeRoot(terminal);
  if (outcomeRoot !== undefined && outcomeRoot !== start.rootRunId) {
    return corruption("Cron execution start and terminal roots differ", line, digest);
  }
  return undefined;
}

function terminalOutcomeRoot(row: CronExecutionTerminalRow): string | null | undefined {
  switch (row.outcome.kind) {
    case "agent_turn":
    case "wake_gate_skip":
    case "agent_turn_pre_model_skip":
    case "internal_action":
    case "unsettled": return row.outcome.rootRunId;
    case "heartbeat_event":
    case "delivery_only":
    case "pre_dispatch_failure": return undefined;
    default: {
      const _exhaustive: never = row.outcome;
      return _exhaustive;
    }
  }
}

function validateOptions(
  options: ExecutionTrackerOptions,
  maxLogBytes: number,
  retainedExecutions: number,
): ExecutionTrackerError | undefined {
  if (!path.isAbsolute(options.logPath) || !path.isAbsolute(options.lockPath)) {
    return trackerError("invalid_path", "validation", "Cron execution ledger and lock paths must be absolute");
  }
  if (!Number.isSafeInteger(maxLogBytes) || maxLogBytes <= 0 || maxLogBytes > MAX_EXECUTION_LOG_BYTES) {
    return trackerError("invalid_state", "validation", "Cron execution ledger byte capacity is invalid");
  }
  if (!Number.isSafeInteger(retainedExecutions) || retainedExecutions <= 0 || retainedExecutions > 100_000) {
    return trackerError("invalid_state", "validation", "Cron execution retention count is invalid");
  }
  return undefined;
}

function groupTime(group: CronExecutionGroup): number {
  return group.terminal?.terminalAtMs ?? group.start.startedAtMs;
}

function cloneGroup(group: CronExecutionGroup | undefined): CronExecutionGroup | undefined {
  return group === undefined ? undefined : structuredClone(group);
}

function sameRows(left: readonly CronExecutionRow[], right: readonly CronExecutionRow[]): boolean {
  return left.length === right.length && left.every((row, index) => row === right[index]);
}

function corruption(message: string, line?: number, fileDigest?: string): ExecutionTrackerError {
  return {
    code: "invalid_state",
    errorKind: "validation",
    message,
    ...(line === undefined ? {} : { line }),
    ...(fileDigest === undefined ? {} : { fileDigest }),
  };
}

function trackerError(code: ExecutionTrackerErrorCode, errorKind: ErrorKind, message: string): ExecutionTrackerError {
  return { code, errorKind, message };
}

function lockError(kind: "locked" | "error", message: string): ExecutionTrackerError {
  return kind === "locked"
    ? trackerError("lock_contended", "resource", message)
    : trackerError("lock_failed", "internal", message);
}

function validIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 256 && Buffer.byteLength(value, "utf8") <= 256;
}

function isNodeError(error: Error, code: string): boolean {
  return "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function createMutex() {
  let tail = Promise.resolve();
  return {
    serialize<T>(operation: () => Promise<T>): Promise<T> {
      const current = tail.then(operation, operation);
      tail = current.then(() => undefined, () => undefined);
      return current;
    },
  };
}
