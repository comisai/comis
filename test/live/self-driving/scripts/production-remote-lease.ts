// SPDX-License-Identifier: Apache-2.0
import { spawn, type SpawnOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { err, ok, tryCatch, type Result } from "@comis/shared";

const MAX_REMOTE_PROGRAM_BYTES = 256 * 1024;
const MAX_REMOTE_ARGUMENT_BYTES = 256 * 1024;
const MAX_REMOTE_ARGUMENT_COUNT = 256;
const MAX_READY_LINE_BYTES = 1_024;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const MAX_STARTUP_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_LEASE_TIMEOUT_MS = 6 * 60 * 60_000;
const MAX_LEASE_TIMEOUT_MS = 24 * 60 * 60_000;
const DEFAULT_RELEASE_TIMEOUT_MS = 30_000;
const MAX_RELEASE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const MAX_TERMINATION_GRACE_MS = 30_000;

export interface ProductionRemoteLeaseEndpoint {
  readonly host: string;
  readonly port?: number;
  readonly args: readonly string[];
}

export interface ProductionRemoteLeaseRequest extends ProductionRemoteLeaseEndpoint {
  readonly label: string;
  /** A bounded program streamed to the remote interpreter without a staging file. */
  readonly remoteProgram: string;
  /** The one newline-free line that proves the remote program holds the lease. */
  readonly readyLine: string;
  readonly startupTimeoutMs?: number;
  readonly leaseTimeoutMs?: number;
  readonly releaseTimeoutMs?: number;
}

export interface ProductionRemoteLeaseReleaseReport {
  readonly exitCode: 0;
}

export type ProductionRemoteLeaseError =
  | { readonly kind: "invalid_request"; readonly message: string }
  | { readonly kind: "remote_failure"; readonly message: string }
  | { readonly kind: "protocol_failure"; readonly message: string }
  | { readonly kind: "deadline"; readonly message: string };

export interface ProductionRemoteLease {
  readonly release: () => Promise<
    Result<ProductionRemoteLeaseReleaseReport, ProductionRemoteLeaseError>
  >;
}

export interface ProductionRemoteLeaseClient {
  readonly acquire: (
    request: ProductionRemoteLeaseRequest,
  ) => Promise<Result<ProductionRemoteLease, ProductionRemoteLeaseError>>;
}

export interface ProductionRemoteLeaseChildProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly kill: (signal?: NodeJS.Signals | number) => boolean;
  readonly on: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => ProductionRemoteLeaseChildProcess;
}

export interface ProductionRemoteLeaseDeps {
  readonly spawnProcess: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ProductionRemoteLeaseChildProcess;
  readonly setTimer?: (handler: () => void, timeoutMs: number) => NodeJS.Timeout;
  readonly clearTimer?: (timer: NodeJS.Timeout) => void;
  readonly terminationGraceMs?: number;
}

const setDefaultTimer = (handler: () => void, timeoutMs: number): NodeJS.Timeout =>
  globalThis.setTimeout(handler, timeoutMs);
const clearDefaultTimer = (timer: NodeJS.Timeout): void => globalThis.clearTimeout(timer);

const DEFAULT_DEPS: ProductionRemoteLeaseDeps = {
  spawnProcess: (command, args, options) =>
    spawn(command, [...args], options) as unknown as ProductionRemoteLeaseChildProcess,
  setTimer: setDefaultTimer,
  clearTimer: clearDefaultTimer,
};

function quoteSshRemoteArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildRemoteLeaseSshArgs(
  endpoint: ProductionRemoteLeaseEndpoint,
): readonly string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    ...(endpoint.port !== undefined ? ["-p", String(endpoint.port)] : []),
    "--",
    endpoint.host,
    ...endpoint.args.map(quoteSshRemoteArgument),
  ];
}

function resolveBoundedTimeout(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number | null {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) return null;
  return resolved;
}

function resolveTerminationGraceMs(value: number | undefined): number {
  if (
    value === undefined ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TERMINATION_GRACE_MS
  ) {
    return DEFAULT_TERMINATION_GRACE_MS;
  }
  return value;
}

interface ValidatedLeaseRequest {
  readonly startupTimeoutMs: number;
  readonly leaseTimeoutMs: number;
  readonly releaseTimeoutMs: number;
}

