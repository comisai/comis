// SPDX-License-Identifier: Apache-2.0
/**
 * Application-level replay quarantine.
 *
 * This module is deliberately independent of the normal daemon bootstrap. It
 * may read and attest a cloned data tree, register two close-only signal
 * handlers, and write structured lifecycle records to stderr. It does not
 * construct stores, adapters, schedulers, listeners, child processes, or
 * network clients.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { safePath, type ClockPort, type EnvPort } from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

const REPLAY_FLAG = "COMIS_REPLAY_TARGET";
const REPLAY_RUNTIME_DIR = "COMIS_REPLAY_RUNTIME_DIR";
const DATA_DIR = "COMIS_DATA_DIR";
const DEFAULT_REPLAY_RUNTIME_DIR = "/run/comis-replay";
const DEFAULT_ENVIRONMENT_ROLE_PATH = "/etc/comis/environment-role";
const DEFAULT_RESTORE_ATTESTATION_PATH = "/etc/comis/replay-restore-attestation.json";
const DATA_DIR_DIGEST_DOMAIN = "comis-replay-data-dir-v1\0";
const SHA256_RE = /^[a-f0-9]{64}$/u;

type ReplayRootField = "cloneRoot" | "runtimeRoot";

export type ReplayBootIntent =
  | { readonly kind: "live" }
  | {
      readonly kind: "replay_quarantine";
      readonly cloneRoot: string;
      readonly runtimeRoot: string;
    };

export type ReplayBootError =
  | {
      readonly kind:
        | "environment_role_unavailable"
        | "environment_role_untrusted"
        | "invalid_environment_role";
      readonly message: string;
    }
  | {
      readonly kind: "replay_required_on_test" | "replay_forbidden_on_production";
      readonly message: string;
    }
  | {
      readonly kind: "invalid_replay_flag";
      readonly message: string;
    }
  | {
      readonly kind: "invalid_replay_root";
      readonly field: ReplayRootField;
      readonly message: string;
    }
  | {
      readonly kind: "replay_root_unavailable";
      readonly field: ReplayRootField;
      readonly message: string;
    }
  | {
      readonly kind: "replay_root_symlink";
      readonly field: ReplayRootField;
      readonly message: string;
    }
  | {
      readonly kind: "replay_root_not_directory";
      readonly field: ReplayRootField;
      readonly message: string;
    }
  | {
      readonly kind: "overlapping_replay_roots";
      readonly message: string;
    }
  | {
      readonly kind: "restore_forbidden_in_replay";
      readonly message: string;
    };

export type ReplayAttestationError =
  | {
      readonly kind: "restore_attestation_unavailable";
      readonly message: string;
    }
  | {
      readonly kind: "restore_attestation_untrusted";
      readonly message: string;
    }
  | {
      readonly kind: "invalid_restore_attestation";
      readonly message: string;
    }
  | {
      readonly kind: "restore_attestation_mismatch";
      readonly message: string;
    }
  | {
      readonly kind: "signal_lifecycle_unavailable";
      readonly message: string;
    };

export interface ReplayRestoreAttestation {
  readonly schemaVersion: 1;
  readonly state: "committed";
  readonly dataDirSha256: string;
  readonly snapshotManifestSha256: string;
  readonly restoredTreeDigestSha256: string;
  readonly entryCount: number;
  readonly bytes: number;
}

export type ComisEnvironmentRole = "production" | "test";

export interface ReplayEnvironmentRolePort {
  read(): Promise<Result<ComisEnvironmentRole, ReplayBootError>>;
}

export interface ReplayRestoreAttestationPort {
  read(): Promise<Result<ReplayRestoreAttestation, ReplayAttestationError>>;
}

export interface ReplaySignalPort {
  on(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
  off(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
}

export interface ReplayQuarantineLogPort {
  info(fields: Record<string, unknown>, message: string): void;
  error(
    fields: Record<string, unknown> & {
      readonly hint: string;
      readonly errorKind: "validation" | "precondition" | "internal";
    },
    message: string,
  ): void;
}

export interface ReplayQuarantineShutdownHandle {
  readonly isShuttingDown: boolean;
  trigger(): Promise<void>;
  dispose(): void;
}

export interface ReplayQuarantineRuntime {
  readonly kind: "replay_quarantine";
  readonly attestation: ReplayRestoreAttestation;
  readonly shutdownHandle: ReplayQuarantineShutdownHandle;
  readonly closed: Promise<void>;
}

export interface ReplayQuarantineDeps {
  readonly clock: ClockPort;
  readonly signals: ReplaySignalPort;
  readonly logger: ReplayQuarantineLogPort;
  readonly restoreAttestation: ReplayRestoreAttestationPort;
}

export type DaemonEntrypointAction =
  | { readonly kind: "start"; readonly intent: ReplayBootIntent }
  | { readonly kind: "restore_last_good" };

function replayBootError(
  kind:
    | "invalid_replay_flag"
    | "overlapping_replay_roots"
    | "restore_forbidden_in_replay"
    | "replay_required_on_test"
    | "replay_forbidden_on_production",
  message: string,
): Result<never, ReplayBootError> {
  return err({ kind, message });
}

function invalidRoot(
  field: ReplayRootField,
  message: string,
): Result<never, ReplayBootError> {
  return err({ kind: "invalid_replay_root", field, message });
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

async function canonicalDirectory(
  rawPath: string,
  field: ReplayRootField,
): Promise<Result<string, ReplayBootError>> {
  if (
    rawPath === "" ||
    rawPath === "/" ||
    !isAbsolute(rawPath) ||
    hasControlCharacters(rawPath)
  ) {
    return invalidRoot(field, `${field} must be a safe absolute non-root directory`);
  }

  const normalizedPath = resolve(rawPath);
  // The replay roots come from a daemon-owned EnvPort and are validated above.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const linkStatus = await fromPromise(lstat(normalizedPath));
  if (!linkStatus.ok) {
    return err({
      kind: "replay_root_unavailable",
      field,
      message: `${field} is unavailable`,
    });
  }
  if (linkStatus.value.isSymbolicLink()) {
    return err({
      kind: "replay_root_symlink",
      field,
      message: `${field} must not be a symbolic link`,
    });
  }
  if (!linkStatus.value.isDirectory()) {
    return err({
      kind: "replay_root_not_directory",
      field,
      message: `${field} must be a directory`,
    });
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- validated absolute root; canonicalization is the purpose of this boundary.
  const canonical = await fromPromise(realpath(normalizedPath));
  if (!canonical.ok) {
    return err({
      kind: "replay_root_unavailable",
      field,
      message: `${field} cannot be canonicalized`,
    });
  }
  return ok(canonical.value);
}

function rootsOverlap(left: string, right: string): boolean {
  const rightFromLeft = relative(left, right);
  const leftFromRight = relative(right, left);
  const isContained = (value: string): boolean =>
    value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
  return isContained(rightFromLeft) || isContained(leftFromRight);
}

/** Resolve the process boot intent without touching clone state in live mode. */
export async function resolveDaemonBootIntent(
  env: EnvPort,
  environmentRole: ReplayEnvironmentRolePort,
): Promise<Result<ReplayBootIntent, ReplayBootError>> {
  const role = await environmentRole.read();
  if (!role.ok) return role;

  const flag = env.get(REPLAY_FLAG);
  if (role.value === "production") {
    if (flag !== undefined) {
      return replayBootError(
        "replay_forbidden_on_production",
        "Replay quarantine is forbidden on a production-role machine",
      );
    }
    return ok({ kind: "live" });
  }
  if (flag === undefined) {
    return replayBootError(
      "replay_required_on_test",
      "A test-role machine may start only in replay quarantine",
    );
  }
  if (flag !== "1") {
    return replayBootError(
      "invalid_replay_flag",
      "Replay target flag must be exactly 1 when present",
    );
  }

  const defaultCloneRoot = tryCatch(() => safePath(homedir(), ".comis"));
  if (!defaultCloneRoot.ok) {
    return invalidRoot("cloneRoot", "Default clone root cannot be resolved safely");
  }
  const rawCloneRoot = env.get(DATA_DIR) ?? defaultCloneRoot.value;
  const rawRuntimeRoot = env.get(REPLAY_RUNTIME_DIR) ?? DEFAULT_REPLAY_RUNTIME_DIR;
  const cloneRoot = await canonicalDirectory(rawCloneRoot, "cloneRoot");
  if (!cloneRoot.ok) return cloneRoot;
  const runtimeRoot = await canonicalDirectory(rawRuntimeRoot, "runtimeRoot");
  if (!runtimeRoot.ok) return runtimeRoot;
  if (rootsOverlap(cloneRoot.value, runtimeRoot.value)) {
    return replayBootError(
      "overlapping_replay_roots",
      "Replay clone and runtime roots must be canonical, distinct, and non-overlapping",
    );
  }
  return ok({
    kind: "replay_quarantine",
    cloneRoot: cloneRoot.value,
    runtimeRoot: runtimeRoot.value,
  });
}

