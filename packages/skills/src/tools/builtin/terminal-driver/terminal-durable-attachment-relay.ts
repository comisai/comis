// SPDX-License-Identifier: Apache-2.0
import { spawn as childSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  safePath,
  systemClearTimeout,
  systemNowMs,
  systemSetTimeout,
  type EgressMaterializationContext,
  type SystemTimeoutHandle,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

import {
  materializeExecutionAttachmentRelays,
  type AttachmentRelayMaterialization,
} from "./terminal-attachment-relay.js";
import type { ManagedTerminalExecutionAttachment } from "./terminal-managed-binding.js";
import { TERMINAL_PROCESS_ENTRIES } from "./terminal-process-entry-registry.js";

const READY_TIMEOUT_MS = 10_000;
const DISPOSE_TIMEOUT_MS = 5_000;
const STARTUP_GRACE_MS = 30_000;

interface DurableAttachmentRelayChild {
  readonly stdin: {
    once(event: "error", listener: (error: Error) => void): unknown;
    removeListener(event: "error", listener: (error: Error) => void): unknown;
    end(data: string): void;
  };
  readonly stdout: {
    on(event: "data", listener: (chunk: Buffer) => void): unknown;
    removeListener(event: "data", listener: (chunk: Buffer) => void): unknown;
    destroy(): void;
  };
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "exit", listener: (code: number | null) => void): unknown;
  kill(signal: string): boolean;
  unref(): void;
}

type SpawnProcess = (
  bin: string,
  args: string[],
  options: { detached: true; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "ignore"] },
) => DurableAttachmentRelayChild;

export type ExecutionAttachmentRelayMaterializer = (
  attachments: readonly ManagedTerminalExecutionAttachment[],
  owner: { readonly uid: number; readonly gid: number },
  context: EgressMaterializationContext,
) => Promise<Result<AttachmentRelayMaterialization, Error>>;

interface DurableAttachmentRelayLogger {
  info(fields: Record<string, unknown>, message?: string): void;
}

export interface DurableAttachmentRelayMaterializerDeps {
  readonly logger: DurableAttachmentRelayLogger;
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

export function resolveDurableAttachmentRelayMainPath(): string {
  return fileURLToPath(new URL(`./${TERMINAL_PROCESS_ENTRIES.attachmentRelay.outputFile}`, import.meta.url));
}

function waitForReady(
  child: DurableAttachmentRelayChild,
  directoryPath: string,
  payload: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      systemClearTimeout(timer);
      child.stdin.removeListener("error", onError);
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
      finish(new Error(`durable attachment relay exited before readiness (${String(code)})`));
    };
    const timer: SystemTimeoutHandle = systemSetTimeout(
      () => finish(new Error(`durable attachment relay readiness timed out for ${directoryPath}`)),
      READY_TIMEOUT_MS,
    );
    timer.unref();
    child.stdin.once("error", onError);
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdin.end(payload);
  });
}

function waitForExit(child: DurableAttachmentRelayChild): Promise<void> {
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

export function createDurableExecutionAttachmentRelayMaterializer(
  deps: DurableAttachmentRelayMaterializerDeps,
): ExecutionAttachmentRelayMaterializer {
  const socketDir = deps.socketDir ?? tmpdir();
  const genId = deps.genId ?? (() => randomUUID());
  const spawnProcess = deps.spawnProcess ?? ((bin, args, options) =>
    childSpawn(bin, args, options) as unknown as DurableAttachmentRelayChild);

  return async (attachments, owner, context) => {
    if (context.durability !== "durable") {
      return materializeExecutionAttachmentRelays(attachments, owner);
    }
    const startedAt = systemNowMs();
    const directory = tryCatch(() => safePath(socketDir, `comis-attachments-${genId()}`));
    if (!directory.ok) return err(directory.error);
    const directoryPath = directory.value;
    const relayed = tryCatch(() => attachments.map((attachment) => ({
      ...attachment,
      sourcePath: safePath(directoryPath, attachment.targetName),
    })));
    if (!relayed.ok) return err(relayed.error);
    const args = [
      "--permission",
      "--allow-fs-read=*",
      `--allow-fs-write=${socketDir}`,
      ...(deps.logPath === undefined ? [] : [`--allow-fs-write=${dirname(deps.logPath)}`]),
      "--allow-child-process",
      deps.entryPath,
      "--directory",
      directoryPath,
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
      stdio: ["pipe", "pipe", "ignore"],
    });
    child.unref();
    const ready = await fromPromise(waitForReady(
      child,
      directoryPath,
      JSON.stringify({ attachments, owner }),
    ));
    if (!ready.ok) {
      child.kill("SIGTERM");
      return err(ready.error);
    }
    deps.logger.info(
      { toolName: "terminal_attachment_relay", step: "durable_materialized", durationMs: systemNowMs() - startedAt },
      "durable execution attachment relay listening",
    );

    let disposed = false;
    return ok(Object.freeze({
      attachments: Object.freeze(relayed.value),
      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        await waitForExit(child);
      },
    }));
  };
}