function validateRequest(
  request: ProductionRemoteLeaseRequest,
): ValidatedLeaseRequest | null {
  const startupTimeoutMs = resolveBoundedTimeout(
    request.startupTimeoutMs,
    DEFAULT_STARTUP_TIMEOUT_MS,
    MAX_STARTUP_TIMEOUT_MS,
  );
  const leaseTimeoutMs = resolveBoundedTimeout(
    request.leaseTimeoutMs,
    DEFAULT_LEASE_TIMEOUT_MS,
    MAX_LEASE_TIMEOUT_MS,
  );
  const releaseTimeoutMs = resolveBoundedTimeout(
    request.releaseTimeoutMs,
    DEFAULT_RELEASE_TIMEOUT_MS,
    MAX_RELEASE_TIMEOUT_MS,
  );
  const remoteArgumentBytes = request.args.reduce(
    (total, argument) => total + Buffer.byteLength(argument, "utf8"),
    0,
  );
  if (
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(request.label) ||
    request.host.length === 0 ||
    request.host.length > 1_024 ||
    /[\0\r\n]/u.test(request.host) ||
    (request.port !== undefined &&
      (!Number.isSafeInteger(request.port) || request.port < 1 || request.port > 65_535)) ||
    request.args.length === 0 ||
    request.args.length > MAX_REMOTE_ARGUMENT_COUNT ||
    request.args.some((argument) => argument.includes("\0")) ||
    remoteArgumentBytes > MAX_REMOTE_ARGUMENT_BYTES ||
    request.remoteProgram.length === 0 ||
    request.remoteProgram.includes("\0") ||
    !request.remoteProgram.endsWith("\n") ||
    Buffer.byteLength(request.remoteProgram, "utf8") > MAX_REMOTE_PROGRAM_BYTES ||
    request.readyLine.length === 0 ||
    /[\0\r\n]/u.test(request.readyLine) ||
    Buffer.byteLength(request.readyLine, "utf8") > MAX_READY_LINE_BYTES ||
    startupTimeoutMs === null ||
    leaseTimeoutMs === null ||
    releaseTimeoutMs === null
  ) {
    return null;
  }
  return { startupTimeoutMs, leaseTimeoutMs, releaseTimeoutMs };
}

function invalidRequest(): Result<never, ProductionRemoteLeaseError> {
  return err({ kind: "invalid_request", message: "Remote lease request is invalid" });
}

type LeaseReleaseResult = Result<
  ProductionRemoteLeaseReleaseReport,
  ProductionRemoteLeaseError
>;

type LeaseState = "starting" | "ready" | "releasing" | "terminating" | "closed";

