// SPDX-License-Identifier: Apache-2.0
import type { ChildProcess } from "node:child_process";

export interface ManagedChildStopOptions {
  readonly gracefulTimeoutMs?: number;
  readonly forcedTimeoutMs?: number;
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function exitsWithin(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function stopManagedChild(
  child: ChildProcess,
  options: ManagedChildStopOptions = {},
): Promise<void> {
  if (childHasExited(child)) return;
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 3_000;
  const forcedTimeoutMs = options.forcedTimeoutMs ?? 3_000;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  if (await exitsWithin(exited, gracefulTimeoutMs)) return;
  if (!childHasExited(child)) child.kill("SIGKILL");
  if (!(await exitsWithin(exited, forcedTimeoutMs))) {
    throw new Error("managed child did not exit after forced shutdown");
  }
}
