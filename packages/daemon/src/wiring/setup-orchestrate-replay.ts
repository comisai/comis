// SPDX-License-Identifier: Apache-2.0
// @allow-throw: operator control-plane replay handler glue. runOrchestrateReplaySession
// THROWS a content-free error on a validation failure (unknown runId / no pinned
// scriptRef / lookup error) and re-throws a re-spawn failure AFTER tearing the
// socket down in a finally — the throw IS the JSON-RPC error path (rpc-dispatch's
// catch logs + re-throws it, mirroring the admin *-handlers.ts throws).
/**
 * `runOrchestrateReplaySession` — the operator deterministic-replay glue.
 *
 * Drives one `comis orchestrate replay <runId>` invocation end to end:
 *   1. Validate `runId` against a REAL durable orchestrate row (a row carrying a
 *      pinned `scriptRef`) — an unknown/non-orchestrate run throws a content-free
 *      error before any socket bind or re-spawn.
 *   2. Mint an EPHEMERAL replay bearer and `outputGuard.registerSecret` it BEFORE
 *      it leaves this closure (Pitfall 6 — a new bearer that isn't registered can
 *      leak via a log/model echo). The bearer + socket are per-replay + ephemeral.
 *   3. Start the SEPARATE replay socket (plan-05 `createOrchestrateReplaySocket`)
 *      on a fresh 0600 path — never the production capability endpoint.
 *   4. Re-spawn the PINNED bytes with `COMIS_ORCH_SOCKET` pointed at the replay
 *      socket via the injected `respawn` seam; the operator supplies no script
 *      because the pinned `scriptRef` bytes are the sole source.
 *   5. Collect the stdout (byte-identical to the original for a faithful run).
 *   6. Tear the socket down in a `finally` regardless of outcome.
 *
 * Isolation is enforced by construction: the handler starts a physically separate
 * socket and points the re-spawn's egress env at it; the production gate is never
 * invoked. The `respawn` seam is INJECTED — the sandbox-backed production closure
 * (the plan-03 `loadResumeSpec` + `runScriptWithOneShotRepair` envelope, pointed
 * at this socket) is assembled at the daemon composition root where the sandbox
 * provider lives; the real jailed byte-identical round-trip is exercised on the
 * Linux/VPS drive. This module owns the deterministic + confused-deputy-safe
 * ORCHESTRATION of the replay (validation, bearer hygiene, socket lifecycle,
 * re-spawn target), which is fully unit-testable on macOS via the seam.
 *
 * @module
 */
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { toSafeErrorLogString, type DurableRunPort } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { ResumePrincipal } from "@comis/skills/tools";

import {
  createOrchestrateReplaySocket,
  type OrchestrateReplaySocket,
} from "./orchestrate-replay-socket.js";

// ---------------------------------------------------------------------------
// The jail-egress env-var names the re-spawned SDK runtime reads. The replay
// re-spawn reuses the SAME names as a production run but points the socket at
// the SEPARATE replay socket + authenticates with the ephemeral replay bearer.
// ---------------------------------------------------------------------------

/** The unix cap-socket path the jailed SDK runtime dials — the ONLY egress. */
const ENV_ORCH_SOCKET = "COMIS_ORCH_SOCKET";
/** The bearer the jailed SDK runtime presents on every cap call. */
const ENV_CAP_LEASE = "COMIS_CAP_LEASE";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** The input the re-spawn seam receives for one deterministic replay. */
export interface OrchestrateReplayRespawnInput {
  /** The validated durable root run id being replayed. */
  readonly rootRunId: string;
  /** The original agent workspace used only to load the durable pinned script. */
  readonly workspacePath: string;
  /** The bound replay socket path used as the re-spawn's `COMIS_ORCH_SOCKET`. */
  readonly socketPath: string;
  /** The ephemeral replay bearer — the re-spawn's `COMIS_CAP_LEASE`. */
  readonly bearer: string;
  /**
   * The child env with `COMIS_ORCH_SOCKET`/`COMIS_CAP_LEASE` already pointed at
   * the replay socket + bearer (built by {@link buildReplayChildEnv}). The
   * production seam merges it over the sandbox base before spawning.
   */
  readonly childEnv: Record<string, string | undefined>;
  /** Persisted execution identity already validated by this operator control-plane handler. */
  readonly principal: ResumePrincipal;
}

