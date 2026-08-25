// SPDX-License-Identifier: Apache-2.0
// @allow-throw: detached process entry; malformed launcher input is fatal before the ready signal, and the parent maps process exit to a failed materialization.
/** Detached durable egress proxy process entry. */

import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  systemClearInterval,
  systemNowMs,
  systemSetInterval,
  type SystemIntervalHandle,
} from "@comis/core";

import { durableProxyLivenessDecision } from "./terminal-durable-egress-proxy.js";
import { createTerminalEgressProxy, type EgressProxyLogger } from "./terminal-egress-proxy.js";

interface MainArgs {
  readonly socketPath: string;
  readonly hosts: string[];
  readonly sessionId: string;
  readonly tmuxPath: string;
  readonly tmuxSocket: string;
  readonly tmuxName: string;
  readonly startupGraceMs: number;
  readonly logPath?: string;
}

function parseArgs(argv: readonly string[]): MainArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    // eslint-disable-next-line security/detect-object-injection -- bounded positional scan over the process argv vector.
    const key = argv[i];
    const value = argv[i + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("durable egress proxy arguments are malformed");
    }
    values.set(key, value);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined || value.length === 0) throw new Error(`missing ${key}`);
    return value;
  };
  const decoded = JSON.parse(Buffer.from(required("--hosts"), "base64url").toString("utf8")) as unknown;
  if (!Array.isArray(decoded) || !decoded.every((host) => typeof host === "string")) {
    throw new Error("durable egress host allowlist is malformed");
  }
  const startupGraceMs = Number(required("--startup-grace-ms"));
  if (!Number.isSafeInteger(startupGraceMs) || startupGraceMs < 1) {
    throw new Error("durable egress startup grace is malformed");
  }
  return {
    socketPath: required("--socket"),
    hosts: decoded,
    sessionId: required("--session-id"),
    tmuxPath: required("--tmux-path"),
    tmuxSocket: required("--tmux-socket"),
    tmuxName: required("--tmux-name"),
    startupGraceMs,
    ...(values.get("--log-path") === undefined ? {} : { logPath: values.get("--log-path") }),
  };
}

function createLogger(logPath: string | undefined): EgressProxyLogger {
  const write = (level: string, fields: Record<string, unknown>, message?: string): void => {
    if (logPath === undefined) return;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- launcher-stamped worker log path; content is structured and credential-free.
      appendFileSync(logPath, `${JSON.stringify({ level, msg: message ?? "", ...fields, t: systemNowMs() })}\n`);
    } catch {
      // Best-effort boundary log; proxy enforcement must not depend on log storage.
    }
  };
  return {
    debug: (fields, message) => write("debug", fields, message),
    info: (fields, message) => write("info", fields, message),
    warn: (fields, message) => write("warn", fields, message),
    error: (fields, message) => write("error", fields, message),
  };
}

function tmuxAlive(args: MainArgs): boolean {
  try {
    execFileSync(args.tmuxPath, ["-S", args.tmuxSocket, "has-session", "-t", args.tmuxName], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logger = createLogger(args.logPath);
  const filename = basename(args.socketPath);
  const prefix = "comis-egress-";
  if (!filename.startsWith(prefix) || !filename.endsWith(".sock")) {
    throw new Error("durable egress socket name is malformed");
  }
  const id = filename.slice(prefix.length, -".sock".length);
  const proxy = createTerminalEgressProxy({
    logger,
    socketDir: dirname(args.socketPath),
    genId: () => id,
  });
  const materialized = await proxy.materialize(
    args.hosts,
    { sessionId: args.sessionId, durability: "transient" },
  );
  if (materialized.socketPath !== args.socketPath) {
    await materialized.dispose();
    throw new Error("durable egress socket identity drifted");
  }

  const startedAtMs = systemNowMs();
  let observedTmuxAlive = false;
  let stopping = false;
  const stop = async (reason: "signal" | "tmux_session_gone" | "tmux_start_timeout"): Promise<void> => {
    if (stopping) return;
    stopping = true;
    systemClearInterval(interval);
    await materialized.dispose();
    logger.info(
      { toolName: "terminal_egress_proxy", step: "durable_retired", reason, durationMs: systemNowMs() - startedAtMs },
      "durable egress allowlist proxy retired",
    );
    process.exit(0);
  };
  const interval: SystemIntervalHandle = systemSetInterval(() => {
    const decision = durableProxyLivenessDecision({
      nowMs: systemNowMs(),
      startedAtMs,
      startupGraceMs: args.startupGraceMs,
      observedTmuxAlive,
      tmuxAlive: tmuxAlive(args),
    });
    if (decision.action === "retain") {
      observedTmuxAlive = decision.observedTmuxAlive;
      return;
    }
    void stop(decision.reason);
  }, 1_000);
  process.once("SIGTERM", () => void stop("signal"));
  process.once("SIGINT", () => void stop("signal"));
  process.stdout.write("READY\n");
}

function isEntryScript(): boolean {
  const entry = process.argv[1];
  return typeof entry === "string" && fileURLToPath(import.meta.url) === entry;
}

if (isEntryScript()) void main();
