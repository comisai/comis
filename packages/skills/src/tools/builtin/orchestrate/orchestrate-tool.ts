// SPDX-License-Identifier: Apache-2.0
// @allow-throw: the orchestrate runner honest-degrades on an unavailable jail
// and on a failed jailed child via throwToolError / Error — both are caught
// by the AgentTool execution boundary (agent-loop) and surfaced as a tool error.
/**
 * `orchestrate-tool` — the `orchestrate` runner. The
 * headline autonomy primitive: the model writes ONE script that chains
 * capability-scoped typed tools (the committed `comis_tools` SDK) in a jailed
 * child, and only size-bounded stdout re-enters context — a search→fetch→
 * synthesize chain in one inference turn, with intermediate results riding
 * ResultRefs (queried in-jail) rather than the transcript.
 *
 * It composes the SHIPPED substrate, adding NO new sandbox primitive:
 *   - the bwrap cap-socket jail (`BwrapProvider.buildArgs` with
 *     `network:{mode:"cap-socket"}` → `--unshare-net` + the cap socket `--bind`;
 *     `~/.comis` is masked by construction — the jail binds only the workspace +
 *     `SYSTEM_RO_PATHS`, never the data dir).
 *   - `resolveJailNode` for the honest-degrade: no `node`/`bwrap`
 *     inside the jail → a loud precondition error, NEVER a quiet host-side run
 *     outside the jail.
 *   - the committed `comis_tools.{d.ts,js}` SDK + the
 *     `orchestrate-sdk-runtime.js` shim, copied into the workspace so
 *     the script can `import "./comis_tools.js"`.
 *   - the `result-ref-store` run lifecycle — the runner owns
 *     `cleanupRun` in a `finally`.
 *   - `createToolResultSizeGuard` (@comis/agent) for the stdout size-bounce.
 *
 * Env-scrub: the inherited/base env is filtered through
 * {@link scrubSecretEnv} (drop any `*KEY* / *TOKEN* / *SECRET*` key) BEFORE the
 * daemon-injected lease vars (`COMIS_CAP_LEASE`/`COMIS_ORCH_SOCKET`) are merged —
 * the lease vars ride `brokerSpawnEnv.placeholders`, merged LAST, so they survive
 * the scrub by construction. A host secret can never leak into the
 * jailed (attacker-controlled) child; the lease the SDK authenticates with always
 * does.
 *
 * The arg-gen / env-scrub / SDK-write / size-bounce are macOS-unit-testable (the
 * spawn + jail-node resolution are injected seams); the real-bwrap stdout-only /
 * `~/.comis`-mask / `--unshare-net`-egress-cut is the `orchestrate-jail.linux.test.ts`
 * proof (skip-on-macOS, run on the VPS via `pnpm validate:full`).
 *
 * @module
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import {
  registerActivityLabelSpec,
  safePath,
  systemClearTimeout,
  systemNowMs,
  systemSetTimeout,
  type ComisLogger,
  type SystemTimeoutHandle,
} from "@comis/core";
import { createToolResultSizeGuard } from "@comis/agent";

import { resolveJailAgentCli, resolveJailNode, SYSTEM_RO_PATHS } from "../sandbox/bwrap-provider.js";
import type {
  JailAgentCliResolution,
  JailNodeResolution,
  SandboxProvider,
} from "../sandbox/types.js";
import { loadSeccompProfileFd, closeSeccompProfileFd } from "../sandbox/seccomp-profile.js";
import { throwToolError } from "../../../platform-tools/tool-helpers.js";
import type { CleanupRunContext, GcRunContext, MaterializeContext } from "./result-ref-store.js";
import type { ResultRef } from "@comis/core";

// Activity label (channel render): the descriptor name equals the emitted tool
// name (`"orchestrate"`). A static fallback so the render is not the bare
// humanized form while the script runs.
registerActivityLabelSpec("orchestrate", {
  semanticPhase: "tool",
  label: "running an orchestrate script",
});

// ---------------------------------------------------------------------------
// Parameter schema.
// ---------------------------------------------------------------------------

const OrchestrateParams = Type.Object({
  script: Type.String({
    description:
      "The script body to run in the jailed child. It may `import { comis_tools } from \"./comis_tools.js\"` and chain the capability-scoped tools; only what it console.logs (stdout) re-enters context.",
  }),
  language: Type.Union([Type.Literal("ts"), Type.Literal("js")], {
    description: 'The script language: "ts" or "js".',
  }),
  timeoutMs: Type.Optional(
    Type.Integer({ description: "Hard wall-clock timeout for the jailed run (ms). Default 60000." }),
  ),
  captureStdout: Type.Optional(
    Type.Boolean({ description: "Reserved — stdout is always the (only) captured channel." }),
  ),
});

type OrchestrateParamsType = {
  script: string;
  language: "ts" | "js";
  timeoutMs?: number;
  captureStdout?: boolean;
};

// ---------------------------------------------------------------------------
// Injected seams + deps.
// ---------------------------------------------------------------------------

/** The bits of a spawned child the runner consumes (a `child_process` subset). */
export interface OrchestrateSpawnedChild {
  readonly stdout: { on(event: "data", cb: (chunk: Buffer) => void): void } | null;
  readonly stderr: { on(event: "data", cb: (chunk: Buffer) => void): void } | null;
  on(event: "close", cb: (code: number | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

/** The spawn seam — injected so the macOS unit suite runs WITHOUT a real spawn. */
export type OrchestrateSpawnFn = (
  bin: string,
  args: string[],
  opts: { env: Record<string, string | undefined>; cwd?: string },
) => OrchestrateSpawnedChild;

/** Minimal store surface the runner needs (the runner owns the run lifecycle). */
export interface OrchestrateResultStore {
  materialize(
    payload: string | Buffer,
    toolName: string,
    ctx: MaterializeContext,
  ): Promise<ResultRef | { error: string } | undefined>;
  gcRun(ctx: GcRunContext): Promise<void>;
  cleanupRun(ctx: CleanupRunContext): Promise<void>;
}

/** Dependencies for the orchestrate runner (AGENTS.md §2.4 — injected). */
export interface OrchestrateToolDeps {
  /** Structured logger — instruments the boundary crossing (model → jailed child). */
  readonly logger: ComisLogger;
  /** Resolve the agent's jailed workspace path (the writable jail root). */
  readonly workspaceResolver: () => string;
  /**
   * The cap socket bound into the jail (`network:{mode:"cap-socket", capSocketPath}`).
   * Daemon-minted per-run path (conventionally `/run/comis` or the data dir) —
   * the daemon wiring threads it from the kept endpoint handle.
   */
  readonly capSocketPath: string;
  /** The platform sandbox provider (BwrapProvider on Linux) — the arg generator. */
  readonly sandbox: SandboxProvider;
  /**
   * The daemon-injected lease-env carrier. `placeholders` (COMIS_CAP_LEASE /
   * COMIS_ORCH_SOCKET) are merged AFTER the secret-scrub so they survive it.
   * Optional: when absent the child gets no lease (the SDK calls
   * would then fail their precondition — never a silent unauthenticated run).
   */
  readonly brokerSpawnEnv?: { readonly placeholders: Record<string, string> };
  /** The ResultRef store — the runner owns `cleanupRun` on run end. */
  readonly store: OrchestrateResultStore;
  /** The directory holding the committed SDK assets to copy into the jail. */
  readonly sdkAssetsDir?: string;
  /** The spawn seam (default `node:child_process.spawn`). */
  readonly spawnFn?: OrchestrateSpawnFn;
  /** The jail-node resolver (default the real `resolveJailNode`). */
  readonly resolveJailNodeFn?: () => JailNodeResolution;
  /**
   * The comis-agent CLI-binary resolver (default `defaultResolveJailAgentCli`,
   * which resolves the dist entry + reads the committed manifest sha via
   * `import.meta.url` and calls `resolveJailAgentCli`). A missing or
   * tampered binary makes ONLY the CLI surface unavailable (a loud WARN, no bind,
   * no COMIS_AGENT_BIN) — the orchestrate SCRIPT surface still runs.
   */
  readonly resolveJailAgentCliFn?: () => JailAgentCliResolution;
  /** The seccomp-fd loader (default the real `loadSeccompProfileFd`; null on macOS). */
  readonly loadSeccompFdFn?: () => number | null;
  /** Injected wall clock (default `systemNowMs`). */
  readonly now?: () => number;
  /**
   * The base/inherited env to scrub. REQUIRED — the daemon wiring
   * supplies the inherited env explicitly, so the runner never reads
   * an ambient global (AGENTS.md §2.2). The lease vars are added separately via
   * {@link brokerSpawnEnv}, merged AFTER the scrub.
   */
  readonly baseEnv: Record<string, string | undefined>;
  /**
   * The per-run child-lease mint seam (D5, EXPLAIN-01). When present, the
   * runner mints a short-TTL CHILD lease per run and injects the returned
   * `bearer` as `COMIS_CAP_LEASE` — OVERRIDING the assembly bearer that rides
   * {@link brokerSpawnEnv}. The child lease shares the assembly's `rootRunId`
   * (tree accounting untouched) with `parentLeaseId` = the assembly lease and
   * TTL clamped to `timeoutMs`, so every in-jail cap call for the run audits
   * under this run's `leaseId` (the INV-1 per-run correlator). Minted daemon-side
   * and threaded as a plain closure — the runner never imports the LeaseManager.
   * Absent (older wiring) → the assembly bearer authenticates (no per-run mint;
   * never an unauthenticated run).
   */
  readonly mintRunLease?: (runId: string, timeoutMs: number) => { leaseId: string; bearer: string };
}

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

/** The SDK asset filenames copied into the jail workspace. */
const SDK_ASSETS = ["comis_tools.d.ts", "comis_tools.js", "orchestrate-sdk-runtime.js"] as const;

/** The comis-built comis-agent entry that is sha256-pinned + RO-bound. */
const COMIS_AGENT_ENTRY_FILENAME = "comis-agent-entry.js";

/** The committed manifest (rides into dist via the asset-copy) holding the pin. */
const COMIS_AGENT_MANIFEST_FILENAME = "comis-agent-manifest.json";

/** Max stdout characters that re-enter context — the rest is size-bounced. */
const STDOUT_MAX_CHARS = 30_000;

/**
 * The hard in-stream ceiling on the daemon-side stdout collector. The
 * `STDOUT_MAX_CHARS` bounce only runs AFTER the child exits, so without this an
 * unbounded jailed `console.log` flood grows the daemon heap for the whole run.
 * A few × `STDOUT_MAX_CHARS` (4 MiB) leaves ample headroom for a legitimate
 * large result while bounding memory; past it the runner SIGKILLs the child and
 * fails closed. Exported so the bound is unit-testable.
 */
export const STDOUT_HARD_CAP_BYTES = 4 * 1024 * 1024;

/**
 * Max chars of the jailed child's stderr retained as a diagnostic TAIL. On the
 * success path stderr is dropped (stdout-only — diagnostic noise stays out of
 * context); on a NON-ZERO exit this bounded tail is the only signal of WHY the
 * child died (a thrown `TypeError`, a bad import, a comis_tools misuse) and is
 * surfaced in the rejection so the failure is diagnosable without a re-run.
 * Bounded so a stderr flood can neither
 * grow the daemon heap nor swamp the error/context. The surfaced tail still
 * passes the daemon OutputGuard on egress, and the jail env is secret-scrubbed.
 */
const STDERR_TAIL_MAX_CHARS = 2_000;

/** Default hard timeout for a jailed run (ms). Exported for the clamp tests. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * The hard ceiling on a model-supplied `timeoutMs`. The schema accepts
 * any positive integer, so without this a jailed (attacker-controlled) script
 * could request `timeoutMs: 999_999_999` (~11.5 days) and pin a child for an
 * arbitrarily long window. 10 minutes is far longer than any legitimate
 * search→fetch→synthesize chain needs while staying bounded.
 */
export const MAX_TIMEOUT_MS = 10 * 60_000;

/** The per-run aggregate `results/` budget passed to the store's GC. */
const PER_RUN_AGGREGATE_CAP_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Pure exported helper — the env-scrub (macOS-unit-testable).
// ---------------------------------------------------------------------------

/**
 * Matches any env key that could carry a credential. Covers
 * the obvious `KEY/TOKEN/SECRET` names PLUS common credential names that contain
 * none of those substrings (`PASSWORD`, `PASSPHRASE`, `CREDENTIAL(S)`,
 * `PRIVATE`, `BEARER`, `AUTH`, a `_PAT` suffix, `DSN`). `_PAT\b` is anchored so
 * it matches `GITHUB_PAT` but NOT `PATH` (which would match a bare `PAT`). This
 * is defense-in-depth — the orchestrate base env is the credential-free
 * `execToolEnv` today — but it keeps the scrub honest as the documented
 * credential boundary under any future wiring change.
 */
const SECRET_KEY_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|PRIVATE|BEARER|AUTH|_PAT\b|DSN/i;

/**
 * Filter a base/inherited env map for the jailed child: drop every key
 * matching `*KEY* / *TOKEN* / *SECRET*` (case-insensitive) and every undefined
 * value, returning a clean `Record<string,string>`.
 *
 * This runs over the BASE env ONLY — the daemon-injected lease vars
 * (`COMIS_CAP_LEASE`/`COMIS_ORCH_SOCKET`) are merged AFTER this scrub (they ride
 * `brokerSpawnEnv.placeholders`), so they survive by construction.
 * Keeping the scrub a pure function over the base map makes the survival property
 * unit-testable on macOS with no real spawn.
 *
 * @param base - The inherited/base env (e.g. the ambient process env).
 * @returns A new map with secret-named and undefined entries removed.
 */
export function scrubSecretEnv(
  base: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (SECRET_KEY_PATTERN.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Resolve the effective jailed-run wall-clock timeout from a model-supplied
 * value: a non-positive / non-numeric request falls back to
 * {@link DEFAULT_TIMEOUT_MS}; any larger request is clamped down to
 * {@link MAX_TIMEOUT_MS}. Pure so the bound is unit-testable with no spawn.
 *
 * @param requested - The `params.timeoutMs` (ms) the model supplied, if any.
 * @returns A bounded timeout in `[1, MAX_TIMEOUT_MS]`.
 */
export function clampTimeoutMs(requested: number | undefined): number {
  const base =
    typeof requested === "number" && requested > 0 ? requested : DEFAULT_TIMEOUT_MS;
  return Math.min(base, MAX_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------

/**
 * Create the `orchestrate` AgentTool. See the module doc for the
 * composition + the containment guarantees.
 *
 * @param deps - The injected collaborators (workspace, cap socket, sandbox,
 *   store, and the test seams).
 * @returns The `orchestrate` AgentTool.
 */
export function createOrchestrateTool(deps: OrchestrateToolDeps): AgentTool<typeof OrchestrateParams> {
  const log = deps.logger.child({ submodule: "orchestrate-tool" });
  const spawnFn = deps.spawnFn ?? defaultSpawn;
  const resolveNode = deps.resolveJailNodeFn ?? defaultResolveJailNode;
  const loadSeccompFd = deps.loadSeccompFdFn ?? loadSeccompProfileFd;
  const now = deps.now ?? systemNowMs;
  const sdkAssetsDir = deps.sdkAssetsDir ?? dirname(fileURLToPath(import.meta.url));
  const resolveAgentCli =
    deps.resolveJailAgentCliFn ?? (() => defaultResolveJailAgentCli(sdkAssetsDir));

  return {
    name: "orchestrate",
    label: "Orchestrate",
    description:
      "Run a script that chains capability-scoped tools (the comis_tools SDK) in a single jailed child, returning only its stdout. Use to collapse a multi-tool read/fetch/synthesize chain into one turn; intermediate high-volume results stay on disk as ResultRefs (sliced in-jail), never in context.",
    parameters: OrchestrateParams,

    async execute(
      _toolCallId: string,
      params: OrchestrateParamsType,
    ): Promise<AgentToolResult<unknown>> {
      const startedMs = now();
      const runId = `orch-${startedMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const workspacePath = deps.workspaceResolver();
      // Bound the model-supplied timeout (fallback default, clamp ceiling)
      // so a jailed script cannot pin a child for an arbitrarily long window.
      const timeoutMs = clampTimeoutMs(params.timeoutMs);
      // The per-run child leaseId (D5) — captured for downstream attribution
      // (Plan 04 reads it for the run_summary emit). Undefined when no
      // mintRunLease seam is wired (the assembly bearer authenticates instead).
      let childLeaseId: string | undefined;

      log.debug({ runId, step: "start", language: params.language }, "orchestrate run starting");

      // Resolve the seccomp fd ONCE, BEFORE the try (see the fd-lifecycle
      // contract in seccomp-profile.ts). The fd is opened WITHOUT O_CLOEXEC so the bwrap child inherits
      // it — the parent (daemon) keeps its OWN copy after fork and MUST close it
      // in the finally below, or every jailed run leaks one descriptor and a
      // long-running daemon exhausts its fd table. Opening it here (not inside
      // the try) means the finally always closes it even when writeFileSync /
      // copyFileSync / resolveNode throws (those run after this point today, so
      // a throw there would otherwise leak the fd). Null on macOS (blob absent →
      // no --seccomp); closeSeccompProfileFd is null-safe + double-close-safe.
      const seccompFd = loadSeccompFd();

      try {
        // 1. Write the model's script verbatim into the jailed workspace.
        const scriptName = `${runId}.${params.language}`;
        const scriptPath = safePath(workspacePath, scriptName);
        writeFileSync(scriptPath, params.script);

        // 2. Copy the committed SDK + the runtime shim so the script can
        //    `import "./comis_tools.js"` (which imports ./orchestrate-sdk-runtime.js).
        for (const asset of SDK_ASSETS) {
          copyFileSync(safePath(sdkAssetsDir, asset), safePath(workspacePath, asset));
        }
        log.debug({ runId, step: "sdk-written" }, "script + SDK written to workspace");

        // 3. Honest-degrade: resolve the jail node; refuse on unavailable —
        //    NEVER a quiet host-side run outside the jail.
        const jailNode = resolveNode();
        if (jailNode.mode === "unavailable") {
          log.warn(
            { runId, errorKind: "precondition" as const, hint: jailNode.hint },
            "orchestrate jail unavailable — refusing to run",
          );
          throwToolError(
            "not_implemented",
            "The orchestrate jail is unavailable on this host (no node/bwrap inside the jail).",
            { hint: jailNode.hint },
          );
        }

        // 3b. Honest-degrade for the CLI surface: resolve the sha256-pinned
        //     comis-agent binary. UNLIKE the node resolve, an unavailable
        //     (missing/tampered) binary does NOT refuse the whole jail — it
        //     degrades ONLY the comis-agent CLI surface (the orchestrate SCRIPT
        //     surface is independent and still runs). A LOUD content-free WARN
        //     names the cause; we then omit the bind + COMIS_AGENT_BIN (never a
        //     silent bind of a missing/tampered binary).
        const jailAgentCli = resolveAgentCli();
        if (jailAgentCli.mode === "unavailable") {
          log.warn(
            { runId, errorKind: "precondition" as const, hint: jailAgentCli.hint },
            "comis-agent CLI surface unavailable inside the jail (the orchestrate script surface still works)",
          );
        }

        // 4. Build the cap-socket jail args (--unshare-net + the cap socket
        //    --bind + the workspace-only FS; ~/.comis is never bound → masked).
        //    The provider binds the curated SYSTEM_RO_PATHS itself (so jq + node
        //    resolve); we pass NO extra readOnlyPaths (mirrors the cap-socket
        //    .linux.test) — re-listing them here would route the curated
        //    allow-list through the provider's read-only-path discovery screen
        //    (a false-positive on /etc/* paths that resolve into a blocked dir
        //    on some hosts). `jailAgentCli` is passed verbatim — buildArgs
        //    RO-binds the binary ONLY on mode "bind", omits it otherwise.
        // The jail `--bind`s `<workspace>/.tmp` as its writable temp; bwrap requires
        // the bind SOURCE to exist, so create it BEFORE building the args. A missing
        // `.tmp` makes bwrap fail at construction with "Can't find source path
        // …/.tmp" → exit 1 on EVERY real jailed run (invisible to the macOS unit
        // suite, which injects a fake spawn). Guarded by
        // orchestrate-tool.test.ts.
        const tempDir = safePath(workspacePath, ".tmp");
        mkdirSync(tempDir, { recursive: true });
        const args = deps.sandbox.buildArgs({
          workspacePath,
          sharedPaths: [],
          readOnlyPaths: [],
          cwd: workspacePath,
          tempDir,
          network: { mode: "cap-socket", capSocketPath: deps.capSocketPath },
          seccompFd,
          jailNode,
          jailAgentCli,
        });
        // The jailed command runs the script with node, from the workspace cwd.
        // In BIND mode the daemon's node is --ro-bind'd at its absolute execPath
        // but is NOT on the jail's scrubbed PATH (e.g. /usr/bin:/bin), so a bare
        // `node` exits 127 (command not found). Invoke it by the resolved absolute
        // path; in PATH mode the bare name resolves off a bound PATH dir. Latent
        // since #236 — surfaced by the CI runner's hostedtoolcache node, which sits
        // outside SYSTEM_RO_PATHS → BIND. Guarded by orchestrate-tool.test.ts.
        const nodeBin = jailNode.mode === "bind" ? jailNode.execPath : "node";
        const command = `${nodeBin} ${scriptName}`;
        const bin = args[0]!;
        const spawnArgs = [...args.slice(1), "/bin/bash", "-c", command];

        // 5. Env: the secret scrub over the BASE env, THEN the lease placeholders
        //    merged LAST (so they survive the scrub by construction).
        const childEnv: Record<string, string | undefined> = scrubSecretEnv(deps.baseEnv);
        if (deps.brokerSpawnEnv) {
          Object.assign(childEnv, deps.brokerSpawnEnv.placeholders);
        }
        // 5a. Per-run child lease (D5): when the daemon threads the mint seam,
        //     mint a short-TTL CHILD bearer for THIS run and inject it as
        //     COMIS_CAP_LEASE — OVERRIDING the assembly bearer merged just above.
        //     Every in-jail cap call then audits under this run's leaseId (the
        //     INV-1 per-run correlator). Minted here (step 5), AFTER the
        //     honest-degrade refusals (steps 3/3b), so a refused run wastes no
        //     lease. Absent seam → the assembly bearer authenticates (never an
        //     unauthenticated run). The child bearer is registered in OutputGuard
        //     at mint (daemon side), so logging its leaseId (not the bearer) is safe.
        if (deps.mintRunLease) {
          const child = deps.mintRunLease(runId, timeoutMs);
          childLeaseId = child.leaseId;
          childEnv.COMIS_CAP_LEASE = child.bearer;
          log.debug(
            { runId, leaseId: childLeaseId, step: "child-lease" },
            "per-run child lease minted (overrides the assembly bearer)",
          );
        }
        // 5b. Expose COMIS_AGENT_BIN (the in-jail comis-agent path) ONLY
        //     when the binary is bound. It is NOT a secret, so it is set AFTER the
        //     scrub (like the lease vars). On "unavailable" it is intentionally
        //     unset — the in-jail `comis-agent` then has no binary to resolve, the
        //     loud WARN above already announced the scoped degrade.
        if (jailAgentCli.mode === "bind") {
          childEnv.COMIS_AGENT_BIN = jailAgentCli.binPath;
        }

        // 6. Spawn the jailed child; capture stdout ONLY (stderr/intermediate
        //    never re-enter); size-bounce the stdout.
        const stdout = await runJailedChild(
          spawnFn,
          bin,
          spawnArgs,
          { env: childEnv, cwd: undefined },
          timeoutMs,
          { runId, log },
        );

        const bounced = sizeBounceStdout(stdout);
        log.info(
          { runId, step: "complete", durationMs: now() - startedMs, stdoutBytes: stdout.length },
          "orchestrate run complete",
        );
        return { content: bounced, details: { runId, stdoutBytes: stdout.length } };
      } finally {
        // 7. Close the PARENT's copy of the seccomp fd. By the time the
        //    finally runs the child has already inherited it (spawn returned, or
        //    threw — either way the parent's copy is open and must be released).
        //    null-safe + double-close-safe, so this is unconditional. Closing
        //    BEFORE gcRun/cleanupRun guarantees a throwing GC cannot skip it.
        closeSeccompProfileFd(seccompFd);

        // 8. The runner owns the run lifecycle — GC then drop the run's
        //    results/ entries, on success AND on failure.
        try {
          await deps.store.gcRun({
            workspacePath,
            runId,
            aggregateCapBytes: PER_RUN_AGGREGATE_CAP_BYTES,
            nowMs: now(),
          });
        } catch (gcErr) {
          log.warn(
            { runId, errorKind: "resource" as const, err: gcErr instanceof Error ? gcErr : undefined },
            "orchestrate gcRun failed (non-fatal)",
          );
        }
        await deps.store.cleanupRun({ workspacePath, runId });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

/**
 * Drive the jailed child to completion: collect stdout, surface a non-zero exit
 * or a spawn error as a tool error (NEVER a silent success), kill on timeout.
 * stderr is read+discarded (it never re-enters context — stdout-only).
 */
function runJailedChild(
  spawnFn: OrchestrateSpawnFn,
  bin: string,
  args: string[],
  opts: { env: Record<string, string | undefined>; cwd?: string },
  timeoutMs: number,
  ctx: { runId: string; log: ComisLogger },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let child: OrchestrateSpawnedChild;
    try {
      child = spawnFn(bin, args, opts);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stdout = "";
    let stdoutBytes = 0;
    let stderrTail = "";
    let settled = false;
    const timer: SystemTimeoutHandle = systemSetTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      reject(new Error(`orchestrate run exceeded its ${timeoutMs}ms timeout`));
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      // Bound the in-stream accumulation. The post-exit STDOUT_MAX_CHARS
      // bounce does not protect the daemon heap DURING the run, so a jailed
      // `while(true) console.log(...)` flood must be stopped here — fail closed:
      // stop appending, SIGKILL the runaway child, and reject.
      stdoutBytes += chunk.length;
      if (stdoutBytes > STDOUT_HARD_CAP_BYTES) {
        settled = true;
        systemClearTimeout(timer);
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        ctx.log.warn(
          { runId: ctx.runId, errorKind: "resource" as const, stdoutBytes, hint: `Jailed stdout exceeded the ${STDOUT_HARD_CAP_BYTES}B hard cap — the script was killed. Have it write high-volume output to a ResultRef (materialize) and slice it in-jail instead of console.log-ing it.` },
          "orchestrate jailed child exceeded the stdout hard cap — killed",
        );
        reject(new Error(`orchestrate stdout exceeded the ${STDOUT_HARD_CAP_BYTES}B hard cap`));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    // Read stderr but keep only a BOUNDED TAIL — it cannot back-pressure the child
    // and never re-enters context on the SUCCESS path (stdout-only). But on a
    // NON-ZERO exit the tail is the only signal of WHY the child died, so the close
    // handler surfaces it in the rejection (otherwise the failure is just
    // "exited with code N" and undiagnosable without a re-run).
    child.stderr?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_MAX_CHARS);
    });
    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      systemClearTimeout(timer);
      reject(err);
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      systemClearTimeout(timer);
      if (code !== 0 && code !== null) {
        const tail = stderrTail.trim();
        ctx.log.warn(
          {
            runId: ctx.runId,
            errorKind: "internal" as const,
            exitCode: code,
            stderrTail: tail ? tail.slice(-512) : undefined,
          },
          "orchestrate jailed child exited non-zero",
        );
        reject(
          new Error(
            `orchestrate jailed child exited with code ${code}${tail ? `:\n${tail}` : ""}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

/** A text content block (the only shape the runner returns — stdout-only). */
interface TextBlock {
  type: "text";
  text: string;
}

/** Size-bounce the raw stdout into bounded text content. */
function sizeBounceStdout(stdout: string): TextBlock[] {
  const guard = createToolResultSizeGuard();
  const result = guard.truncateIfNeeded(
    [{ type: "text", text: stdout }],
    STDOUT_MAX_CHARS,
    "orchestrate stdout",
  );
  // The guard preserves the {type:"text", text} shape; map to the narrow block.
  return result.content.map((b) => ({ type: "text" as const, text: b.text ?? "" }));
}

/** The default real spawn (the unit suite injects `spawnFn`; this is production). */
const defaultSpawn: OrchestrateSpawnFn = (bin, args, opts) =>
  spawn(bin, args, {
    env: opts.env,
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as OrchestrateSpawnedChild;

/** The default jail-node resolver — probe the jail PATH / bind the daemon node. */
function defaultResolveJailNode(): JailNodeResolution {
  return resolveJailNode({ pathDirs: SYSTEM_RO_PATHS, execPath: readExecPath() });
}

/** Read `process.execPath` through a narrow boundary (the daemon's own node). */
function readExecPath(): string {
  return process.execPath;
}

/**
 * The default comis-agent CLI resolver. Resolve the built entry +
 * the committed manifest from `assetDir` (the built module dir, which carries
 * both via the copy-sandbox-assets step), read the pinned sha, and delegate to
 * `resolveJailAgentCli` (which hash-verifies the bound bytes). When the manifest
 * itself is absent (e.g. an old/partial build), honest-degrade to "unavailable"
 * — the CLI surface is off, the orchestrate SCRIPT surface still runs, NEVER an
 * unverified bind.
 */
function defaultResolveJailAgentCli(assetDir: string): JailAgentCliResolution {
  const manifestPath = safePath(assetDir, COMIS_AGENT_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    return {
      mode: "unavailable",
      hint:
        "The comis-agent manifest is missing from the skills dist — the comis-agent " +
        "CLI surface is UNAVAILABLE inside the jail (the orchestrate SCRIPT surface " +
        "still works). Rebuild (pnpm build) so the manifest + entry ride into dist.",
    };
  }
  // The manifest is a tiny build artifact in the trusted dist dir (not attacker-
  // controlled); parse it for the sha pin. A malformed manifest honest-degrades.
  let expectedSha: string;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { sha256?: unknown };
    if (typeof parsed.sha256 !== "string" || parsed.sha256.length === 0) {
      return {
        mode: "unavailable",
        hint:
          "The comis-agent manifest is malformed (no sha256 pin) — the comis-agent " +
          "CLI surface is UNAVAILABLE (the orchestrate SCRIPT surface still works). " +
          "Regenerate it (pnpm agent-cli:manifest).",
      };
    }
    expectedSha = parsed.sha256;
  } catch {
    return {
      mode: "unavailable",
      hint:
        "The comis-agent manifest could not be read/parsed — the comis-agent CLI " +
        "surface is UNAVAILABLE (the orchestrate SCRIPT surface still works). " +
        "Regenerate it (pnpm agent-cli:manifest).",
    };
  }
  const binPath = safePath(assetDir, COMIS_AGENT_ENTRY_FILENAME);
  return resolveJailAgentCli({ binPath, expectedSha });
}
