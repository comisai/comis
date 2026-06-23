// SPDX-License-Identifier: Apache-2.0
// @allow-throw: the orchestrate runner honest-degrades on an unavailable jail
// (S4) and on a failed jailed child via throwToolError / Error — both are caught
// by the AgentTool execution boundary (agent-loop) and surfaced as a tool error.
/**
 * `orchestrate-tool` — the Surface-2 `orchestrate` runner (ORCH-01/02). The
 * headline autonomy primitive: the model writes ONE script that chains
 * capability-scoped typed tools (the committed `comis_tools` SDK) in a jailed
 * child, and only size-bounded stdout re-enters context — a search→fetch→
 * synthesize chain in one inference turn, with intermediate results riding
 * ResultRefs (queried in-jail) rather than the transcript.
 *
 * It composes the SHIPPED substrate, adding NO new sandbox primitive:
 *   - the Phase-211 bwrap cap-socket jail (`BwrapProvider.buildArgs` with
 *     `network:{mode:"cap-socket"}` → `--unshare-net` + the cap socket `--bind`;
 *     `~/.comis` is masked by construction — the jail binds only the workspace +
 *     `SYSTEM_RO_PATHS`, never the data dir).
 *   - `resolveJailNode` (JAIL-04) for the honest-degrade: no `node`/`bwrap`
 *     inside the jail → a loud precondition error, NEVER a quiet host-side run
 *     outside the jail.
 *   - the committed `comis_tools.{d.ts,js}` SDK (Plan 03) + the
 *     `orchestrate-sdk-runtime.js` shim (Task 1), copied into the workspace so
 *     the script can `import "./comis_tools.js"`.
 *   - the `result-ref-store` run lifecycle (Plan 03) — the runner owns
 *     `cleanupRun` (REF-03) in a `finally`.
 *   - `createToolResultSizeGuard` (@comis/agent) for the stdout size-bounce.
 *
 * ORCH-02 (env-scrub): the inherited/base env is filtered through
 * {@link scrubSecretEnv} (drop any `*KEY* / *TOKEN* / *SECRET*` key) BEFORE the
 * daemon-injected lease vars (`COMIS_CAP_LEASE`/`COMIS_ORCH_SOCKET`) are merged —
 * the lease vars ride `brokerSpawnEnv.placeholders`, merged LAST, so they survive
 * the scrub by construction (Pitfall 4). A host secret can never leak into the
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
import { copyFileSync, writeFileSync } from "node:fs";
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

import { resolveJailNode, SYSTEM_RO_PATHS } from "../sandbox/bwrap-provider.js";
import type { JailNodeResolution, SandboxProvider } from "../sandbox/types.js";
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
// Parameter schema (ORCH-01).
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

/** Minimal store surface the runner needs (the run-lifecycle owner — REF-03). */
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
   * Plan 05 threads it from the kept endpoint handle.
   */
  readonly capSocketPath: string;
  /** The platform sandbox provider (BwrapProvider on Linux) — the arg generator. */
  readonly sandbox: SandboxProvider;
  /**
   * The daemon-injected lease-env carrier. `placeholders` (COMIS_CAP_LEASE /
   * COMIS_ORCH_SOCKET) are merged AFTER the secret-scrub so they survive it
   * (Pitfall 4). Optional: when absent the child gets no lease (the SDK calls
   * would then fail their precondition — never a silent unauthenticated run).
   */
  readonly brokerSpawnEnv?: { readonly placeholders: Record<string, string> };
  /** The ResultRef store — the runner owns `cleanupRun` on run end (REF-03). */
  readonly store: OrchestrateResultStore;
  /** The directory holding the committed SDK assets to copy into the jail. */
  readonly sdkAssetsDir?: string;
  /** The spawn seam (default `node:child_process.spawn`). */
  readonly spawnFn?: OrchestrateSpawnFn;
  /** The jail-node resolver (default the real `resolveJailNode`). */
  readonly resolveJailNodeFn?: () => JailNodeResolution;
  /** The seccomp-fd loader (default the real `loadSeccompProfileFd`; null on macOS). */
  readonly loadSeccompFdFn?: () => number | null;
  /** Injected wall clock (default `systemNowMs`). */
  readonly now?: () => number;
  /**
   * The base/inherited env to scrub (ORCH-02). REQUIRED — the daemon wiring
   * (Plan 05) supplies the inherited env explicitly, so the runner never reads
   * an ambient global (AGENTS.md §2.2). The lease vars are added separately via
   * {@link brokerSpawnEnv}, merged AFTER the scrub.
   */
  readonly baseEnv: Record<string, string | undefined>;
}

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

