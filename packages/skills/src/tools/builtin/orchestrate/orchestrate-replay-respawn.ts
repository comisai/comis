// SPDX-License-Identifier: Apache-2.0
// @allow-throw: the deterministic-replay re-spawn seam. It THROWS a content-free
// error on a validation/jail-unavailable failure and lets runScriptWithOneShotRepair's
// bounded run error propagate — the daemon's runOrchestrateReplaySession wraps this
// in a try/finally (socket teardown) and rpc-dispatch converts the throw to a
// JSON-RPC error (mirrors the orchestrate runner's throwToolError boundary).
/**
 * `createOrchestrateReplayRespawn` — the sandbox-backed pinned-byte re-spawn that
 * `comis orchestrate replay <runId>` drives. It re-runs a durable orchestrate
 * run's PINNED script bytes in the SAME jail envelope a live run uses, but with
 * `COMIS_ORCH_SOCKET` pointed at the separate operator replay socket so
 * the recorded results are served back deterministically — never the production
 * capability endpoint.
 *
 * It composes the SHIPPED primitives verbatim (never a fork of the jail logic):
 *   - {@link loadResumeSpec} — resolve the PINNED bytes (the sole source; the
 *     the operator supplies no script);
 *   - the SAME `defaultResolveJailNode`/`defaultResolveJailPython`/
 *     `defaultResolveJailAgentCli` resolvers + `SDK_ASSETS` copy + `scrubSecretEnv`
 *     + `sandbox.buildArgs` the runner uses (so the replay jail is byte-identical);
 *   - {@link runScriptWithOneShotRepair} with NO repair seam — a deterministic
 *     replay must re-run the EXACT pinned bytes (a regenerated script would break
 *     byte-identity).
 *
 * The real bwrap byte-identical round-trip is the `.linux`/VPS tier; this seam's
 * Logic (pinned-byte load, isolated socket target, honest degradation) is unit-
 * testable with an injected spawn.
 *
 * @module
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { safePath, type ComisLogger } from "@comis/core";

import {
  SDK_ASSETS,
  defaultResolveJailAgentCli,
  defaultResolveJailNode,
  defaultResolveJailPython,
  defaultSpawn,
  scrubSecretEnv,
} from "./orchestrate-tool.js";
import {
  defaultOrchestrateDurableFs,
  loadResumeSpec,
  type OrchestrateDurableRuns,
  type ResumePrincipal,
} from "./orchestrate-durable.js";
import { runScriptWithOneShotRepair, type OrchestrateSpawnFn } from "./orchestrate-repair.js";
import { closeSeccompProfileFd, loadSeccompProfileFd } from "../sandbox/seccomp-profile.js";
import type {
  JailAgentCliResolution,
  JailNodeResolution,
  JailPythonResolution,
  SandboxProvider,
} from "../sandbox/types.js";

/** Default hard wall-clock timeout (ms) for a replay re-spawn. */
const DEFAULT_REPLAY_TIMEOUT_MS = 60_000;

/**
 * The input one deterministic replay hands the re-spawn — the validated root run
 * id, the run's jailed workspace, the bound SEPARATE replay socket path, the
 * ephemeral bearer, and the child env with `COMIS_ORCH_SOCKET`/`COMIS_CAP_LEASE`
 * already pointed at the replay socket + bearer (built by the daemon caller).
 * Structurally matches the daemon's `OrchestrateReplayRespawnInput`.
 */
export interface OrchestrateReplayRespawnInput {
  readonly rootRunId: string;
  readonly workspacePath: string;
  readonly socketPath: string;
  readonly bearer: string;
  readonly childEnv: Record<string, string | undefined>;
  /** Persisted execution identity, supplied by the operator-authenticated replay handler. */
  readonly principal: ResumePrincipal;
}

/** The re-spawn closure: re-run the pinned bytes against the replay socket → stdout. */
export type OrchestrateReplayRespawnFn = (
  input: OrchestrateReplayRespawnInput,
) => Promise<{ stdout: string; diverged?: boolean }>;

/** Deps for {@link createOrchestrateReplayRespawn} (the composition root assembles it). */
export interface OrchestrateReplayRespawnDeps {
  /** The OS sandbox provider — the SAME one the orchestrate runner jails with. */
  readonly sandbox: SandboxProvider;
  /** The durable-run store resolves the execution checkpoint's pinned scriptRef. */
  readonly durableRuns: OrchestrateDurableRuns;
  /** Structured logger. */
  readonly logger: ComisLogger;
  /** The inherited base env the child scrubs (the lease/socket ride the caller's childEnv). */
  readonly baseEnv?: Record<string, string | undefined>;
  /** The built module dir holding the SDK assets (defaults to this module's dir). */
  readonly sdkAssetsDir?: string;
  /** Replay wall-clock timeout (ms). */
  readonly replayTimeoutMs?: number;
  /** Test seam: the child spawn (defaults to the real production spawn). */
  readonly spawnFn?: OrchestrateSpawnFn;
  /** Test seam: the jail-node resolver (defaults to the runner's real resolver). */
  readonly resolveJailNodeFn?: () => JailNodeResolution;
  /** Test seam: the jail-python resolver (defaults to the runner's real resolver). */
  readonly resolveJailPythonFn?: () => JailPythonResolution;
  /** Test seam: the comis-agent CLI resolver (defaults to the runner's real resolver). */
  readonly resolveJailAgentCliFn?: () => JailAgentCliResolution;
  /** Test seam: the seccomp-fd loader (defaults to the real loader; null on macOS). */
  readonly loadSeccompFdFn?: () => number | null;
}

