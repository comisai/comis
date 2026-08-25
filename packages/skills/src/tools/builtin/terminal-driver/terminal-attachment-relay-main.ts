// SPDX-License-Identifier: Apache-2.0
// @allow-throw: detached process entry; malformed launcher input is fatal before the ready signal, and the parent maps process exit to a failed materialization.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import {
  systemClearInterval,
  systemNowMs,
  systemSetInterval,
  type SystemIntervalHandle,
} from "@comis/core";
import { fromPromise } from "@comis/shared";

import { materializeExecutionAttachmentRelaysAtPath } from "./terminal-attachment-relay.js";
import { durableProxyLivenessDecision } from "./terminal-durable-egress-proxy.js";
import type { ManagedTerminalExecutionAttachment } from "./terminal-managed-binding.js";

const MAX_PAYLOAD_BYTES = 1_048_576;

interface MainArgs {
  readonly directoryPath: string;
  readonly sessionId: string;
  readonly tmuxPath: string;
  readonly tmuxSocket: string;
  readonly tmuxName: string;
  readonly startupGraceMs: number;
  readonly logPath?: string;
}

interface RelayPayload {
  readonly attachments: readonly ManagedTerminalExecutionAttachment[];
  readonly owner: { readonly uid: number; readonly gid: number };
}

interface RelayLogger {
  info(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
}

function parseArgs(argv: readonly string[]): MainArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    // eslint-disable-next-line security/detect-object-injection -- bounded positional scan over the process argv vector.
    const key = argv[i];
    const value = argv[i + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("durable attachment relay arguments are malformed");
    }
    values.set(key, value);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined || value.length === 0) throw new Error(`missing ${key}`);
    return value;
  };
  const startupGraceMs = Number(required("--startup-grace-ms"));
  if (!Number.isSafeInteger(startupGraceMs) || startupGraceMs < 1) {
    throw new Error("durable attachment relay startup grace is malformed");
  }
  return {
    directoryPath: required("--directory"),
    sessionId: required("--session-id"),
    tmuxPath: required("--tmux-path"),
    tmuxSocket: required("--tmux-socket"),
    tmuxName: required("--tmux-name"),
    startupGraceMs,
    ...(values.get("--log-path") === undefined ? {} : { logPath: values.get("--log-path") }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayload(raw: string): RelayPayload {
  const decoded = JSON.parse(raw) as unknown;
  if (!isRecord(decoded) || !Array.isArray(decoded["attachments"]) || !isRecord(decoded["owner"])) {
    throw new Error("durable attachment relay payload is malformed");
  }
  const owner = decoded["owner"];
  const uid = owner["uid"];
  const gid = owner["gid"];
  if (!Number.isSafeInteger(uid) || (uid as number) < 0 || !Number.isSafeInteger(gid) || (gid as number) < 0) {
    throw new Error("durable attachment relay owner is malformed");
  }
  const attachments: ManagedTerminalExecutionAttachment[] = [];
  for (const value of decoded["attachments"]) {
    if (!isRecord(value)) throw new Error("durable attachment relay attachment is malformed");
    const executionAttachmentId = value["executionAttachmentId"];
    const sourcePath = value["sourcePath"];
    const targetName = value["targetName"];
    const relayIdentity = value["relayIdentity"];
    if (
      typeof executionAttachmentId !== "string"
      || typeof sourcePath !== "string"
      || !sourcePath.startsWith("/")
      || typeof targetName !== "string"
      || typeof relayIdentity !== "string"
    ) {
      throw new Error("durable attachment relay attachment is malformed");
    }
    attachments.push({ executionAttachmentId, sourcePath, targetName, relayIdentity });
  }
  if (attachments.length === 0) throw new Error("durable attachment relay payload is empty");
  return { attachments, owner: { uid: uid as number, gid: gid as number } };
}

async function readPayload(): Promise<RelayPayload> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    total += bytes.byteLength;
    if (total > MAX_PAYLOAD_BYTES) throw new Error("durable attachment relay payload is too large");
    chunks.push(bytes);
  }
  return parsePayload(Buffer.concat(chunks).toString("utf8"));
}

function createLogger(logPath: string | undefined): RelayLogger {
  const write = (level: string, fields: Record<string, unknown>, message?: string): void => {
    if (logPath === undefined) return;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- launcher-stamped worker log path; content is structured and credential-free.
      appendFileSync(logPath, `${JSON.stringify({ level, msg: message ?? "", ...fields, t: systemNowMs() })}\n`);
    } catch {
      return;
    }
  };
  return {
    info: (fields, message) => write("info", fields, message),
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
  if (!/^comis-attachments-[a-zA-Z0-9-]+$/u.test(basename(args.directoryPath))) {
    throw new Error("durable attachment relay directory is malformed");
  }
  const payload = await readPayload();
  const relay = await materializeExecutionAttachmentRelaysAtPath(
    payload.attachments,
    payload.owner,
    args.directoryPath,
  );
  if (!relay.ok) throw relay.error;
  const logger = createLogger(args.logPath);
  const startedAtMs = systemNowMs();
  let observedTmuxAlive = false;
  let stopping = false;
  const stop = async (reason: "signal" | "tmux_session_gone" | "tmux_start_timeout"): Promise<void> => {
    if (stopping) return;
    stopping = true;
    systemClearInterval(interval);
    const disposed = await fromPromise(relay.value.dispose());
    if (!disposed.ok) {
      logger.error(
        { toolName: "terminal_attachment_relay", sessionId: args.sessionId, step: "durable_retire_failed", reason, hint: "remove the stale attachment relay directory before retrying the managed terminal", errorKind: "resource" as const },
        "durable execution attachment relay retirement failed",
      );
      process.exit(1);
    }
    logger.info(
      { toolName: "terminal_attachment_relay", sessionId: args.sessionId, step: "durable_retired", reason, durationMs: systemNowMs() - startedAtMs },
      "durable execution attachment relay retired",
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