/**
 * The re-spawn seam: re-run the durable run's PINNED bytes against the replay
 * socket and return the produced stdout. INJECTED — the sandbox-backed
 * production closure (loadResumeSpec + runScriptWithOneShotRepair) is assembled
 * at the composition root; the macOS tests inject a fake. `diverged` is set when
 * a re-run cap call did not match the next recorded result.
 */
export type OrchestrateReplayRespawn = (
  input: OrchestrateReplayRespawnInput,
) => Promise<{ stdout: string; diverged?: boolean }>;

/**
 * The daemon-assembled replay wiring cluster (the pieces that need a daemon
 * resource + cannot be defaulted): the daemon-wide OutputGuard the ephemeral
 * bearer registers in, the sandbox-backed re-spawn seam, and (optionally) a
 * replay-socket factory override. The composition root supplies this; rpc-dispatch
 * combines it with the durable store + a workspace resolver into the session deps.
 * OPTIONAL on the dispatch deps ⇒ absent ⇒ `orchestrate.replay` is not registered.
 */
export interface OrchestrateReplayWiring {
  /** The daemon-wide OutputGuard — the ephemeral bearer registers here (Pitfall 6). */
  readonly outputGuard: { registerSecret(secret: string): void };
  /** The sandbox-backed pinned-byte re-spawn (points COMIS_ORCH_SOCKET at the replay socket). */
  readonly respawn: OrchestrateReplayRespawn;
  /** Daemon-owned replay evidence root, never mounted into an agent jail. */
  readonly recordingRootPath: string;
  /** Optional replay-socket factory override (defaults to `createOrchestrateReplaySocket`). */
  readonly createReplaySocket?: (deps: {
    recordingRootPath: string;
    runId: string;
    expectedBearer: string;
    logger?: ComisLogger;
  }) => OrchestrateReplaySocket;
}