/**
 * Build the deterministic-replay re-spawn closure. Assembled once at the daemon
 * composition root (it needs the sandbox provider) and threaded into the
 * `orchestrate.replay` RPC's `OrchestrateReplayWiring.respawn`.
 */
export function createOrchestrateReplayRespawn(
  deps: OrchestrateReplayRespawnDeps,
): OrchestrateReplayRespawnFn {
  const log = deps.logger.child({ submodule: "orchestrate-replay-respawn" });
  const spawnFn = deps.spawnFn ?? defaultSpawn;
  const resolveNode = deps.resolveJailNodeFn ?? defaultResolveJailNode;
  const resolvePython = deps.resolveJailPythonFn ?? defaultResolveJailPython;
  const loadSeccompFd = deps.loadSeccompFdFn ?? loadSeccompProfileFd;
  const sdkAssetsDir = deps.sdkAssetsDir ?? dirname(fileURLToPath(import.meta.url));
  const resolveAgentCli =
    deps.resolveJailAgentCliFn ?? (() => defaultResolveJailAgentCli(sdkAssetsDir));
  const replayTimeoutMs = deps.replayTimeoutMs ?? DEFAULT_REPLAY_TIMEOUT_MS;

  return async ({ rootRunId, workspacePath, socketPath, childEnv, principal }) => {
    // 1. Load the PINNED bytes (the sole source — the operator supplies no script).
    const loaded = await loadResumeSpec(deps.durableRuns, defaultOrchestrateDurableFs, {
      resumeRunId: rootRunId,
      workspacePath,
      principal,
    });
    if (!loaded.ok) {
      throw new Error(`orchestrate replay: ${loaded.error}`);
    }
    const { scriptRef, scriptBytes, language } = loaded.value;
    // The original agent workspace is input-only. Stage the pinned script + SDK
    // into a fresh host directory that is RO-bound into the replay jail, then
    // remove it regardless of spawn outcome.
    const replayWorkspacePath = mkdtempSync(safePath(tmpdir(), "comis-replay-run-"));

    try {
      // 2. Copy the committed SDK + runtime shim into the throwaway stage so the
      //    pinned script's imports resolve without writing into the live workspace.
      for (const asset of SDK_ASSETS) {
        copyFileSync(safePath(sdkAssetsDir, asset), safePath(replayWorkspacePath, asset));
      }
      const scriptPath = safePath(replayWorkspacePath, scriptRef);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safePath-confined throwaway replay stage.
      mkdirSync(dirname(scriptPath), { recursive: true });

      // 3. Resolve the jail node / interpreter / CLI — honest-degrade (throw) on an
      //    unavailable jail; never a quiet host-side run outside the jail.
      const seccompFd = loadSeccompFd();
      try {
        const jailNode = resolveNode();
        if (jailNode.mode === "unavailable") {
          throw new Error(`orchestrate replay jail unavailable: ${jailNode.hint}`);
        }
        let interp: string;
        if (language === "py") {
          const jailPython = resolvePython();
          if (jailPython.mode === "unavailable") {
            throw new Error(`orchestrate replay 'py' surface unavailable: ${jailPython.hint}`);
          }
          interp = jailPython.pythonBin;
        } else {
          interp = jailNode.mode === "bind" ? jailNode.execPath : "node";
        }
        const jailAgentCli = resolveAgentCli();

        // 4. The disposable workspace is RO-bound. Writable temp is the sandbox's
        //    private /tmp, never the original workspace or daemon recording root.
        const args = deps.sandbox.buildArgs({
          workspacePath: replayWorkspacePath,
          workspaceReadOnly: true,
          sharedPaths: [],
          readOnlyPaths: [],
          cwd: replayWorkspacePath,
          tempDir: "/tmp",
          network: { mode: "cap-socket", capSocketPath: socketPath },
          seccompFd,
          jailNode,
          jailAgentCli,
        });
        const bin = args[0]!;
        const spawnArgs = [...args.slice(1), "/bin/bash", "-c", `${interp} ${scriptRef}`];

        // 5. Env: scrub the base, set COMIS_AGENT_BIN when the CLI is bound, THEN merge
        //    the caller's childEnv LAST so COMIS_ORCH_SOCKET (→ the replay socket) +
        //    COMIS_CAP_LEASE (the ephemeral bearer) always win.
        const env: Record<string, string | undefined> = scrubSecretEnv(deps.baseEnv ?? {});
        if (jailAgentCli.mode === "bind") {
          env.COMIS_AGENT_BIN = jailAgentCli.binPath;
        }
        Object.assign(env, childEnv);

        // 6. Re-spawn the PINNED bytes. The host writes them before spawn; the child
        //    sees the completed throwaway stage read-only and cannot persist changes.
        const stdout = await runScriptWithOneShotRepair({
          spawnFn,
          bin,
          spawnArgs,
          childEnv: env,
          scriptPath,
          timeoutMs: replayTimeoutMs,
          script: scriptBytes,
          language,
          capabilityClass: undefined,
          repairSeam: undefined,
          log,
          runId: rootRunId,
        });
        log.info(
          { rootRunId, step: "replay-respawn-complete", stdoutBytes: stdout.length },
          "orchestrate replay re-spawn complete",
        );
        return { stdout };
      } finally {
        // Always close the inherited seccomp fd (null-safe + double-close-safe).
        closeSeccompProfileFd(seccompFd);
      }
    } finally {
      rmSync(replayWorkspacePath, { recursive: true, force: true });
    }
  };
}
