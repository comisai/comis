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
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import {
  registerActivityLabelSpec,
  safePath,
  systemNowMs,
  tryGetContext,
  type AgentCapability,
  type ComisLogger,
  type EventMap,
} from "@comis/core";
import { createToolResultSizeGuard } from "@comis/agent";
import type { CapabilityClass } from "@comis/agent";

import {
  resolveJailAgentCli,
  resolveJailNode,
  resolveJailPython,
  SYSTEM_RO_PATHS,
} from "../sandbox/bwrap-provider.js";
import type {
  JailAgentCliResolution,
  JailNodeResolution,
  JailPythonResolution,
  SandboxProvider,
} from "../sandbox/types.js";
import { loadSeccompProfileFd, closeSeccompProfileFd } from "../sandbox/seccomp-profile.js";
import { throwToolError } from "../../../platform-tools/tool-helpers.js";
import type {
  CleanupRunContext,
  GcRunContext,
  MaterializeContext,
  RunAggregateContext,
} from "./result-ref-store.js";
import { estimateSavings } from "./savings-estimate.js";
import { extractCapabilityFootprint } from "./orchestrate-preflight.js";
import {
  classifyRunError,
  repairEnabledForClass,
  runScriptWithOneShotRepair,
  REPAIR_LEASE_BUDGET_MS,
} from "./orchestrate-repair.js";
import type {
  OrchestrateFailureClass,
  OrchestrateSpawnFn,
  OrchestrateSpawnedChild,
} from "./orchestrate-repair.js";
import type { ResultRef } from "@comis/core";