/** Resolve CLI precedence before any last-known-good mutation can run. */
export function selectDaemonEntrypointAction(
  intent: ReplayBootIntent,
  restoreRequested: boolean,
): Result<DaemonEntrypointAction, ReplayBootError> {
  if (restoreRequested && intent.kind === "replay_quarantine") {
    return replayBootError(
      "restore_forbidden_in_replay",
      "Last-known-good restoration is forbidden while the target is quarantined",
    );
  }
  if (restoreRequested) return ok({ kind: "restore_last_good" });
  return ok({ kind: "start", intent });
}

interface TrustedRootFileError {
  readonly kind: "unavailable" | "untrusted";
  readonly message: string;
}

async function readTrustedRootFile(
  path: string,
  expectedMode: number,
  maximumBytes: number,
): Promise<Result<string, TrustedRootFileError>> {
  const parentPath = dirname(path);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed daemon trust-anchor path or an explicitly injected test path.
  const parentStatus = await fromPromise(lstat(parentPath));
  if (!parentStatus.ok) {
    return err({ kind: "unavailable", message: "Trusted marker parent is unavailable" });
  }
  if (
    parentStatus.value.isSymbolicLink() ||
    !parentStatus.value.isDirectory() ||
    parentStatus.value.uid !== 0 ||
    parentStatus.value.gid !== 0 ||
    (parentStatus.value.mode & 0o022) !== 0
  ) {
    return err({ kind: "untrusted", message: "Trusted marker parent is not root-controlled" });
  }

  // O_NOFOLLOW binds validation and reading to one opened inode. The file is
  // never reopened by path after this boundary.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed daemon trust-anchor path or an explicitly injected test path.
  const opened = await fromPromise(open(path, constants.O_RDONLY | constants.O_NOFOLLOW));
  if (!opened.ok) {
    return err({ kind: "unavailable", message: "Trusted marker is unavailable" });
  }
  const handle = opened.value;
  let readResult: Result<string, TrustedRootFileError> | undefined;
  let closeFailed: boolean | undefined;
  try {
    readResult = await (async (): Promise<Result<string, TrustedRootFileError>> => {
      const before = await fromPromise(handle.stat());
      if (!before.ok) {
        return err({ kind: "unavailable", message: "Trusted marker cannot be inspected" });
      }
      const status = before.value;
      if (
        !status.isFile() ||
        status.uid !== 0 ||
        status.gid !== 0 ||
        status.nlink !== 1 ||
        (status.mode & 0o7777) !== expectedMode ||
        status.size <= 0 ||
        status.size > maximumBytes
      ) {
        return err({ kind: "untrusted", message: "Trusted marker ownership or mode is invalid" });
      }
      const content = await fromPromise(handle.readFile({ encoding: "utf8" }));
      if (!content.ok) {
        return err({ kind: "unavailable", message: "Trusted marker cannot be read" });
      }
      const after = await fromPromise(handle.stat());
      if (
        !after.ok ||
        after.value.dev !== status.dev ||
        after.value.ino !== status.ino ||
        after.value.size !== status.size ||
        after.value.mtimeMs !== status.mtimeMs ||
        after.value.ctimeMs !== status.ctimeMs
      ) {
        return err({ kind: "untrusted", message: "Trusted marker changed while being read" });
      }
      return ok(content.value);
    })();
  } finally {
    closeFailed = !(await fromPromise(handle.close())).ok;
  }
  if (closeFailed !== false) {
    return err({ kind: "unavailable", message: "Trusted marker handle cannot be closed" });
  }
  if (readResult === undefined) {
    return err({ kind: "unavailable", message: "Trusted marker read did not complete" });
  }
  return readResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Parse the root-sealed, content-free restore attestation with no extra fields. */
export function parseReplayRestoreAttestation(
  raw: string,
): Result<ReplayRestoreAttestation, ReplayAttestationError> {
  const parsed = tryCatch((): unknown => JSON.parse(raw));
  if (!parsed.ok || !isRecord(parsed.value)) {
    return err({
      kind: "invalid_restore_attestation",
      message: "Replay restore attestation is not valid JSON",
    });
  }
  const value = parsed.value;
  const expectedKeys = [
    "bytes",
    "dataDirSha256",
    "entryCount",
    "restoredTreeDigestSha256",
    "schemaVersion",
    "snapshotManifestSha256",
    "state",
  ];
  if (Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")) {
    return err({
      kind: "invalid_restore_attestation",
      message: "Replay restore attestation has an invalid shape",
    });
  }
  if (
    value.schemaVersion !== 1 ||
    value.state !== "committed" ||
    typeof value.dataDirSha256 !== "string" ||
    !SHA256_RE.test(value.dataDirSha256) ||
    typeof value.snapshotManifestSha256 !== "string" ||
    !SHA256_RE.test(value.snapshotManifestSha256) ||
    typeof value.restoredTreeDigestSha256 !== "string" ||
    !SHA256_RE.test(value.restoredTreeDigestSha256) ||
    !isSafeCount(value.entryCount) ||
    !isSafeCount(value.bytes)
  ) {
    return err({
      kind: "invalid_restore_attestation",
      message: "Replay restore attestation fields are invalid",
    });
  }
  return ok({
    schemaVersion: 1,
    state: "committed",
    dataDirSha256: value.dataDirSha256,
    snapshotManifestSha256: value.snapshotManifestSha256,
    restoredTreeDigestSha256: value.restoredTreeDigestSha256,
    entryCount: value.entryCount,
    bytes: value.bytes,
  });
}

/** Bind a sealed restore record to the configured data-directory identity. */
export function replayDataDirSha256(path: string): string {
  return createHash("sha256").update(DATA_DIR_DIGEST_DOMAIN).update(path).digest("hex");
}

/** Read the machine role from its root-owned system trust anchor. */
export function createSystemEnvironmentRolePort(
  path = DEFAULT_ENVIRONMENT_ROLE_PATH,
): ReplayEnvironmentRolePort {
  return {
    read: async () => {
      const trusted = await readTrustedRootFile(path, 0o644, 32);
      if (!trusted.ok) {
        return err({
          kind:
            trusted.error.kind === "untrusted"
              ? "environment_role_untrusted"
              : "environment_role_unavailable",
          message: trusted.error.message,
        });
      }
      if (trusted.value === "production\n") return ok("production");
      if (trusted.value === "test\n") return ok("test");
      return err({
        kind: "invalid_environment_role",
        message: "Machine role marker has invalid content",
      });
    },
  };
}

/** Read the content-free restore attestation sealed by the root restore step. */
export function createSystemReplayRestoreAttestationPort(
  path = DEFAULT_RESTORE_ATTESTATION_PATH,
): ReplayRestoreAttestationPort {
  return {
    read: async () => {
      const trusted = await readTrustedRootFile(path, 0o444, 4096);
      if (!trusted.ok) {
        return err({
          kind:
            trusted.error.kind === "untrusted"
              ? "restore_attestation_untrusted"
              : "restore_attestation_unavailable",
          message: trusted.error.message,
        });
      }
      return parseReplayRestoreAttestation(trusted.value);
    },
  };
}

/** Start the read-only replay quarantine and its close-only signal lifecycle. */
export async function startReplayQuarantine(
  intent: Extract<ReplayBootIntent, { readonly kind: "replay_quarantine" }>,
  deps: ReplayQuarantineDeps,
): Promise<Result<ReplayQuarantineRuntime, ReplayAttestationError>> {
  const startedAt = deps.clock.now();
  const attestation = await deps.restoreAttestation.read();
  if (!attestation.ok) {
    deps.logger.error(
      {
        errorKind: "precondition",
        hint: "Repeat the root-owned restore seal step before starting replay quarantine",
        reason: attestation.error.kind,
      },
      "Replay target restore attestation failed",
    );
    return attestation;
  }
  if (attestation.value.dataDirSha256 !== replayDataDirSha256(intent.cloneRoot)) {
    const mismatch = err<ReplayAttestationError>({
      kind: "restore_attestation_mismatch",
      message: "Replay restore attestation does not match the configured data directory",
    });
    deps.logger.error(
      {
        errorKind: "precondition",
        hint: "Repeat restore and seal it for the configured replay data directory",
        reason: "restore_attestation_mismatch",
      },
      "Replay target restore attestation failed",
    );
    return mismatch;
  }

  let shuttingDown = false;
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolveClosedPromise) => {
    resolveClosed = resolveClosedPromise;
  });
  const signalHandler = (): void => {
    void shutdownHandle.trigger();
  };
  const removeSignalHandlers = (): void => {
    deps.signals.off("SIGINT", signalHandler);
    deps.signals.off("SIGTERM", signalHandler);
  };
  const shutdownHandle: ReplayQuarantineShutdownHandle = {
    get isShuttingDown() {
      return shuttingDown;
    },
    trigger: async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      removeSignalHandlers();
      deps.logger.info(
        { durationMs: deps.clock.now() - startedAt },
        "Replay target quarantine closed",
      );
      resolveClosed?.();
    },
    dispose: () => {
      if (shuttingDown) return;
      shuttingDown = true;
      removeSignalHandlers();
      resolveClosed?.();
    },
  };

  const registered = tryCatch(() => {
    deps.signals.on("SIGINT", signalHandler);
    deps.signals.on("SIGTERM", signalHandler);
  });
  if (!registered.ok) {
    removeSignalHandlers();
    deps.logger.error(
      {
        errorKind: "internal",
        hint: "Verify the daemon process can register SIGINT and SIGTERM handlers",
        reason: "signal_lifecycle_unavailable",
      },
      "Replay target quarantine signal lifecycle failed",
    );
    return err({
      kind: "signal_lifecycle_unavailable",
      message: "Unable to register replay quarantine signal handlers",
    });
  }

  deps.logger.info(
    {
      durationMs: deps.clock.now() - startedAt,
      entryCount: attestation.value.entryCount,
      bytes: attestation.value.bytes,
    },
    "Replay target quarantined",
  );
  return ok({
    kind: "replay_quarantine",
    attestation: attestation.value,
    shutdownHandle,
    closed,
  });
}

