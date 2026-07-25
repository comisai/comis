// SPDX-License-Identifier: Apache-2.0
// @allow-throw: the socket boundary converts replay divergence into a fixed,
// content-free error response.
/**
 * A physically separate operator replay socket.
 *
 * A standalone `net.createServer` on its own 0600 socket path that speaks the same
 * `{bearer, method, params}` newline-JSON cap-socket wire the jailed SDK sends, but
 * serves recorded results: it reads the run's daemon-owned, content-free
 * `results/replay.jsonl`
 * and, for a request whose `{method, sha256(params)}` matches the next recorded
 * entry (in recorded ORDER), returns the recorded pointer file's bytes as
 * `{ result }`. Any divergence returns `{ error }`; the socket never fabricates
 * success and has no path to a live dispatch.
 *
 * This is a physically separate socket, never a mode of the production capability
 * endpoint. It has no LeaseManager, RPC sink, or tool registry, so
 * a re-spawned jailed script pointed at it (`COMIS_ORCH_SOCKET` → this path) can
 * only ever re-consume its own recorded results. The authoritative production gate
 * stays single-purpose. The operator handler binds this socket per replay and
 * tears it down in a `finally`; it is not bound during a normal run.
 *
 * The wire (buffer / MAX_LINE_BYTES fail-closed overflow / 0600 chmod / open-socket
 * tracking for a non-hanging close) mirrors `setup-capability-endpoint.ts`
 * `startSocket` so a re-spawned script cannot tell the difference at the transport
 * layer — only the served bytes differ (recorded, not live). Every parsed request
 * must authenticate with the per-replay bearer before it can inspect or consume a
 * recorded entry.
 *
 * @module
 */

import net from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, unlinkSync } from "node:fs";
import { PER_FILE_CAP_BYTES, safePath, toSafeErrorLogString, type ComisLogger } from "@comis/core";
import { safeResultRunId } from "@comis/skills/tools";
import { readRegularFile } from "@comis/observability";
import {
  REPLAY_LOG_MAX_BYTES,
  replayParamsDigest,
} from "./capability-replay-recorder.js";

/**
 * Max bytes a single connection may buffer before a newline-terminated request is
 * seen — mirrors the production endpoint. On overflow the socket is destroyed
 * (fail-closed): a client that never sends a `\n` cannot grow `buf` without bound.
 */
const MAX_LINE_BYTES = 64 * 1024;

/** The run's content-free replay log location under the jailed workspace. */
const RESULTS_DIR = "results";
const REPLAY_LOG_NAME = "replay.jsonl";

/** A recorded content-free entry (one parsed line of `replay.jsonl`). */
interface RecordedEntry {
  seq: number;
  method: string;
  /** `sha256(canonical(params))` the request's params must match (in order). */
  paramsDigest: string;
  /** SHA-256 of the exact serialized result bytes. */
  resultDigest: string;
  /** The recorded-result POINTER (`results/<basename>.<kind>`) — read for the bytes. */
  result: string;
}

/** The minimal wire payload the (re-spawned) jailed SDK sends. Mirrors the prod endpoint. */
interface ReplayCallRequest {
  bearer?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
}

/** Deps for {@link createOrchestrateReplaySocket}. */
export interface OrchestrateReplaySocketDeps {
  /**
   * Daemon-owned storage containing `results/<run>/replay.jsonl` and its result
   * blobs. This root is never mounted into an agent jail.
   */
  recordingRootPath: string;
  /** Durable execution whose isolated result directory contains this recording. */
  runId: string;
  /** Per-replay bearer required on every parsed socket request. */
  expectedBearer: string;
  /** Boundary logger (optional; the unit tests omit it → the handlers degrade to no-ops). */
  logger?: ComisLogger;
}

/** The replay socket handle bound per operator replay. */
export interface OrchestrateReplaySocket {
  /** Load the recorded entries + bind the 0600 owner-only unix socket at `socketPath`. */
  start(socketPath: string): Promise<void>;
  /** Stop the socket server + unlink the socket file. Idempotent. */
  close(): Promise<void>;
  /**
   * Whether ANY served request diverged (an exhausted log, a method/params-digest
   * mismatch, or a gone/escaped recorded pointer) — a sticky flag set the first time
   * `handleReplayCall` throws. Divergence is signalled to the jailed child over the
   * socket as `{error}`, which the parent respawn cannot observe; the session reads
   * this AFTER the re-spawn so a diverged replay is reported honestly (not a clean
   * success). Read once the re-spawn has settled (every cap call has been served).
   */
  diverged(): boolean;
}