// The jailed-child execution engine + its seam types live in orchestrate-repair;
// re-export the public surface the runner has always exposed here (the barrel +
// the unit suite import these names from this module).
export { STDOUT_HARD_CAP_BYTES } from "./orchestrate-repair.js";
export type { OrchestrateSpawnFn, OrchestrateSpawnedChild } from "./orchestrate-repair.js";

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
  language: Type.Union([Type.Literal("ts"), Type.Literal("js"), Type.Literal("py")], {
    description: 'The script language: "ts", "js", or "py".',
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
  language: "ts" | "js" | "py";
  timeoutMs?: number;
  captureStdout?: boolean;
};

// ---------------------------------------------------------------------------
// Injected seams + deps.
// ---------------------------------------------------------------------------

/** Minimal store surface the runner needs (the runner owns the run lifecycle). */
export interface OrchestrateResultStore {
  materialize(
    payload: string | Buffer,
    toolName: string,
    ctx: MaterializeContext,
  ): Promise<ResultRef | { error: string } | undefined>;
  gcRun(ctx: GcRunContext): Promise<void>;
  cleanupRun(ctx: CleanupRunContext): Promise<void>;
  /**
   * Read the run's materialized `{count,bytes}` aggregate — a READ-ONLY
   * enumeration of `results/`. The runner captures it BEFORE the `finally`
   * `cleanupRun` wipes the dir (the run_summary savings input). Optional so a
   * minimal stub store compiles; the concrete `createResultRefStore` always
   * provides it. Absent ⇒ the runner treats the run as having materialized
   * nothing (`{count:0,bytes:0}`).
   */
  runAggregate?(ctx: RunAggregateContext): { count: number; bytes: number };
}

/** Dependencies for the orchestrate runner (AGENTS.md §2.4 — injected). */
// @optional-field-count: 16 — the daemon-minted optional wiring seams. Six
// required fields (logger / workspace / cap-socket / sandbox / store / baseEnv)
// are always present; each optional field is a presence-conditional collaborator
// the composition root threads ONLY when its feature is active — the broker
// lease-env + per-run lease mint, the event-bus run_summary, the pre-flight
// allowed-caps + approval gate, and the capability-class + one-shot repair seam —
// plus the test-injected seams (spawn / jail-node / jail-python / jail-agent-cli /
// seccomp-fd / clock / sdk-assets-dir) that default to the real implementation
// when absent. Each read site already guards on its own presence; clustering them
// would couple unrelated wiring. Grows by one per new daemon-threaded seam.
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
   * The jail-python resolver (default `defaultResolveJailPython`, which probes
   * the ABSOLUTE host interpreter bin paths). Consumed ONLY on a `language:"py"`
   * run: an `unavailable` verdict REFUSES the run (fail-closed, never a silent
   * unjailed run); a `path` verdict supplies the absolute `pythonBin` to invoke.
   */
  readonly resolveJailPythonFn?: () => JailPythonResolution;
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
   * (tree accounting untouched) with `parentLeaseId` = the assembly lease, so
   * every in-jail cap call for the run audits under this run's `leaseId` (the
   * INV-1 per-run correlator). The runner SIZES the `ttlMs` it passes: the run
   * timeout, or the run timeout + the one-shot-repair budget when auto-repair is
   * enabled (so the single lease outlives the repair-completion await into the
   * repaired re-run). Minted daemon-side and threaded as a plain closure —
   * the runner never imports the LeaseManager. Absent (older wiring) → the assembly
   * bearer authenticates (no per-run mint; never an unauthenticated run).
   */
  readonly mintRunLease?: (runId: string, ttlMs: number) => { leaseId: string; bearer: string };
  /**
   * The agent-side event bus, structurally typed to the ONE channel this runner
   * emits (the emit-capability-audit.ts EmitCapabilityAuditDeps precedent). When
   * present, every run — success AND each failure class — emits a content-free
   * `orchestrate:run_summary` at completion (the `comis explain` / `comis fleet`
   * signal). Emit from the TOOL (not a daemon graph handler) because this
   * threaded bus reaches the live per-session trajectory bridge; the bridge
   * attaches at execute() START, so the completion-time emit always lands.
   * Absent (older wiring) ⇒ no emit (never an error — the run is unaffected).
   */
  readonly eventBus?: {
    emit: (
      event: "orchestrate:run_summary",
      payload: EventMap["orchestrate:run_summary"],
    ) => unknown;
  };
  /**
   * The tree-stable root the run's lease inherits — an attribution key on the
   * run_summary event (the daemon-shared bus fans out to every session bridge, so
   * the payload self-attributes, never inferred from ambient state). Threaded
   * from `buildAutonomyToolWiring`. Absent ⇒ the emit falls back to the run's own
   * `runId` (never undefined on the wire).
   */
  readonly rootRunId?: string;
  /** The owning session — the other run_summary attribution key. Threaded from the wiring; absent for a heartbeat/cron run. */
  readonly sessionKey?: string;
  /**
   * The agent's HELD capability set (fed from the resolved autonomy profile's
   * `resolved.capabilities` daemon-side). When present, the pre-flight statically
   * scans the model's script for its capability footprint and FAILS FAST pre-spawn
   * with a cap-named error if the footprint needs a cap the agent lacks.
   * This is ADVISORY UX only — it grants nothing; the bwrap cap-socket endpoint's
   * default-deny-by-absence stays the sole authoritative boundary. Absent
   * (older wiring) ⇒ the cap fail-fast is skipped (the endpoint still gates).
   */
  readonly allowedCaps?: readonly AgentCapability[];
  /**
   * The approval gate, structurally typed to the ONE method used (the eventBus-dep
   * precedent). When present, the pre-flight fires ONE approval on the script's whole
   * capability footprint (the exact sorted cap set) BEFORE spawn; a `!approved`
   * resolution refuses the run. The daemon threads this seam ONLY when
   * `config.approvals.enabled`, so seam-presence IS "approvals configured" — there is
   * no rule engine (the reused gate is the whole mechanism). Absent ⇒ no approval fire.
   */
  readonly approvalGate?: {
    requestApproval(req: {
      toolName: string;
      action: string;
      params: Record<string, unknown>;
      agentId: string;
      sessionKey: string;
      trustLevel: "admin" | "user" | "guest";
      channelType?: string;
    }): Promise<{ approved: boolean; reason?: string }>;
  };
  /**
   * The resolved capability class (operator override ?? provider-family), threaded
   * daemon-side. The one-shot auto-repair is class-gated (ON for weaker models, OFF
   * for stronger). Declared here as the contract the one-shot repair path consumes;
   * UNUSED by the pre-flight gate. Absent ⇒ treat as the fail-safe class
   * (repair-eligible) where consumed.
   */
  readonly capabilityClass?: CapabilityClass;
  /**
   * The daemon-minted one-shot repair completion closure (like {@link mintRunLease}):
   * given the failed script + its bounded stderr tail + a describe digest, it does ONE
   * utility-model re-prompt and returns the regenerated script (or `undefined` on
   * give-up). Declared here as the contract the one-shot repair path consumes; UNUSED
   * by the pre-flight gate. Absent ⇒ no repair.
   */
  readonly repairSeam?: (input: {
    script: string;
    language: "ts" | "js" | "py";
    stderrTail: string;
    describeDigest: string;
  }) => Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