/** Everything {@link runOrchestrateReplaySession} needs, with seams for the macOS tests. */
export interface OrchestrateReplaySessionDeps {
  /** The durable-run store validates the execution id to a real checkpoint. */
  readonly durableRuns: Pick<DurableRunPort, "getByCheckpoint">;
  /** Resolve the persisted agent's exact jailed workspace; absence fails closed. */
  readonly resolveWorkspace: (agentId: string) => string | undefined;
  /** The sandbox-backed pinned-byte re-spawn seam. */
  readonly respawn: OrchestrateReplayRespawn;
  /** Daemon-owned replay evidence root, never mounted into an agent jail. */
  readonly recordingRootPath: string;
  /** The daemon-wide OutputGuard the ephemeral bearer registers in (Pitfall 6). */
  readonly outputGuard: { registerSecret(secret: string): void };
  /** Structured logger for the content-free §2.7 instrumentation. */
  readonly logger: ComisLogger;
  /** Replay-socket factory (defaults to the plan-05 `createOrchestrateReplaySocket`). */
  readonly createReplaySocket?: (deps: {
    recordingRootPath: string;
    runId: string;
    expectedBearer: string;
    logger?: ComisLogger;
  }) => OrchestrateReplaySocket;
  /** Ephemeral-bearer minter (defaults to a 256-bit random hex). */
  readonly mintBearer?: () => string;
  /** Fresh 0600 replay-socket path resolver (defaults to an OS-temp-dir path). */
  readonly resolveReplaySocketPath?: (rootRunId: string) => string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** A throwaway 256-bit replay bearer (registered in OutputGuard before use). */
export function defaultMintReplayBearer(): string {
  return randomBytes(32).toString("hex");
}

/**
 * A fresh per-replay socket path under the OS temp dir. Delegates to
 * {@link resolveReplaySocketPathIn} with the process temp dir so the bound is
 * deterministically unit-testable with an injected base.
 */
export function defaultResolveReplaySocketPath(rootRunId: string): string {
  return resolveReplaySocketPathIn(tmpdir(), rootRunId);
}

/**
 * Conservative bound on the full unix socket path: the `sun_path` limit is ~104
 * bytes on macOS (~108 on Linux); staying under 100 leaves headroom so `listen()`
 * never fails ENAMETOOLONG.
 */
const UNIX_SOCKET_PATH_MAX_BYTES = 100;

/**
 * The short, always-present fallback base used when the OS temp dir would push the
 * full socket path past the `sun_path` limit (a long macOS `/var/folders/...` TMPDIR).
 */
const SHORT_SOCKET_FALLBACK_DIR = "/tmp";

/**
 * Resolve a fresh 0600 replay socket path under `baseTmpDir`. The basename is a
 * short random hex (no runId embed); the socket chmod-0600s on bind. Only the
 * basename is bounded by construction — a long `baseTmpDir` (macOS `tmpdir()` is a
 * long `/var/folders/xx/…/T` path) can still push the FULL path past the unix
 * `sun_path` limit, so when the preferred path would overflow, fall back to the
 * short, always-present `/tmp` base. Exported + base-injected so the length bound
 * is deterministically testable without touching the process env.
 */
export function resolveReplaySocketPathIn(baseTmpDir: string, _rootRunId: string): string {
  const name = `comis-rpl-${randomBytes(8).toString("hex")}.sock`;
  const preferred = join(baseTmpDir, name);
  if (Buffer.byteLength(preferred, "utf8") <= UNIX_SOCKET_PATH_MAX_BYTES) return preferred;
  return join(SHORT_SOCKET_FALLBACK_DIR, name);
}

// ---------------------------------------------------------------------------
// The re-spawn environment points only at the replay socket.
// ---------------------------------------------------------------------------

/**
 * Build the re-spawn child env: the SAME `COMIS_ORCH_SOCKET`/`COMIS_CAP_LEASE`
 * names a production run uses, but `COMIS_ORCH_SOCKET` is the SEPARATE replay
 * socket path and `COMIS_CAP_LEASE` is the ephemeral replay bearer. The
 * two replay keys ALWAYS win over any inherited base env, so a base carrying the
 * production socket/bearer can never leak into the re-spawn.
 */
export function buildReplayChildEnv(
  socketPath: string,
  bearer: string,
  baseEnv?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...baseEnv,
    [ENV_ORCH_SOCKET]: socketPath,
    [ENV_CAP_LEASE]: bearer,
  };
}

