// SPDX-License-Identifier: Apache-2.0
/**
 * Detached host-allowlist proxy launcher for a durable tmux terminal.
 *
 * The ordinary terminal worker is intentionally disposable. A durable bwrap/tmux
 * tree can outlive that worker, so its bound unix-socket server must outlive the
 * worker as well. This launcher starts the no-secret proxy in a detached helper;
 * the helper watches the owning tmux session and retires itself when that session
 * disappears. The allowlist contains no credentials and the helper inherits an
 * empty environment.
 */

import { spawn as childSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  safePath,
  systemClearTimeout,
  systemNowMs,
  systemSetTimeout,
  type EgressMaterialization,
  type EgressMaterializationContext,
  type SystemTimeoutHandle,
} from "@comis/core";
import { TERMINAL_PROCESS_ENTRIES } from "./terminal-process-entry-registry.js";

const READY_TIMEOUT_MS = 10_000;
const DISPOSE_TIMEOUT_MS = 5_000;
const STARTUP_GRACE_MS = 30_000;

export interface DurableProxyLivenessInput {
  readonly nowMs: number;
  readonly startedAtMs: number;
  readonly startupGraceMs: number;
  readonly observedTmuxAlive: boolean;
  readonly tmuxAlive: boolean;
}

export type DurableProxyLivenessDecision =
  | { readonly action: "retain"; readonly observedTmuxAlive: boolean }
  | { readonly action: "retire"; readonly reason: "tmux_session_gone" | "tmux_start_timeout" };

/** Pure lifetime decision used by the detached helper's liveness loop. */
export function durableProxyLivenessDecision(
  input: DurableProxyLivenessInput,
): DurableProxyLivenessDecision {
  if (input.tmuxAlive) return { action: "retain", observedTmuxAlive: true };
  if (input.observedTmuxAlive) return { action: "retire", reason: "tmux_session_gone" };
  return input.nowMs - input.startedAtMs >= input.startupGraceMs
    ? { action: "retire", reason: "tmux_start_timeout" }
    : { action: "retain", observedTmuxAlive: false };
}

interface DurableProxyChild extends Pick<ChildProcess, "once" | "on" | "removeListener" | "kill" | "unref"> {
  readonly stdout: NonNullable<ChildProcess["stdout"]>;
}

type SpawnProcess = (
  bin: string,
  args: string[],
  options: { detached: true; env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "ignore"] },
) => DurableProxyChild;

export type DurableEgressMaterializer = (
  hosts: string[],
  context: EgressMaterializationContext,
) => Promise<EgressMaterialization>;

interface DurableEgressLogger {
  debug(fields: Record<string, unknown>, message?: string): void;
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
}

export interface DurableEgressMaterializerDeps {
  readonly logger: DurableEgressLogger;
  readonly nodePath: string;
  readonly entryPath: string;
  readonly tmuxPath: string;
  readonly tmuxSocketForSession: (sessionId: string) => string;
  readonly tmuxNameForSession: (sessionId: string) => string;
  readonly socketDir?: string;
  readonly logPath?: string;
  readonly genId?: () => string;
  readonly spawnProcess?: SpawnProcess;
}

/** Resolve the compiled detached helper beside this module in every installation layout. */
export function resolveDurableEgressProxyMainPath(): string {
  return fileURLToPath(new URL(`./${TERMINAL_PROCESS_ENTRIES.egressProxy.outputFile}`, import.meta.url));
}

function waitForReady(
  child: DurableProxyChild,
  socketPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      systemClearTimeout(timer);
      child.stdout.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.stdout.destroy();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.includes("READY\n")) finish();
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number | null): void => {
      finish(new Error(`durable egress proxy exited before readiness (${String(code)})`));
    };
    const timer: SystemTimeoutHandle = systemSetTimeout(
      () => finish(new Error(`durable egress proxy readiness timed out for ${socketPath}`)),
      READY_TIMEOUT_MS,
    );
    timer.unref();
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForExit(child: DurableProxyChild): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      systemClearTimeout(timer);
      child.removeListener("exit", finish);
      resolve();
    };
    const timer = systemSetTimeout(finish, DISPOSE_TIMEOUT_MS);
    timer.unref();
    child.once("exit", finish);
    if (!child.kill("SIGTERM")) finish();
  });
}

/** Build the durable materializer injected into the ordinary proxy port. */
export function createDurableEgressMaterializer(
  deps: DurableEgressMaterializerDeps,
): DurableEgressMaterializer {
  const socketDir = deps.socketDir ?? tmpdir();
  const genId = deps.genId ?? (() => randomUUID());
  const spawnProcess = deps.spawnProcess ?? ((bin, args, options) =>
    childSpawn(bin, args, options) as DurableProxyChild);

  return async (hosts, context) => {
    const startedAt = systemNowMs();
    const socketPath = safePath(socketDir, `comis-egress-${genId()}.sock`);
    const args = [
      "--permission",
      "--allow-fs-read=*",
      `--allow-fs-write=${socketDir}`,
      ...(deps.logPath === undefined ? [] : [`--allow-fs-write=${dirname(deps.logPath)}`]),
      "--allow-child-process",
      deps.entryPath,
      "--socket",
      socketPath,
      "--hosts",
      Buffer.from(JSON.stringify(hosts), "utf8").toString("base64url"),
      "--session-id",
      context.sessionId,
      "--tmux-path",
      deps.tmuxPath,
      "--tmux-socket",
      deps.tmuxSocketForSession(context.sessionId),
      "--tmux-name",
      deps.tmuxNameForSession(context.sessionId),
      "--startup-grace-ms",
      String(STARTUP_GRACE_MS),
      ...(deps.logPath === undefined ? [] : ["--log-path", deps.logPath]),
    ];
    const child = spawnProcess(deps.nodePath, args, {
      detached: true,
      env: {},
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.unref();
    await waitForReady(child, socketPath).then(
      () => undefined,
      (error: unknown) => {
        child.kill("SIGTERM");
        return Promise.reject(error);
      },
    );
    deps.logger.info(
      { toolName: "terminal_egress_proxy", step: "durable_materialized", durationMs: systemNowMs() - startedAt },
      "durable egress allowlist proxy listening",
    );

    let disposed = false;
    return {
      socketPath,
      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        await waitForExit(child);
      },
    };
  };
}