/** The SDK asset filenames copied into the jail workspace. */
const SDK_ASSETS = [
  "comis_tools.d.ts",
  "comis_tools.js",
  "comis_tools.py",
  "orchestrate-sdk-runtime.js",
] as const;

/** The comis-built comis-agent entry that is sha256-pinned + RO-bound. */
const COMIS_AGENT_ENTRY_FILENAME = "comis-agent-entry.js";

/** The committed manifest (rides into dist via the asset-copy) holding the pin. */
const COMIS_AGENT_MANIFEST_FILENAME = "comis-agent-manifest.json";

/** Max stdout characters that re-enter context — the rest is size-bounced. */
const STDOUT_MAX_CHARS = 30_000;

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
  const resolvePython = deps.resolveJailPythonFn ?? defaultResolveJailPython;
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

      // Static pre-flight, run BEFORE any resource is acquired — no seccomp fd
      // opened, no run_summary emitted, no child spawned on a rejection (it precedes
      // the try/finally and the loadSeccompFd below). Scan the model's script for its
      // capability footprint (pure text analysis — no eval/fs/net) and:
      //   (a) FAIL FAST with a cap-named error if the footprint needs a cap the agent
      //       lacks, so a small model gets a precise pre-spawn error instead of a
      //       mid-run failure after a jail is burned; and
      //   (b) fire ONE approval on the whole footprint (the exact sorted cap set) when
      //       an approval gate is wired — a `!approved` resolution refuses the run.
      //       Seam-presence IS "approvals configured" (the daemon threads the gate only
      //       when config.approvals.enabled); there is no rule engine — the reused gate
      //       is the whole mechanism.
      // ADVISORY ONLY: the footprint grants nothing. A script that dodges the static
      // scan (a dynamic/computed call → empty footprint) proceeds past here and is
      // still denied at the cap-socket endpoint by default-deny-by-absence, the sole
      // authoritative boundary.
      const footprint = extractCapabilityFootprint(params.script);
      if (deps.allowedCaps) {
        const held = new Set(deps.allowedCaps);
        const missing = [...footprint.caps].filter((cap) => !held.has(cap)).sort();
        if (missing.length > 0) {
          throwToolError(
            "permission_denied",
            `This script calls tools requiring capabilities the agent lacks: ${missing.join(", ")}.`,
            {
              hint: `Remove those calls or grant ${missing.join("/")} in the agent's autonomy profile. The jail endpoint denies them regardless — this is a pre-spawn fail-fast.`,
            },
          );
        }
      }
      if (deps.approvalGate && footprint.caps.size > 0) {
        const sortedCaps = [...footprint.caps].sort();
        // The trust level / agent id / session come from the framework-injected
        // request context (tryGetContext), never from the model's params — the tool
        // cannot self-supply them. Undefined outside a request scope (heartbeat/cron).
        const ctx = tryGetContext();
        const resolution = await deps.approvalGate.requestApproval({
          toolName: "orchestrate",
          action: `orchestrate:${sortedCaps.join("+")}`,
          params: { caps: sortedCaps },
          agentId: ctx?.userId ?? "unknown",
          sessionKey: ctx?.sessionKey ?? "",
          trustLevel: (ctx?.trustLevel ?? "admin") as "admin" | "user" | "guest",
          ...(ctx?.channelType ? { channelType: ctx.channelType } : {}),
        });
        if (!resolution.approved) {
          throwToolError("permission_denied", "Orchestrate run denied by the approval workflow.", {
            hint: resolution.reason ?? "no reason given",
          });
        }
      }

      // The per-run child leaseId (D5) — the per-run correlator carried on the
      // run_summary emit. Undefined when no mintRunLease seam is wired (the
      // assembly bearer authenticates instead).
      let childLeaseId: string | undefined;

      // The owning TURN's trace correlator — snapshotted ONCE from the framework
      // request context (distinct from runId/rootRunId, the orchestrate-run ids).
      // Carried on run_summary so the learning ledger keys the descriptor row on
      // the turn trajectory. Undefined outside a request scope (heartbeat/cron).
      const turnTraceId = tryGetContext()?.traceId;

      // Emit the content-free run_summary (EXPLAIN-02) — success AND every failure
      // class route through here. Captures the run's materialized {count,bytes}
      // BEFORE the finally's cleanup wipes results/ (Pitfall 3), computes the
      // SAVE-01 estimate, and self-attributes via rootRunId + sessionKey (the
      // daemon-shared bus fans out to every session bridge). A no-op when no
      // eventBus is wired — never the stderr tail / script body / params (INV-5).
      const emitRunSummary = (outcome: {
        readonly exitCode: number;
        readonly failureClass?: OrchestrateFailureClass;
        readonly stdoutBytesRaw: number;
        readonly stdoutCharsReentered: number;
      }): void => {
        if (deps.eventBus === undefined) return;
        // The emit MUST NEVER throw into the run flow. TypedEventBus.emit delegates
        // to EventEmitter.emit, which invokes subscribers synchronously and
        // PROPAGATES a throwing one — so a throwing subscriber (a future plugin hook
        // or a new bridge branch) would otherwise be caught by the run's catch,
        // re-classified as spawn_fail, re-emitted (double record), and flip a
        // SUCCESSFUL run into a failed tool call. Swallow + log so a bad subscriber
        // can never perturb the run outcome (the run already rode its own
        // return/throw); the store aggregate read is inside the guard too.
        try {
          const agg = deps.store.runAggregate?.({ workspacePath }) ?? { count: 0, bytes: 0 };
          const savings = estimateSavings(agg.bytes, outcome.stdoutCharsReentered);
          deps.eventBus.emit("orchestrate:run_summary", {
            runId,
            ...(childLeaseId !== undefined ? { leaseId: childLeaseId } : {}),
            rootRunId: deps.rootRunId ?? runId,
            ...(deps.sessionKey !== undefined ? { sessionKey: deps.sessionKey } : {}),
            ...(turnTraceId !== undefined ? { traceId: turnTraceId } : {}),
            language: params.language,
            durationMs: now() - startedMs,
            exitCode: outcome.exitCode,
            ...(outcome.failureClass !== undefined ? { failureClass: outcome.failureClass } : {}),
            stdoutBytesRaw: outcome.stdoutBytesRaw,
            stdoutCharsReentered: outcome.stdoutCharsReentered,
            resultRefCount: agg.count,
            resultRefBytes: agg.bytes,
            // Savings is carried ONLY when the run materialized ResultRefs — the
            // documented contract (orchestrate.mdx / json-rpc.mdx), the fold's
            // omit-branch, and the schema test. A run that materialized nothing
            // OMITS both keys rather than carrying a phantom 0, mirroring the sibling
            // optional leaseId / sessionKey / failureClass conditional spreads.
            ...(agg.count > 0
              ? { estSavedTokens: savings.estSavedTokens, savedRatio: savings.savedRatio }
              : {}),
            // The content-free ordered call-site sequence + counts from the pre-flight
            // footprint (already computed above) — names only, never args/bodies.
            // Omitted (like the sibling optional spreads) when no cap-mapped call site.
            ...(footprint.sequence.length > 0 ? { toolSequence: footprint.sequence } : {}),
            timestamp: now(),
          });
        } catch (emitErr) {
          log.debug(
            { runId, err: emitErr instanceof Error ? emitErr : undefined },
            "orchestrate run_summary emit failed (non-fatal)",
          );
        }
      };

      log.debug({ runId, step: "start", language: params.language }, "orchestrate run starting");

      // Resolve the seccomp fd ONCE, BEFORE the try (see the fd-lifecycle
      // contract in seccomp-profile.ts). The fd is opened WITHOUT O_CLOEXEC so the bwrap child inherits
      // it — the parent (daemon) keeps its OWN copy after fork and MUST close it
      // in the finally below, or every jailed run leaks one descriptor and a
      // long-running daemon exhausts its fd table. Opening it here (not inside
      // the try) means the finally always closes it even when copyFileSync /
      // resolveNode / the jailed run throws (those run after this point today, so
      // a throw there would otherwise leak the fd). Null on macOS (blob absent →
      // no --seccomp); closeSeccompProfileFd is null-safe + double-close-safe.
      const seccompFd = loadSeccompFd();

      try {
        // 1. Resolve the script path in the jailed workspace. The actual write is
        //    deferred to the run engine (step 6) so the one-shot repair can re-write
        //    the SAME path with the regenerated script and re-run it, sharing the
        //    identical jail/cap/lease envelope.
        const scriptName = `${runId}.${params.language}`;
        const scriptPath = safePath(workspacePath, scriptName);

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

        // 3a. Select the SCRIPT interpreter, honest-degrading the "py" surface.
        //     ts/js run under the daemon node; "py" runs under the RO-bound host
        //     python3 resolved by `resolvePython`. Resolve + refuse-on-unavailable
        //     HERE — before buildArgs and the per-run lease mint — mirroring the
        //     node refuse above: an absent interpreter NEVER falls through to a
        //     silent unjailed run (INV-1 fail-closed). The interpreter is invoked
        //     by its ABSOLUTE path (bind-mode node's execPath, or the resolved
        //     pythonBin): a bare `node`/`python3` is not on the jail's scrubbed
        //     PATH and would exit 127 (the #236 lesson). Python has no BIND net, so
        //     `resolveJailPython` returns the absolute pythonBin directly.
        let interp: string;
        if (params.language === "py") {
          const jailPython = resolvePython();
          if (jailPython.mode === "unavailable") {
            log.warn(
              { runId, errorKind: "precondition" as const, hint: jailPython.hint },
              "orchestrate 'py' surface unavailable — refusing to run",
            );
            throwToolError(
              "not_implemented",
              "The orchestrate 'py' surface is unavailable on this host (no python3 inside the jail).",
              { hint: jailPython.hint },
            );
          }
          interp = jailPython.pythonBin;
        } else {
          interp = jailNode.mode === "bind" ? jailNode.execPath : "node";
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
        // Run the script with the interpreter resolved at step 3a (node for ts/js,
        // python3 for py), invoked by its ABSOLUTE path from the workspace cwd — a
        // bare `node`/`python3` is not on the jail's scrubbed PATH and exits 127.
        const command = `${interp} ${scriptName}`;
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
          // Size the child-lease TTL to the run's ACTUAL lifetime. When one-shot
          // auto-repair is enabled for this run (a repair-eligible class AND a
          // wired repair seam), the run engine awaits one utility-model completion
          // — bounded by the seam's abort ceiling — BETWEEN the initial run and the
          // repaired re-run, all under THIS single lease. A lease sized to the tight
          // `timeoutMs` would expire during that repair await, so the repaired
          // re-run's in-jail cap calls would authenticate with a dead lease and be
          // denied (fails closed, but the repair silently no-ops for exactly the
          // slow/local small models it targets). Extend the TTL by the repair budget
          // so the ONE minted lease covers the run+repair window; when repair is off,
          // keep the tight `timeoutMs`. The lease is only SIZED here, never re-minted
          // — one leaseId per run (the INV-1 attribution the run_summary keys on) and
          // the same audience-bound child (INV-7) are both preserved.
          const repairEnabled =
            deps.repairSeam !== undefined && repairEnabledForClass(deps.capabilityClass);
          const leaseTtlMs = repairEnabled ? timeoutMs + REPAIR_LEASE_BUDGET_MS : timeoutMs;
          const child = deps.mintRunLease(runId, leaseTtlMs);
          childLeaseId = child.leaseId;
          childEnv.COMIS_CAP_LEASE = child.bearer;
          log.debug(
            { runId, leaseId: childLeaseId, step: "child-lease", leaseTtlMs, repairEnabled },
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

        // A run reaches the jail WITH a lease iff COMIS_CAP_LEASE was set (the
        // assembly bearer via brokerSpawnEnv, or the per-run child bearer via
        // mintRunLease). A run with none is degraded — flagged lease_absent below.
        const leasePresent = childEnv.COMIS_CAP_LEASE !== undefined;

        // 6. Run the jailed child, with a bounded one-shot auto-repair. Writes the
        //    script into the workspace then drives the jailed child to completion
        //    (stdout ONLY re-enters; stderr/intermediate never do). The initial run
        //    and the single repaired re-run share the identical jail/cap/lease
        //    envelope built above (bin / spawnArgs / childEnv / scriptPath). The
        //    repair resolves the FINAL outcome HERE, before the terminal run_summary
        //    emit below, so a repaired-then-succeeded run emits exactly one (success)
        //    summary and an escaping error emits once in the outer catch.
        const stdout = await runScriptWithOneShotRepair({
          spawnFn,
          bin,
          spawnArgs,
          childEnv,
          scriptPath,
          timeoutMs,
          script: params.script,
          language: params.language,
          capabilityClass: deps.capabilityClass,
          repairSeam: deps.repairSeam,
          log,
          runId,
        });

        const bounced = sizeBounceStdout(stdout);
        // The POST-bounce char count — the tokens that actually re-entered
        // context (the SAVE-01 "actual"; raw stdout.length would overstate).
        const stdoutCharsReentered = bounced.reduce((sum, b) => sum + b.text.length, 0);
        // A clean exit with NO lease is still a degraded run — name it
        // lease_absent so `comis explain` can attribute the missing lease.
        emitRunSummary({
          exitCode: 0,
          failureClass: leasePresent ? undefined : "lease_absent",
          stdoutBytesRaw: stdout.length,
          stdoutCharsReentered,
        });
        log.info(
          { runId, step: "complete", durationMs: now() - startedMs, stdoutBytes: stdout.length },
          "orchestrate run complete",
        );
        return { content: bounced, details: { runId, stdoutBytes: stdout.length } };
      } catch (err) {
        // Every failure class emits a run_summary too — mapped to the closed
        // enum, BEFORE the finally's cleanup wipes results/ — then re-throws so
        // the AgentTool boundary still surfaces the original (bounded) tool error
        // (the stderr tail stays on THAT surface, never on the bus).
        const { failureClass, exitCode } = classifyRunError(err);
        emitRunSummary({ exitCode, failureClass, stdoutBytesRaw: 0, stdoutCharsReentered: 0 });
        throw err;
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

/**
 * The default jail-python resolver — probe the ABSOLUTE host interpreter bin
 * paths (NOT the SYSTEM_RO_PATHS directory roots `defaultResolveJailNode` uses).
 * Python has no BIND fallback the way node does (there is no daemon-python to
 * ro-bind), so probing roots (`/usr`,`/bin`) would falsely report `unavailable`
 * on a host that has `/usr/bin/python3`. All three candidates live under the
 * RO-bound `/usr`/`/bin`, so a hit is reachable in-jail at the same absolute path.
 */
function defaultResolveJailPython(): JailPythonResolution {
  return resolveJailPython({
    interpreterPaths: ["/usr/bin/python3", "/bin/python3", "/usr/local/bin/python3"],
  });
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