/** The SDK asset filenames copied into the jail workspace (Plan 03 + Task 1). */
const SDK_ASSETS = ["comis_tools.d.ts", "comis_tools.js", "orchestrate-sdk-runtime.js"] as const;

/** Max stdout characters that re-enter context — the rest is size-bounced. */
const STDOUT_MAX_CHARS = 30_000;

/** Default hard timeout for a jailed run (ms). */
const DEFAULT_TIMEOUT_MS = 60_000;

/** The per-run aggregate `results/` budget passed to the store's GC. */
const PER_RUN_AGGREGATE_CAP_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Pure exported helper — the ORCH-02 env-scrub (macOS-unit-testable).
// ---------------------------------------------------------------------------

/** Matches any env key that could carry a credential (ORCH-02). */
const SECRET_KEY_PATTERN = /KEY|TOKEN|SECRET/i;

/**
 * Filter a base/inherited env map for the jailed child (ORCH-02): drop every key
 * matching `*KEY* / *TOKEN* / *SECRET*` (case-insensitive) and every undefined
 * value, returning a clean `Record<string,string>`.
 *
 * This runs over the BASE env ONLY — the daemon-injected lease vars
 * (`COMIS_CAP_LEASE`/`COMIS_ORCH_SOCKET`) are merged AFTER this scrub (they ride
 * `brokerSpawnEnv.placeholders`), so they survive by construction (Pitfall 4).
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

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------

/**
 * Create the `orchestrate` AgentTool (ORCH-01/02). See the module doc for the
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
      const timeoutMs =
        typeof params.timeoutMs === "number" && params.timeoutMs > 0
          ? params.timeoutMs
          : DEFAULT_TIMEOUT_MS;

      log.debug({ runId, step: "start", language: params.language }, "orchestrate run starting");

      // Resolve the seccomp fd ONCE, BEFORE the try (CR-01 + seccomp-profile.ts
      // §21-43). The fd is opened WITHOUT O_CLOEXEC so the bwrap child inherits
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

        // 3. Honest-degrade (S4): resolve the jail node; refuse on unavailable —
        //    NEVER a quiet host-side run outside the jail (T-212-18).
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

        // 4. Build the cap-socket jail args (--unshare-net + the cap socket
        //    --bind + the workspace-only FS; ~/.comis is never bound → masked).
        //    The provider binds the curated SYSTEM_RO_PATHS itself (so jq + node
        //    resolve); we pass NO extra readOnlyPaths (mirrors the cap-socket
        //    .linux.test) — re-listing them here would route the curated
        //    allow-list through the JAIL-03 discovery screen (a false-positive on
        //    /etc/* paths that resolve into a blocked dir on some hosts).
        const args = deps.sandbox.buildArgs({
          workspacePath,
          sharedPaths: [],
          readOnlyPaths: [],
          cwd: workspacePath,
          tempDir: safePath(workspacePath, ".tmp"),
          network: { mode: "cap-socket", capSocketPath: deps.capSocketPath },
          seccompFd,
          jailNode,
        });
        // The jailed command runs the script with node, from the workspace cwd.
        const command = `node ${scriptName}`;
        const bin = args[0]!;
        const spawnArgs = [...args.slice(1), "/bin/bash", "-c", command];

        // 5. Env: the ORCH-02 scrub over the BASE env, THEN the lease placeholders
        //    merged LAST (Pitfall 4 — they survive the scrub by construction).
        const childEnv: Record<string, string | undefined> = scrubSecretEnv(deps.baseEnv);
        if (deps.brokerSpawnEnv) {
          Object.assign(childEnv, deps.brokerSpawnEnv.placeholders);
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
        // 7. CR-01: close the PARENT's copy of the seccomp fd. By the time the
        //    finally runs the child has already inherited it (spawn returned, or
        //    threw — either way the parent's copy is open and must be released).
        //    null-safe + double-close-safe, so this is unconditional. Closing
        //    BEFORE gcRun/cleanupRun guarantees a throwing GC cannot skip it.
        closeSeccompProfileFd(seccompFd);

        // 8. REF-03: the runner owns the run lifecycle — GC then drop the run's
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
      stdout += chunk.toString("utf8");
    });
    // Read+discard stderr so it cannot back-pressure the child, but NEVER return
    // it (stdout-only — intermediate/diagnostic output stays out of context).
    child.stderr?.on("data", () => {});
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
        ctx.log.warn(
          { runId: ctx.runId, errorKind: "internal" as const, exitCode: code },
          "orchestrate jailed child exited non-zero",
        );
        reject(new Error(`orchestrate jailed child exited with code ${code}`));
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

/** Size-bounce the raw stdout into bounded text content (ORCH-01 / T-212-21). */
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
