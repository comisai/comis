// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { safePath } from "@comis/core";
import { fromPromise, tryCatch } from "@comis/shared";
import type { TerminalRootProcessIdentity } from "@comis/skills/tools";

export interface TerminalRootProcessIdentityDeps {
  readonly platform?: NodeJS.Platform;
  readonly readText?: (path: string) => Promise<string>;
  readonly readDarwinStart?: (pid: number) => string | undefined;
}

export interface TerminalRootProcessIdentitySyncDeps {
  readonly platform?: NodeJS.Platform;
  readonly readText?: (path: string) => string;
  readonly readDarwinStart?: (pid: number) => string | undefined;
}

/** Parse Linux proc field 22 after locating the command's final closing parenthesis. */
export function parseLinuxProcessStartIdentity(stat: string): string | undefined {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return undefined;
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/u);
  const startTicks = fields[19];
  return startTicks !== undefined && /^\d+$/u.test(startTicks)
    ? `linux:${startTicks}`
    : undefined;
}

function defaultDarwinStart(pid: number): string | undefined {
  const read = tryCatch(() => execFileSync(
    "/bin/ps",
    ["-p", String(pid), "-o", "lstart="],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim());
  if (!read.ok || read.value.length === 0) return undefined;
  return `darwin:${createHash("sha256").update(read.value, "utf8").digest("hex")}`;
}

function readLinuxProcStat(path: string): Promise<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the caller constructs this path under /proc from a validated positive integer PID
  return readFile(path, "utf8");
}

/** Build the daemon trust-boundary resolver; unprovable or reused PIDs fail closed. */
export function createTerminalRootProcessIdentityResolver(
  deps: TerminalRootProcessIdentityDeps = {},
): (pid: number) => Promise<TerminalRootProcessIdentity | undefined> {
  const platform = deps.platform ?? process.platform;
  const readText = deps.readText ?? readLinuxProcStat;
  const readDarwinStart = deps.readDarwinStart ?? defaultDarwinStart;
  return async (pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    let startIdentity: string | undefined;
    if (platform === "linux") {
      const statPath = safePath("/proc", String(pid), "stat");
      const read = await fromPromise(readText(statPath));
      startIdentity = read.ok ? parseLinuxProcessStartIdentity(read.value) : undefined;
    } else if (platform === "darwin") {
      startIdentity = readDarwinStart(pid);
    }
    return startIdentity === undefined ? undefined : { pid, startIdentity };
  };
}

/** Build the synchronous trust-boundary resolver used during boot-time tmux recovery. */
export function createTerminalRootProcessIdentitySyncResolver(
  deps: TerminalRootProcessIdentitySyncDeps = {},
): (pid: number) => TerminalRootProcessIdentity | undefined {
  const platform = deps.platform ?? process.platform;
  const readText = deps.readText ?? ((path: string) => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the caller constructs this path under /proc from a validated positive integer PID
    return readFileSync(path, "utf8");
  });
  const readDarwinStart = deps.readDarwinStart ?? defaultDarwinStart;
  return (pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    let startIdentity: string | undefined;
    if (platform === "linux") {
      const statPath = safePath("/proc", String(pid), "stat");
      const read = tryCatch(() => readText(statPath));
      startIdentity = read.ok ? parseLinuxProcessStartIdentity(read.value) : undefined;
    } else if (platform === "darwin") {
      startIdentity = readDarwinStart(pid);
    }
    return startIdentity === undefined ? undefined : { pid, startIdentity };
  };
}
