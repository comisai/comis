// SPDX-License-Identifier: Apache-2.0
import { spawn, type SpawnOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

export interface BinarySshEndpoint {
  readonly host: string;
  readonly port?: number;
  readonly args: readonly string[];
}

interface ProductionBinaryTransferBaseRequest {
  readonly label: string;
  readonly source: BinarySshEndpoint;
  readonly target: BinarySshEndpoint;
  readonly timeoutMs?: number;
}

export type ProductionBinaryTransferRequest = ProductionBinaryTransferBaseRequest &
  (
    | { readonly expectedBytes: number; readonly maximumBytes?: never }
    | { readonly maximumBytes: number; readonly expectedBytes?: never }
  );

export interface ProductionBinaryTransferReport {
  readonly bytesTransferred: number;
}

export type ProductionBinaryTransferError =
  | { readonly kind: "invalid_request"; readonly message: string }
  | { readonly kind: "remote_failure"; readonly message: string }
  | { readonly kind: "byte_mismatch"; readonly message: string }
  | { readonly kind: "limit_exceeded"; readonly message: string };

export interface BinaryChildProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly kill: (signal?: NodeJS.Signals | number) => boolean;
  readonly once: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => BinaryChildProcess;
}

export interface ProductionBinarySshBridgeDeps {
  readonly spawnProcess: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => BinaryChildProcess;
  readonly setTimer?: (handler: () => void, timeoutMs: number) => NodeJS.Timeout;
  readonly clearTimer?: (timer: NodeJS.Timeout) => void;
  readonly terminationGraceMs?: number;
}

export interface ProductionBinarySshBridge {
  readonly transfer: (
    request: ProductionBinaryTransferRequest,
  ) => Promise<Result<ProductionBinaryTransferReport, ProductionBinaryTransferError>>;
}

const setDefaultTimer = (handler: () => void, timeoutMs: number): NodeJS.Timeout =>
  globalThis.setTimeout(handler, timeoutMs);
const clearDefaultTimer = (timer: NodeJS.Timeout): void => globalThis.clearTimeout(timer);

const DEFAULT_DEPS: ProductionBinarySshBridgeDeps = {
  spawnProcess: (command, args, options) =>
    spawn(command, [...args], options) as unknown as BinaryChildProcess,
  setTimer: setDefaultTimer,
  clearTimer: clearDefaultTimer,
};

const DEFAULT_OPERATION_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
const MAX_OPERATION_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const MAX_TERMINATION_GRACE_MS = 30_000;

export function buildBinarySshArgs(endpoint: BinarySshEndpoint): readonly string[] {
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
    ...endpoint.args,
  ];
}

interface ExitObservation {
  readonly result: Promise<number>;
}

function observeExit(child: BinaryChildProcess): ExitObservation {
  return {
    result: new Promise((resolve) => {
      let settled = false;
      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        resolve(code);
      };
      child.once("error", () => finish(-1));
      child.once("close", (code) => finish(typeof code === "number" ? code : -1));
    }),
  };
}

export function resolveBinarySshOperationTimeout(
  timeoutMs: number | undefined,
): number | null {
  const resolved = timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_OPERATION_TIMEOUT_MS
  ) {
    return null;
  }
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

function teardown(child: BinaryChildProcess): void {
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}

function signal(child: BinaryChildProcess, value: NodeJS.Signals): void {
  tryCatch(() => child.kill(value));
}

async function stopChildren(
  children: readonly BinaryChildProcess[],
  exits: readonly ExitObservation[],
  deps: ProductionBinarySshBridgeDeps,
): Promise<void> {
  const setTimer = deps.setTimer ?? setDefaultTimer;
  const clearTimer = deps.clearTimer ?? clearDefaultTimer;
  const graceMs = resolveTerminationGraceMs(deps.terminationGraceMs);
  for (const child of children) teardown(child);
  for (const child of children) signal(child, "SIGTERM");

  let graceTimer: NodeJS.Timeout | undefined;
  const graceExpired = new Promise<"grace">((resolve) => {
    graceTimer = setTimer(() => resolve("grace"), graceMs);
  });
  const exitResult = Promise.all(exits.map((exit) => exit.result)).then(() => "exited" as const);
  const stopped = await Promise.race([exitResult, graceExpired]);
  if (graceTimer !== undefined) clearTimer(graceTimer);
  if (stopped === "grace") {
    for (const child of children) signal(child, "SIGKILL");
  }
}

function remoteFailure(label: string): Result<never, ProductionBinaryTransferError> {
  return err({
    kind: "remote_failure",
    message: `Binary SSH stage ${label} exited unsuccessfully`,
  });
}