/**
 * Build the separate replay-serving socket over the run's `results/replay.jsonl`.
 * The recorded entries load once at {@link OrchestrateReplaySocket.start}; a single
 * cursor (shared across the per-call connections a re-spawned script opens, in
 * order) advances ONLY on a matched, served entry.
 */
export function createOrchestrateReplaySocket(
  deps: OrchestrateReplaySocketDeps,
): OrchestrateReplaySocket {
  const log = deps.logger?.child({ submodule: "orchestrate-replay-socket" });
  const safeRunId = safeResultRunId(deps.runId);
  const resultRefPrefix = `${RESULTS_DIR}/${safeRunId}/`;
  const expectedBearerDigest = createHash("sha256").update(deps.expectedBearer, "utf8").digest();
  let server: net.Server | null = null;
  let boundSocketPath: string | null = null;
  const openSockets = new Set<net.Socket>();
  // The recorded entries in ORDER + a shared cursor. The re-spawned script opens
  // one connection per cap call, in the recorded order, so the cursor advances in
  // lockstep with a faithful replay; a diverging call leaves it put and gets {error}.
  let entries: RecordedEntry[] = [];
  let cursor = 0;
  // Sticky divergence flag — set the first time handleReplayCall throws (any
  // divergence). The session reads it via `diverged()` after the re-spawn settles.
  let divergedFlag = false;

  /** Load + parse `results/replay.jsonl` (best-effort; a missing/garbled line is skipped). */
  function loadEntries(): void {
    entries = [];
    cursor = 0;
    let logPath: string;
    try {
      logPath = safePath(
        deps.recordingRootPath,
        RESULTS_DIR,
        safeRunId,
        REPLAY_LOG_NAME,
      );
    } catch {
      return; // workspace escape — serve nothing (every request diverges).
    }
    const read = readRegularFile({
      path: logPath,
      maxFileBytes: REPLAY_LOG_MAX_BYTES,
      confinedBaseDir: deps.recordingRootPath,
    });
    if (!read.ok) return;
    const raw = read.value.content.toString("utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        entries.push(JSON.parse(trimmed) as RecordedEntry);
      } catch {
        // A malformed line — skip it; the resulting order gap surfaces as a
        // divergence downstream (never a fabricated match).
      }
    }
  }

  /** Compare fixed-size bearer digests so unequal input lengths never reach timingSafeEqual. */
  function authenticates(candidate: unknown): boolean {
    const isString = typeof candidate === "string";
    const candidateDigest = createHash("sha256")
      .update(isString ? candidate : "", "utf8")
      .digest();
    const equal = timingSafeEqual(candidateDigest, expectedBearerDigest);
    return isString && equal;
  }

  /**
   * Serve the NEXT recorded entry IF it matches `{method, sha256(params)}`, reading
   * the recorded pointer's bytes; else throw (the socket's `.catch` renders the
   * throw as a content-free `{ error }`). NEVER a real dispatch — the only outputs
   * are a recorded pointer's bytes or a divergence error. Advances the
   * cursor ONLY on a matched, served entry so a divergence does not consume a slot.
   */
  async function handleReplayCall(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const entry = entries.at(cursor);
    if (entry === undefined) {
      throw new Error("replay diverged: no further recorded results");
    }
    if (entry.method !== method || entry.paramsDigest !== replayParamsDigest(params)) {
      throw new Error("replay diverged: request does not match the next recorded call");
    }
    // Read only a direct ResultRef file from this replay's isolated run root. A
    // sibling-run pointer, nested write artifact, escape, or gone blob diverges.
    let abs: string;
    try {
      if (typeof entry.result !== "string" || !entry.result.startsWith(resultRefPrefix)) {
        throw new Error("pointer belongs to another run");
      }
      const pointerName = entry.result.slice(resultRefPrefix.length);
      if (pointerName.length === 0 || pointerName.includes("/") || pointerName.includes("\\")) {
        throw new Error("pointer is not a direct run result");
      }
      abs = safePath(deps.recordingRootPath, RESULTS_DIR, safeRunId, pointerName);
    } catch {
      throw new Error("replay diverged: recorded result path is outside this run");
    }
    const resultRead = readRegularFile({
      path: abs,
      maxFileBytes: PER_FILE_CAP_BYTES,
      confinedBaseDir: deps.recordingRootPath,
    });
    if (!resultRead.ok) {
      throw new Error("replay diverged: recorded result blob is gone");
    }
    const bytes = resultRead.value.content.toString("utf8");
    const actualResultDigest = createHash("sha256").update(resultRead.value.content).digest("hex");
    if (
      typeof entry.resultDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.resultDigest) ||
      actualResultDigest !== entry.resultDigest
    ) {
      throw new Error("replay diverged: recorded result integrity check failed");
    }
    // The recorded bytes are `JSON.stringify(result)`; parse them back so the socket
    // wire (`{ result }`) reconstructs the original reply byte-identically.
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes);
    } catch {
      throw new Error("replay diverged: recorded result blob is invalid");
    }
    cursor += 1; // advance only after a matched entry is valid and ready to serve
    return parsed;
  }

  function start(socketPath: string): Promise<void> {
    loadEntries();
    return new Promise((resolve, reject) => {
      const srv = net.createServer((socket) => {
        openSockets.add(socket);
        socket.on("close", () => {
          openSockets.delete(socket);
        });
        let buf = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          buf += chunk;
          if (buf.length > MAX_LINE_BYTES) {
            log?.warn(
              {
                submodule: "orchestrate-replay-socket",
                errorKind: "validation" as const,
                hint: "replay socket request exceeded the max line size before a newline — connection destroyed",
                maxLineBytes: MAX_LINE_BYTES,
              },
              "Replay socket receive buffer overflow",
            );
            socket.destroy();
            return;
          }
          const nl = buf.indexOf("\n");
          if (nl === -1) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let req: ReplayCallRequest;
          try {
            req = JSON.parse(line) as ReplayCallRequest;
          } catch {
            socket.end(JSON.stringify({ error: "malformed request" }) + "\n");
            return;
          }
          if (!authenticates(req.bearer)) {
            socket.end(JSON.stringify({ error: "authentication failed" }) + "\n");
            return;
          }
          if (typeof req.method !== "string") {
            socket.end(JSON.stringify({ error: "malformed request" }) + "\n");
            return;
          }
          void handleReplayCall(req.method, req.params ?? {})
            .then((result) => {
              socket.end(JSON.stringify({ result }) + "\n");
            })
            .catch((err: unknown) => {
              // Any handleReplayCall throw is a divergence (exhausted log,
              // method/params-digest mismatch, gone/escaped pointer). Record the
              // sticky flag BEFORE replying so the session reads a settled value
              // after the re-spawn, then emit the content-free divergence signal
              // to the (re-spawned) client — a fixed reason, never params/bytes.
              divergedFlag = true;
              const message = err instanceof Error ? err.message : "replay call failed";
              socket.end(JSON.stringify({ error: message }) + "\n");
            });
        });
        socket.on("error", (err: Error) => {
          log?.debug(
            {
              submodule: "orchestrate-replay-socket",
              err: toSafeErrorLogString(err),
              errorKind: "network" as const,
              hint: "replay socket connection error (typically a client disconnecting mid-write)",
            },
            "Replay socket connection error",
          );
        });
      });
      server = srv;
      // A persistent server-error logger survives after the reject handler is spent.
      srv.on("error", (err: Error) => {
        log?.error(
          {
            submodule: "orchestrate-replay-socket",
            err: toSafeErrorLogString(err),
            errorKind: "network" as const,
            hint: "replay socket server error",
          },
          "Replay socket server error",
        );
      });
      srv.on("error", reject);
      // Unlink a stale socket before binding (prevents EADDRINUSE).
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied replay socket path (ephemeral, operator-invoked)
        unlinkSync(socketPath);
      } catch {
        /* not present — ok */
      }
      srv.listen({ path: socketPath }, () => {
        // Restrict the socket to owner-only (rw-------) — mirrors the prod endpoint.
        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied replay socket path (ephemeral, operator-invoked)
          chmodSync(socketPath, 0o600);
        } catch {
          /* non-POSIX FS — ok */
        }
        boundSocketPath = socketPath;
        log?.info(
          { submodule: "orchestrate-replay-socket", socketPath, recorded: entries.length },
          "Replay socket bound (0600 owner-only; serving recorded results)",
        );
        resolve();
      });
    });
  }

  function close(): Promise<void> {
    return new Promise((resolve) => {
      const srv = server;
      if (!srv) {
        resolve();
        return;
      }
      server = null;
      // Destroy every tracked connection FIRST so a stuck client cannot wedge
      // srv.close() (which otherwise waits for open connections to drain).
      for (const socket of openSockets) {
        socket.destroy();
      }
      openSockets.clear();
      srv.close(() => {
        if (boundSocketPath) {
          try {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- the path we bound (ephemeral, operator-invoked)
            unlinkSync(boundSocketPath);
          } catch {
            /* already gone — ok */
          }
          boundSocketPath = null;
        }
        resolve();
      });
    });
  }

  function diverged(): boolean {
    return divergedFlag;
  }

  return { start, close, diverged };
}
