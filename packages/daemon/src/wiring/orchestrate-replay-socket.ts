// SPDX-License-Identifier: Apache-2.0
// @allow-throw: replay-divergence boundary. handleReplayCall THROWS on any
// divergence (no further recorded entry, method/params-digest mismatch, a
// path-escape or gone pointer) as the serving contract — the socket server's
// catch converts the throw to a content-free {error} line to the (re-spawned)
// client (mirrors setup-capability-endpoint.ts startSocket, whose deny branches
// throw and are caught into a content-free JSON error the same way).
/**
 * `createOrchestrateReplaySocket` — the SEPARATE operator replay socket (REPLAY-02).
 *
 * A standalone `net.createServer` on its OWN 0600 socket path that speaks the SAME
 * `{bearer, method, params}` newline-JSON cap-socket wire the jailed SDK sends, but
 * SERVES RECORDED RESULTS: it reads the run's content-free `results/replay.jsonl`
 * and, for a request whose `{method, sha256(params)}` matches the NEXT recorded
 * entry (in recorded ORDER), returns the recorded pointer file's bytes as
 * `{ result }`. Any divergence (wrong method, diverged params, exhausted log, a
 * gone pointer) returns `{ error }` — an honest divergence signal, NEVER a
 * fabricated success and NEVER a real dispatch.
 *
 * INV-1 (the load-bearing boundary): this is a PHYSICALLY SEPARATE socket, never a
 * MODE of the production capability endpoint. It has NO LeaseManager, NO rpcCall
 * sink, and NO tool registry — it cannot dispatch a real tool even in principle, so
 * a re-spawned jailed script pointed at it (`COMIS_ORCH_SOCKET` → this path) can
 * only ever re-consume its own recorded results. The authoritative production gate
 * (`setup-capability-endpoint.ts` `startSocket`) stays single-purpose. The socket
 * is operator-invoked + ephemeral: plan 06's admin handler binds it per-replay and
 * tears it down in a `finally`; it is NOT bound during a normal run.
 *
 * The wire (buffer / MAX_LINE_BYTES fail-closed overflow / 0600 chmod / open-socket
 * tracking for a non-hanging close) MIRRORS `setup-capability-endpoint.ts`
 * `startSocket` so a re-spawned script cannot tell the difference at the transport
 * layer — only the SERVED bytes differ (recorded, not live). The bearer is accepted
 * as-is here: the socket's security is that it serves ONLY recorded, content-free-
 * keyed results and is not reachable during normal operation (plan 06 mints an
 * ephemeral OutputGuard-registered bearer for defense-in-depth).
 *
 * @module
 */

import net from "node:net";
import { chmodSync, unlinkSync, readFileSync, existsSync } from "node:fs";
import { safePath, type ComisLogger } from "@comis/core";
import { replayParamsDigest } from "./setup-capability-endpoint.js";

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
  /** The recorded-result POINTER (`results/<basename>.<kind>`) — read for the bytes. */
  result: string;
}

/** The minimal wire payload the (re-spawned) jailed SDK sends. Mirrors the prod endpoint. */
interface ReplayCallRequest {
  bearer: string;
  method: string;
  params?: Record<string, unknown>;
}

/** Deps for {@link createOrchestrateReplaySocket}. */
export interface OrchestrateReplaySocketDeps {
  /**
   * The run's jailed workspace — `<workspacePath>/results/replay.jsonl` + the
   * recorded pointer files live here. The socket reads (never writes) under it.
   */
  workspacePath: string;
  /** Boundary logger (optional; the unit tests omit it → the handlers degrade to no-ops). */
  logger?: ComisLogger;
}

/** The replay socket handle — the 0600 socket lifecycle plan 06 binds per-replay. */
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
      logPath = safePath(deps.workspacePath, RESULTS_DIR, REPLAY_LOG_NAME);
    } catch {
      return; // workspace escape — serve nothing (every request diverges).
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- safePath-confined to the run workspace; the basename is a fixed literal
    if (!existsSync(logPath)) return;
    let raw: string;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safePath-confined to the run workspace; the basename is a fixed literal
      raw = readFileSync(logPath, "utf8");
    } catch {
      return;
    }
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

  /**
   * Serve the NEXT recorded entry IF it matches `{method, sha256(params)}`, reading
   * the recorded pointer's bytes; else throw (the socket's `.catch` renders the
   * throw as a content-free `{ error }`). NEVER a real dispatch — the only outputs
   * are a recorded pointer's bytes or a divergence error (INV-1). Advances the
   * cursor ONLY on a matched, served entry so a divergence does not consume a slot.
   */
  async function handleReplayCall(
    _bearer: string,
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
    // Read the recorded pointer's bytes (workspace-confined). A gone/expired blob or
    // a path escape is a divergence, never a fabricated result.
    let abs: string;
    try {
      abs = safePath(deps.workspacePath, entry.result);
    } catch {
      throw new Error("replay diverged: recorded result path escapes the workspace");
    }
    let bytes: string;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safePath-confined; entry.result is a store-minted results/ pointer
      bytes = readFileSync(abs, "utf8");
    } catch {
      throw new Error("replay diverged: recorded result blob is gone");
    }
    cursor += 1; // advance ONLY on a matched, served entry (in-order)
    // The recorded bytes are `JSON.stringify(result)`; parse them back so the socket
    // wire (`{ result }`) reconstructs the original reply byte-identically.
    return JSON.parse(bytes);
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
          void handleReplayCall(req.bearer, req.method, req.params ?? {})
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
              err,
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
            err,
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
