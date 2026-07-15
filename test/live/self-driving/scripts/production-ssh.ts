// SPDX-License-Identifier: Apache-2.0
import { spawn, type SpawnOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { err, ok, tryCatch, type Result } from "@comis/shared";

import type {
  ProductionRemoteError,
  ProductionRemoteExecutor,
  ProductionRemoteInvocation,
  ProductionRemoteResult,
} from "./production-bootstrap.js";

const DEFAULT_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_OPERATION_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
const MAX_OPERATION_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const MAX_TERMINATION_GRACE_MS = 30_000;

export interface ProductionSshChildProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly kill: (signal?: NodeJS.Signals | number) => boolean;
  readonly on: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => ProductionSshChildProcess;
}

export interface ProductionSshExecutorDeps {
  readonly spawnProcess: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ProductionSshChildProcess;
  readonly setTimer?: (handler: () => void, timeoutMs: number) => NodeJS.Timeout;
  readonly clearTimer?: (timer: NodeJS.Timeout) => void;
  readonly terminationGraceMs?: number;
}

const setDefaultTimer = (handler: () => void, timeoutMs: number): NodeJS.Timeout =>
  globalThis.setTimeout(handler, timeoutMs);
const clearDefaultTimer = (timer: NodeJS.Timeout): void => globalThis.clearTimeout(timer);

const DEFAULT_DEPS: ProductionSshExecutorDeps = {
  spawnProcess: (command, args, options) =>
    spawn(command, [...args], options) as unknown as ProductionSshChildProcess,
  setTimer: setDefaultTimer,
  clearTimer: clearDefaultTimer,
};

export function resolveSshStdoutLimit(
  invocation: ProductionRemoteInvocation,
): number | null {
  const limit = invocation.stdoutLimitBytes ?? DEFAULT_STDOUT_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_STDOUT_BYTES) return null;
  return limit;
}

export function resolveSshOperationTimeout(
  invocation: ProductionRemoteInvocation,
): number | null {
  const timeoutMs = invocation.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_OPERATION_TIMEOUT_MS
  ) {
    return null;
  }
  return timeoutMs;
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

export function buildSshProcessArgs(
  invocation: ProductionRemoteInvocation,
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
    ...(invocation.port !== undefined ? ["-p", String(invocation.port)] : []),
    "--",
    invocation.host,
    ...invocation.args,
  ];
}

function runSsh(
  invocation: ProductionRemoteInvocation,
  deps: ProductionSshExecutorDeps,
): Promise<Result<ProductionRemoteResult, ProductionRemoteError>> {
  const stdoutLimit = resolveSshStdoutLimit(invocation);
  if (stdoutLimit === null) {
    return Promise.resolve(
      err({ kind: "remote", message: `SSH stage ${invocation.label} has an invalid output limit` }),
    );
  }
  const operationTimeoutMs = resolveSshOperationTimeout(invocation);
  if (operationTimeoutMs === null) {
    return Promise.resolve(
      err({
        kind: "remote",
        message: `SSH stage ${invocation.label} has an invalid operation deadline`,
      }),
    );
  }
  const childResult = tryCatch(() =>
    deps.spawnProcess("ssh", buildSshProcessArgs(invocation), {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    }),
  );
  if (!childResult.ok) {
    return Promise.resolve(
      err({ kind: "remote", message: `Unable to start SSH stage ${invocation.label}` }),
    );
  }
  const child = childResult.value;
  return new Promise((resolve) => {
    const setTimer = deps.setTimer ?? setDefaultTimer;
    const clearTimer = deps.clearTimer ?? clearDefaultTimer;
    const terminationGraceMs = resolveTerminationGraceMs(deps.terminationGraceMs);
    let stdout = "";
    let stdoutBytes = 0;
    let settled = false;
    let terminating = false;
    let terminationResult: Result<ProductionRemoteResult, ProductionRemoteError> | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const finish = (result: Result<ProductionRemoteResult, ProductionRemoteError>): void => {
      if (settled) return;
      settled = true;
      if (deadlineTimer !== undefined) clearTimer(deadlineTimer);
      if (forceKillTimer !== undefined) clearTimer(forceKillTimer);
      resolve(result);
    };

    const teardownStreams = (): void => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };

    const signal = (value: NodeJS.Signals): void => {
      tryCatch(() => child.kill(value));
    };

    const terminate = (
      result: Result<ProductionRemoteResult, ProductionRemoteError>,
    ): void => {
      if (settled || terminating) return;
      terminating = true;
      terminationResult = result;
      if (deadlineTimer !== undefined) {
        clearTimer(deadlineTimer);
        deadlineTimer = undefined;
      }
      forceKillTimer = setTimer(() => {
        forceKillTimer = undefined;
        signal("SIGKILL");
        finish(result);
      }, terminationGraceMs);
      signal("SIGTERM");
      teardownStreams();
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (terminating || settled) return;
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > stdoutLimit) {
        terminate(
          err({ kind: "remote", message: `SSH stage ${invocation.label} exceeded output limit` }),
        );
        return;
      }
      stdout += chunk;
    });
    child.stderr.resume();
    child.on("error", () => {
      teardownStreams();
      if (terminating && terminationResult !== undefined) {
        finish(terminationResult);
        return;
      }
      finish(err({ kind: "remote", message: `SSH stage ${invocation.label} could not execute` }));
    });
    child.on("close", (rawCode) => {
      if (terminating && terminationResult !== undefined) {
        finish(terminationResult);
        return;
      }
      const exitCode = typeof rawCode === "number" ? rawCode : -1;
      if (exitCode !== 0) {
        finish(
          err({
            kind: "remote",
            message: `SSH stage ${invocation.label} exited unsuccessfully`,
          }),
        );
        return;
      }
      finish(ok({ stdout, exitCode }));
    });
    child.stdin.on("error", () => {
      terminate(err({ kind: "remote", message: `SSH stage ${invocation.label} could not execute` }));
    });
    deadlineTimer = setTimer(() => {
      deadlineTimer = undefined;
      terminate(
        err({
          kind: "remote",
          message: `SSH stage ${invocation.label} exceeded its operation deadline`,
        }),
      );
    }, operationTimeoutMs);
    const stdinResult = tryCatch(() => child.stdin.end(invocation.stdin));
    if (!stdinResult.ok) {
      terminate(err({ kind: "remote", message: `SSH stage ${invocation.label} could not execute` }));
    }
  });
}

export function createProductionSshExecutor(
  deps: ProductionSshExecutorDeps = DEFAULT_DEPS,
): ProductionRemoteExecutor {
  return { run: (invocation) => runSsh(invocation, deps) };
}