function acquireLease(
  request: ProductionRemoteLeaseRequest,
  deps: ProductionRemoteLeaseDeps,
): Promise<Result<ProductionRemoteLease, ProductionRemoteLeaseError>> {
  const validated = validateRequest(request);
  if (validated === null) return Promise.resolve(invalidRequest());

  const childResult = tryCatch(() =>
    deps.spawnProcess("ssh", buildRemoteLeaseSshArgs(request), {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    }),
  );
  if (!childResult.ok) {
    return Promise.resolve(
      err({
        kind: "remote_failure",
        message: `Remote lease ${request.label} could not start`,
      }),
    );
  }

  const child = childResult.value;
  const setTimer = deps.setTimer ?? setDefaultTimer;
  const clearTimer = deps.clearTimer ?? clearDefaultTimer;
  const terminationGraceMs = resolveTerminationGraceMs(deps.terminationGraceMs);

  return new Promise((resolveAcquire) => {
    let state: LeaseState = "starting";
    let readinessBuffer = "";
    let readinessBytes = 0;
    let acquireSettled = false;
    let terminalResult: LeaseReleaseResult | undefined;
    let terminationResult: LeaseReleaseResult | undefined;
    let releasePromise: Promise<LeaseReleaseResult> | undefined;
    let resolveRelease: ((result: LeaseReleaseResult) => void) | undefined;
    let startupTimer: NodeJS.Timeout | undefined;
    let leaseTimer: NodeJS.Timeout | undefined;
    let releaseTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const clearTrackedTimer = (
      timer: NodeJS.Timeout | undefined,
    ): undefined => {
      if (timer !== undefined) clearTimer(timer);
      return undefined;
    };

    const clearAllTimers = (): void => {
      startupTimer = clearTrackedTimer(startupTimer);
      leaseTimer = clearTrackedTimer(leaseTimer);
      releaseTimer = clearTrackedTimer(releaseTimer);
      forceKillTimer = clearTrackedTimer(forceKillTimer);
    };

    const teardown = (): void => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };

    const signal = (value: NodeJS.Signals): void => {
      tryCatch(() => child.kill(value));
    };

    const settleAcquire = (
      result: Result<ProductionRemoteLease, ProductionRemoteLeaseError>,
    ): void => {
      if (acquireSettled) return;
      acquireSettled = true;
      resolveAcquire(result);
    };

    const finish = (result: LeaseReleaseResult): void => {
      if (terminalResult !== undefined) return;
      terminalResult = result;
      state = "closed";
      clearAllTimers();
      teardown();
      if (!acquireSettled && !result.ok) settleAcquire(err(result.error));
      resolveRelease?.(result);
    };

    const beginTermination = (result: LeaseReleaseResult): void => {
      if (terminalResult !== undefined || state === "terminating") return;
      state = "terminating";
      terminationResult = result;
      startupTimer = clearTrackedTimer(startupTimer);
      leaseTimer = clearTrackedTimer(leaseTimer);
      releaseTimer = clearTrackedTimer(releaseTimer);
      forceKillTimer = setTimer(() => {
        forceKillTimer = undefined;
        signal("SIGKILL");
        finish(result);
      }, terminationGraceMs);
      signal("SIGTERM");
      teardown();
    };

    const release = (): Promise<LeaseReleaseResult> => {
      if (releasePromise !== undefined) return releasePromise;
      if (terminalResult !== undefined) {
        releasePromise = Promise.resolve(terminalResult);
        return releasePromise;
      }
      releasePromise = new Promise((resolve) => {
        resolveRelease = resolve;
      });
      if (state === "terminating" && terminationResult !== undefined) {
        return releasePromise;
      }
      state = "releasing";
      leaseTimer = clearTrackedTimer(leaseTimer);
      releaseTimer = setTimer(() => {
        releaseTimer = undefined;
        beginTermination(
          err({
            kind: "deadline",
            message: `Remote lease ${request.label} exceeded its release deadline`,
          }),
        );
      }, validated.releaseTimeoutMs);
      const endResult = tryCatch(() => child.stdin.end());
      if (!endResult.ok) {
        beginTermination(
          err({
            kind: "remote_failure",
            message: `Remote lease ${request.label} could not release`,
          }),
        );
      }
      return releasePromise;
    };

    const lease: ProductionRemoteLease = { release };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (rawChunk: unknown) => {
      if (state === "terminating" || state === "closed") return;
      if (state !== "starting" || typeof rawChunk !== "string") {
        beginTermination(
          err({
            kind: "protocol_failure",
            message: `Remote lease ${request.label} returned an invalid readiness response`,
          }),
        );
        return;
      }
      readinessBytes += Buffer.byteLength(rawChunk, "utf8");
      readinessBuffer += rawChunk;
      const expectedResponse = `${request.readyLine}\n`;
      if (
        readinessBytes > MAX_READY_LINE_BYTES + 1 ||
        !expectedResponse.startsWith(readinessBuffer)
      ) {
        beginTermination(
          err({
            kind: "protocol_failure",
            message: `Remote lease ${request.label} returned an invalid readiness response`,
          }),
        );
        return;
      }
      if (readinessBuffer !== expectedResponse) return;

      state = "ready";
      startupTimer = clearTrackedTimer(startupTimer);
      readinessBuffer = "";
      leaseTimer = setTimer(() => {
        leaseTimer = undefined;
        beginTermination(
          err({
            kind: "deadline",
            message: `Remote lease ${request.label} exceeded its lease deadline`,
          }),
        );
      }, validated.leaseTimeoutMs);
      settleAcquire(ok(lease));
    });
    child.stdout.on("error", () => {
      beginTermination(
        err({
          kind: "remote_failure",
          message: `Remote lease ${request.label} could not execute`,
        }),
      );
    });
    child.stderr.on("error", () => {
      beginTermination(
        err({
          kind: "remote_failure",
          message: `Remote lease ${request.label} could not execute`,
        }),
      );
    });
    child.stderr.resume();
    child.stdin.on("error", () => {
      beginTermination(
        err({
          kind: "remote_failure",
          message: `Remote lease ${request.label} could not execute`,
        }),
      );
    });
    child.on("error", () => {
      if (state === "terminating" && terminationResult !== undefined) {
        finish(terminationResult);
        return;
      }
      finish(
        err({
          kind: "remote_failure",
          message: `Remote lease ${request.label} could not execute`,
        }),
      );
    });
    child.on("close", (rawCode: unknown) => {
      if (terminalResult !== undefined) return;
      if (state === "terminating" && terminationResult !== undefined) {
        finish(terminationResult);
        return;
      }
      const exitCode = typeof rawCode === "number" ? rawCode : -1;
      if (state === "releasing") {
        finish(
          exitCode === 0
            ? ok({ exitCode: 0 })
            : err({
                kind: "remote_failure",
                message: `Remote lease ${request.label} exited unsuccessfully`,
              }),
        );
        return;
      }
      finish(
        err({
          kind: "remote_failure",
          message:
            state === "ready"
              ? `Remote lease ${request.label} exited before release`
              : `Remote lease ${request.label} exited before readiness`,
        }),
      );
    });

    startupTimer = setTimer(() => {
      startupTimer = undefined;
      beginTermination(
        err({
          kind: "deadline",
          message: `Remote lease ${request.label} exceeded its startup deadline`,
        }),
      );
    }, validated.startupTimeoutMs);
    const writeResult = tryCatch(() => child.stdin.write(request.remoteProgram, "utf8"));
    if (!writeResult.ok) {
      beginTermination(
        err({
          kind: "remote_failure",
          message: `Remote lease ${request.label} could not execute`,
        }),
      );
    }
  });
}

export function createProductionRemoteLeaseClient(
  deps: ProductionRemoteLeaseDeps = DEFAULT_DEPS,
): ProductionRemoteLeaseClient {
  return { acquire: (request) => acquireLease(request, deps) };
}