export function createProcessReplaySignalPort(): ReplaySignalPort {
  return {
    on: (signal, handler) => process.on(signal, handler),
    off: (signal, handler) => process.off(signal, handler),
  };
}

export function createStderrReplayQuarantineLogger(): ReplayQuarantineLogPort {
  const write = (
    level: "error" | "info",
    fields: Record<string, unknown>,
    message: string,
  ): void => {
    process.stderr.write(`${JSON.stringify({ level, ...fields, message })}\n`);
  };
  return {
    info: (fields, message) => write("info", fields, message),
    error: (fields, message) => write("error", fields, message),
  };
}

export function replayBootFailure(error: ReplayBootError | ReplayAttestationError): Error & {
  readonly replayBootFailure: true;
} {
  return Object.assign(new Error(`${error.kind}: ${error.message}`), {
    name: "ReplayBootFailure",
    replayBootFailure: true as const,
  });
}

export function reportReplayBootError(
  logger: ReplayQuarantineLogPort,
  error: ReplayBootError,
): void {
  const hint = (() => {
    switch (error.kind) {
      case "environment_role_unavailable":
      case "environment_role_untrusted":
      case "invalid_environment_role":
        return "Install a root-owned machine role marker with the exact production or test role";
      case "replay_forbidden_on_production":
        return "Remove replay intent from the production service environment";
      case "replay_required_on_test":
      case "invalid_replay_flag":
        return "Set exact replay intent on the test-role machine before startup";
      case "restore_forbidden_in_replay":
        return "Remove the restore option; last-known-good restore is permitted only on a production-role startup without replay intent";
      case "invalid_replay_root":
      case "replay_root_unavailable":
      case "replay_root_symlink":
      case "replay_root_not_directory":
      case "overlapping_replay_roots":
        return "Verify the replay clone and runtime roots are existing canonical non-overlapping directories";
      default: {
        const _exhaustive: never = error;
        return _exhaustive;
      }
    }
  })();
  logger.error(
    {
      errorKind:
        error.kind === "restore_forbidden_in_replay" ? "precondition" : "validation",
      hint,
      reason: error.kind,
    },
    "Replay target boot rejected",
  );
}

export function isReplayBootFailure(value: unknown): value is Error & {
  readonly replayBootFailure: true;
} {
  return (
    value instanceof Error &&
    (value as Error & { readonly replayBootFailure?: boolean }).replayBootFailure === true
  );
}