function createBridge(
  deps: ProductionBinarySshBridgeDeps,
): ProductionBinarySshBridge {
  return {
    async transfer(request) {
      const exactBytes = request.expectedBytes;
      const byteLimit = exactBytes ?? request.maximumBytes;
      const operationTimeoutMs = resolveBinarySshOperationTimeout(request.timeoutMs);
      if (
        request.label.length === 0 ||
        !Number.isSafeInteger(byteLimit) ||
        byteLimit < 0 ||
        operationTimeoutMs === null
      ) {
        return err({
          kind: "invalid_request",
          message: "Binary SSH transfer request is invalid",
        });
      }

      const targetResult = tryCatch(() =>
        deps.spawnProcess("ssh", buildBinarySshArgs(request.target), {
          stdio: ["pipe", "ignore", "pipe"],
          shell: false,
        }),
      );
      if (!targetResult.ok) return remoteFailure(request.label);
      const target = targetResult.value;
      const targetExit = observeExit(target);
      target.stderr.resume();

      const sourceResult = tryCatch(() =>
        deps.spawnProcess("ssh", buildBinarySshArgs(request.source), {
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        }),
      );
      if (!sourceResult.ok) {
        await stopChildren([target], [targetExit], deps);
        return remoteFailure(request.label);
      }
      const source = sourceResult.value;
      const sourceExit = observeExit(source);
      source.stderr.resume();

      const setTimer = deps.setTimer ?? setDefaultTimer;
      const clearTimer = deps.clearTimer ?? clearDefaultTimer;
      let deadlineTimer: NodeJS.Timeout | undefined;
      const deadline = new Promise<"deadline">((resolve) => {
        deadlineTimer = setTimer(() => resolve("deadline"), operationTimeoutMs);
      });
      const clearDeadline = (): void => {
        if (deadlineTimer === undefined) return;
        clearTimer(deadlineTimer);
        deadlineTimer = undefined;
      };

      let bytesTransferred = 0;
      let exceededExpectedBytes = false;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytesTransferred += chunk.length;
          if (bytesTransferred > byteLimit) {
            exceededExpectedBytes = true;
            callback(new Error("Binary SSH byte limit exceeded"));
            return;
          }
          callback(null, chunk);
        },
      });

      const transferPromise = fromPromise(pipeline(source.stdout, counter, target.stdin));
      const transferOrDeadline = await Promise.race([
        transferPromise.then((result) => ({ kind: "transfer" as const, result })),
        deadline.then(() => ({ kind: "deadline" as const })),
      ]);
      if (transferOrDeadline.kind === "deadline") {
        clearDeadline();
        await stopChildren([source, target], [sourceExit, targetExit], deps);
        return err({
          kind: "remote_failure",
          message: `Binary SSH stage ${request.label} exceeded its operation deadline`,
        });
      }

      const transfer = transferOrDeadline.result;
      if (!transfer.ok || exceededExpectedBytes) {
        clearDeadline();
        await stopChildren([source, target], [sourceExit, targetExit], deps);
      } else {
        const exitsOrDeadline = await Promise.race([
          Promise.all([sourceExit.result, targetExit.result]).then((codes) => ({
            kind: "exits" as const,
            codes,
          })),
          deadline.then(() => ({ kind: "deadline" as const })),
        ]);
        if (exitsOrDeadline.kind === "deadline") {
          clearDeadline();
          await stopChildren([source, target], [sourceExit, targetExit], deps);
          return err({
            kind: "remote_failure",
            message: `Binary SSH stage ${request.label} exceeded its operation deadline`,
          });
        }
        clearDeadline();
        const [sourceCode, targetCode] = exitsOrDeadline.codes;
        if (exactBytes !== undefined && bytesTransferred !== exactBytes) {
          return err({
            kind: "byte_mismatch",
            message: `Binary SSH stage ${request.label} transferred an unexpected byte count`,
          });
        }
        if (sourceCode !== 0 || targetCode !== 0) return remoteFailure(request.label);
        return ok({ bytesTransferred });
      }

      if (exceededExpectedBytes) {
        return err({
          kind: exactBytes === undefined ? "limit_exceeded" : "byte_mismatch",
          message:
            exactBytes === undefined
              ? `Binary SSH stage ${request.label} exceeded its byte limit`
              : `Binary SSH stage ${request.label} transferred an unexpected byte count`,
        });
      }
      if (exactBytes !== undefined && bytesTransferred !== exactBytes) {
        return err({
          kind: "byte_mismatch",
          message: `Binary SSH stage ${request.label} transferred an unexpected byte count`,
        });
      }
      return remoteFailure(request.label);
    },
  };
}

export function createProductionBinarySshBridge(
  deps: ProductionBinarySshBridgeDeps = DEFAULT_DEPS,
): ProductionBinarySshBridge {
  return createBridge(deps);
}
