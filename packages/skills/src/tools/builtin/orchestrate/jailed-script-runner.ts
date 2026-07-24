// SPDX-License-Identifier: Apache-2.0
// @allow-throw: the jailed-script runner honest-degrades on an unavailable jail
// (throwToolError "not_implemented") and surfaces a failed jailed child via a
// rejected Promise (new Error) — both are caught by the caller (the AgentTool
// execution boundary for the orchestrate tool; the run-shaping layer for any
// other caller) and translated into a tool error / a fail-open decision.
/**
 * `jailed-script-runner` — the shared cap-socket jailed-run core.
 *
 * {@link runJailedScript} drives ONE model-authored (untrusted) script through
 * the shipped bwrap cap-socket jail and returns its RAW stdout, before any
 * result shaping. It is the single callable behind the `orchestrate` tool and is
 * reusable by any other daemon caller that needs the same jail — so there is ONE
 * jail path to keep correct, never a second one drifting from it.
 *
 * It composes the SHIPPED substrate, adding NO new sandbox primitive:
 *   - the bwrap cap-socket jail (`SandboxProvider.buildArgs` with
 *     `network:{mode:"cap-socket"}` → `--unshare-net` + the cap socket `--bind`;
 *     `~/.comis` is masked by construction — the jail binds only the workspace +
 *     `SYSTEM_RO_PATHS`, never the data dir).
 *   - `resolveJailNode` for the honest-degrade: no `node`/`bwrap`
 *     inside the jail → a loud precondition error, NEVER a quiet host-side run
 *     outside the jail.
 *   - the committed `comis_tools.{d.ts,js}` SDK + the
 *     `orchestrate-sdk-runtime.js` shim, copied into the workspace so
 *     the script can `import "./comis_tools.js"`.
 *   - the `result-ref-store` run lifecycle — the runner owns `gcRun` +
 *     `cleanupRun` in a `finally`.
 *
 * Env-scrub: the inherited/base env is filtered through
 * {@link scrubSecretEnv} (drop any `*KEY* / *TOKEN* / *SECRET*` key) BEFORE the
 * daemon-injected lease vars (`COMIS_CAP_LEASE`/`COMIS_ORCH_SOCKET`) are merged —
 * the lease vars ride `brokerSpawnEnv.placeholders`, merged LAST, so they survive
 * the scrub by construction. A host secret can never leak into the
 * jailed (attacker-controlled) child; the lease the SDK authenticates with always
 * does.
 *
 * {@link runJailedScript} returns the raw stdout string on a clean exit and
 * REJECTS on a non-zero exit / SIGKILL-timeout / 4 MiB stdout-overflow / spawn
 * error — the caller shapes the raw stdout (the `orchestrate` tool size-bounces
 * it; a fail-open caller maps a rejection to its safe default).
 *
 * The arg-gen / env-scrub / SDK-write are macOS-unit-testable (the spawn +
 * jail-node resolution are injected seams); the real-bwrap stdout-only /
 * `~/.comis`-mask / `--unshare-net`-egress-cut is the `orchestrate-jail.linux.test.ts`
 * proof (skip-on-macOS, run on the VPS via `pnpm validate:full`).
 *
 * @module
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import {
  safePath,
  systemClearTimeout,
  systemNowMs,
  systemSetTimeout,
  type ComisLogger,
  type ResultRef,
  type SystemTimeoutHandle,
} from "@comis/core";

import { resolveJailAgentCli, resolveJailNode, SYSTEM_RO_PATHS } from "../sandbox/bwrap-provider.js";
import type {
  JailAgentCliResolution,
  JailNodeResolution,
  SandboxProvider,
} from "../sandbox/types.js";
import { loadSeccompProfileFd, closeSeccompProfileFd } from "../sandbox/seccomp-profile.js";
import { throwToolError } from "../../../platform-tools/tool-helpers.js";
import type { CleanupRunContext, GcRunContext, MaterializeContext } from "./result-ref-store.js";

// ---------------------------------------------------------------------------
// Injected seams + deps.
// ---------------------------------------------------------------------------

/** The bits of a spawned child the runner consumes (a `child_process` subset). */
export interface JailedScriptSpawnedChild {
  readonly stdout: { on(event: "data", cb: (chunk: Buffer) => void): void } | null;
  readonly stderr: { on(event: "data", cb: (chunk: Buffer) => void): void } | null;
  on(event: "close", cb: (code: number | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

/** The spawn seam — injected so the macOS unit suite runs WITHOUT a real spawn. */
export type JailedScriptSpawnFn = (
  bin: string,
  args: string[],
  opts: { env: Record<string, string | undefined>; cwd?: string },
) => JailedScriptSpawnedChild;

/** Minimal store surface the runner needs (the runner owns the run lifecycle). */
export interface JailedScriptResultStore {
  materialize(
    payload: string | Buffer,
    toolName: string,
    ctx: MaterializeContext,
  ): Promise<ResultRef | { error: string } | undefined>;
  gcRun(ctx: GcRunContext): Promise<void>;
  cleanupRun(ctx: CleanupRunContext): Promise<void>;
}

/** Dependencies for the jailed-script runner (AGENTS.md §2.4 — injected). */
export interface JailedScriptRunnerDeps {
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
  readonly store: JailedScriptResultStore;
  /** The directory holding the committed SDK assets to copy into the jail. */
  readonly sdkAssetsDir?: string;
  /** The spawn seam (default `node:child_process.spawn`). */
  readonly spawnFn?: JailedScriptSpawnFn;
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

/**
 * The hard in-stream ceiling on the daemon-side stdout collector. The
 * caller's post-exit size-bounce only runs AFTER the child exits, so without this
 * an unbounded jailed `console.log` flood grows the daemon heap for the whole run.
 * A few MiB (4 MiB) leaves ample headroom for a legitimate
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
// The shared jailed-run core.
// ---------------------------------------------------------------------------

/**
 * Run ONE model-authored script through the cap-socket bwrap jail and resolve
 * with its RAW stdout (before any result shaping). REJECTS on a non-zero exit /
 * SIGKILL-timeout / 4 MiB stdout-overflow / spawn error, and honest-degrades
 * (throws) when the jail itself is unavailable — the caller catches and shapes.
 *
 * @param deps - The injected collaborators (workspace, cap socket, sandbox,
 *   store, base env, and the test seams).
 * @param params - The script + language, an optional bounded `timeoutMs`, and an
 *   optional `runId`. When `runId` is supplied the SAME id threads through the
 *   script filename, the store GC/cleanup, and the internal logs (so a shaping
 *   layer can correlate its own logs/result); otherwise one is generated.
 * @returns The raw stdout string on a clean exit.
 */
export async function runJailedScript(
  deps: JailedScriptRunnerDeps,
  params: {
    script: string;
    language: "ts" | "js";
    timeoutMs?: number;
    runId?: string;
    signal?: AbortSignal;
  },
): Promise<string> {
  const log = deps.logger.child({ submodule: "orchestrate-tool" });
  const spawnFn = deps.spawnFn ?? defaultSpawn;
  const resolveNode = deps.resolveJailNodeFn ?? defaultResolveJailNode;
  const loadSeccompFd = deps.loadSeccompFdFn ?? loadSeccompProfileFd;
  const now = deps.now ?? systemNowMs;
  const sdkAssetsDir = deps.sdkAssetsDir ?? dirname(fileURLToPath(import.meta.url));
  const resolveAgentCli =
    deps.resolveJailAgentCliFn ?? (() => defaultResolveJailAgentCli(sdkAssetsDir));

  const workspacePath = deps.workspaceResolver();
  // Bound the model-supplied timeout (fallback default, clamp ceiling)
  // so a jailed script cannot pin a child for an arbitrarily long window.
  const timeoutMs = clampTimeoutMs(params.timeoutMs);
  // Use the caller-supplied run id when present (so a shaping layer threads the
  // SAME id through its own logs / result); else generate one. It is the
  // jailed-run id used for the script filename, the store GC/cleanup, and the
  // internal logs.
  const runId =
    params.runId ?? `orch-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  if (params.signal?.aborted) {
    throw createJailedRunAbortError();
  }

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
    // 5b. Expose COMIS_AGENT_BIN (the in-jail comis-agent path) ONLY
    //     when the binary is bound. It is NOT a secret, so it is set AFTER the
    //     scrub (like the lease vars). On "unavailable" it is intentionally
    //     unset — the in-jail `comis-agent` then has no binary to resolve, the
    //     loud WARN above already announced the scoped degrade.
    if (jailAgentCli.mode === "bind") {
      childEnv.COMIS_AGENT_BIN = jailAgentCli.binPath;
    }

    // 6. Spawn the jailed child; capture stdout ONLY (stderr/intermediate
    //    never re-enter). Return the RAW stdout — the caller shapes it.
    const stdout = await runJailedChild(
      spawnFn,
      bin,
      spawnArgs,
      { env: childEnv, cwd: undefined },
      timeoutMs,
      { runId, log },
      params.signal,
    );

    return stdout;
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
  spawnFn: JailedScriptSpawnFn,
  bin: string,
  args: string[],
  opts: { env: Record<string, string | undefined>; cwd?: string },
  timeoutMs: number,
  ctx: { runId: string; log: ComisLogger },
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(createJailedRunAbortError());
      return;
    }
    let child: JailedScriptSpawnedChild;
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
    const removeAbortListener = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      systemClearTimeout(timer);
      removeAbortListener();
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      reject(createJailedRunAbortError());
    };
    const timer: SystemTimeoutHandle = systemSetTimeout(() => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      reject(new Error(`orchestrate run exceeded its ${timeoutMs}ms timeout`));
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      // Bound the in-stream accumulation. The post-exit size-bounce (in the
      // caller) does not protect the daemon heap DURING the run, so a jailed
      // `while(true) console.log(...)` flood must be stopped here — fail closed:
      // stop appending, SIGKILL the runaway child, and reject.
      stdoutBytes += chunk.length;
      if (stdoutBytes > STDOUT_HARD_CAP_BYTES) {
        settled = true;
        systemClearTimeout(timer);
        removeAbortListener();
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
      removeAbortListener();
      reject(err);
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      systemClearTimeout(timer);
      removeAbortListener();
      if (code !== 0 && code !== null) {
        const tail = stderrTail.trim();
        ctx.log.warn(
          {
            runId: ctx.runId,
            errorKind: "internal" as const,
            hint: "Inspect stderrTail, correct the jailed script or referenced capability/tool name, then retry the orchestrate call.",
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

function createJailedRunAbortError(): Error {
  const error = new Error("orchestrate jailed run aborted by caller");
  error.name = "AbortError";
  return error;
}

/** The default real spawn (the unit suite injects `spawnFn`; this is production). */
const defaultSpawn: JailedScriptSpawnFn = (bin, args, opts) =>
  spawn(bin, args, {
    env: opts.env,
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as JailedScriptSpawnedChild;

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