/** Fail-closed overlap check between the agent bind and daemon evidence root. */
function replayPathsOverlap(first: string, second: string): boolean {
  const canonical = (path: string): string => {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- trusted configured roots used only for containment comparison.
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  const firstPath = canonical(first);
  const secondPath = canonical(second);
  const atOrUnder = (candidate: string, parent: string): boolean => {
    const rel = relative(parent, candidate);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  return atOrUnder(firstPath, secondPath) || atOrUnder(secondPath, firstPath);
}

// ---------------------------------------------------------------------------
// The replay session
// ---------------------------------------------------------------------------

/**
 * Run one deterministic replay of a durable orchestrate run. See the module
 * docblock for the 6-step contract. Throws a content-free error on a validation
 * failure (no re-spawn) and re-throws a re-spawn failure AFTER the socket is torn
 * down in the `finally`.
 */
export async function runOrchestrateReplaySession(
  deps: OrchestrateReplaySessionDeps,
  runId: string,
): Promise<{ stdout: string; diverged?: boolean }> {
  const log = deps.logger.child({ submodule: "orchestrate-replay" });

  // 1. Validate the runId against a durable orchestrate row.
  //    Content-free refusals: the message names the failure CLASS, never the
  //    runId (an operator-supplied id we do not echo back into a log/error).
  const rowResult = await deps.durableRuns.getByCheckpoint(runId);
  if (!rowResult.ok) {
    log.warn(
      { method: "orchestrate.replay", err: toSafeErrorLogString(rowResult.error), errorKind: "dependency" as const, hint: "the durable-run lookup failed; cannot replay" },
      "orchestrate.replay durable-run lookup failed",
    );
    throw new Error("the durable-run lookup failed — cannot replay");
  }
  const row = rowResult.value;
  if (row === undefined) {
    throw new Error("no resumable orchestrate run found to replay");
  }
  if (!row.scriptRef) {
    throw new Error("the durable run has no pinned script — not a replayable orchestrate run");
  }

  const workspacePath = deps.resolveWorkspace(row.agentId);
  if (workspacePath === undefined) {
    throw new Error("the durable run workspace is unavailable — cannot replay");
  }
  if (replayPathsOverlap(workspacePath, deps.recordingRootPath)) {
    throw new Error("the durable run workspace overlaps the replay evidence store — cannot replay");
  }

  // 2. Mint an EPHEMERAL replay bearer + register it in OutputGuard BEFORE it
  //    leaves this closure (Pitfall 6). Per-replay + ephemeral; torn down below.
  const bearer = (deps.mintBearer ?? defaultMintReplayBearer)();
  deps.outputGuard.registerSecret(bearer);

  // 3. Resolve a fresh 0600 socket path + the run workspace, and start the
  //    separate replay socket, never the production endpoint.
  const socketPath = (deps.resolveReplaySocketPath ?? defaultResolveReplaySocketPath)(runId);
  const createReplaySocket =
    deps.createReplaySocket ?? ((d) => createOrchestrateReplaySocket(d));
  const socket = createReplaySocket({
    recordingRootPath: deps.recordingRootPath,
    runId: row.checkpointId,
    expectedBearer: bearer,
    logger: deps.logger,
  });
  await socket.start(socketPath);

  try {
    // 4. Re-spawn the PINNED bytes with COMIS_ORCH_SOCKET pointed at the replay
    //    socket. The operator supplies no script.
    const childEnv = buildReplayChildEnv(socketPath, bearer);
    const respawnResult = await deps.respawn({
      rootRunId: runId,
      workspacePath,
      socketPath,
      bearer,
      childEnv,
      principal: {
        agentId: row.agentId,
        sessionKey: row.sessionKey,
        ownerTenantId: row.ownerTenantId,
        ownerUserId: row.ownerUserId,
        deliveryOrigin: row.deliveryOrigin,
        trustLevel: row.trustLevel,
        caps: row.caps,
      },
    });
    const stdout = respawnResult.stdout;
    // The production respawn only captures stdout — a child-side cap-call
    // divergence is signalled over the socket as {error}, which the respawn cannot
    // observe. Read the separate replay socket's sticky flag AFTER the re-spawn has
    // settled (every cap call has been served) and OR it with any flag the respawn
    // itself set (an alt/test seam), so a diverged replay is reported honestly
    // instead of as a clean success.
    const diverged = (respawnResult.diverged ?? false) || socket.diverged();
    // §2.7: content-free completion line — a stdout BYTE COUNT + the divergence
    // flag + method only, never the stdout body or the bearer.
    log.info(
      {
        method: "orchestrate.replay",
        stdoutBytes: Buffer.byteLength(stdout, "utf8"),
        diverged,
      },
      "Orchestrate replay complete",
    );
    return diverged ? { stdout, diverged: true } : { stdout };
  } finally {
    // 5. Tear the ephemeral socket down regardless of the re-spawn outcome
    //    so the bearer and socket live only for this single replay.
    await socket.close();
  }
}
