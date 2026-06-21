// SPDX-License-Identifier: Apache-2.0
/**
 * `chan` / `tg` — the standalone channel-driver CLI (Phase 205, Plan 05).
 *
 * `tg` is the alias `chan --channel telegram`. This is the agent/shell driver
 * that replaces the ad-hoc `/tmp/chat.sh` + `/tmp/vps.sh` scripts for the
 * channel surface: a THIN client over the three surfaces the handle records —
 * the emulator `/control/*` (drive verbs: send / react / last / history), the
 * gateway `/rpc` (the `tg rpc` AUTO-01 verbatim passthrough + the curated
 * explain / fleet + the `tg trigger` cron/heartbeat/wake fire-now over WS), and
 * the rig lifecycle (up / down / status / restart / reset --deep / reconfigure —
 * the AUTO-04 Track-K model sweep).
 *
 * The LOAD-BEARING property is the NO-FALSE-SUCCESS honest-exit contract
 * (CLI-04, the prime directive): every verb is `--json`-able and exits NON-ZERO
 * + reason-coded on a no-reply timeout / RPC error / dead handle / malformed
 * json — a no-reply is an honest empty, NEVER a fabricated success.
 *
 * SEC-02 (Dimension 3): `chan`/`tg` is a STANDALONE tsx entry under the test
 * tree (`test/live/bin/chan.ts`), NEVER a `comis` CLI subcommand. There is no
 * `chan.ts`/`tg.ts` under the cli package's commands and no `.command("chan"|
 * "tg")` registration — the harness-never-published guard forward-protects
 * these names. It adds NO published edge (a tsx entry under the test tree).
 *
 * TEST-HARNESS — lives under the test tree, never the packages source-tree;
 * ZERO production code change. The test tree is outside every packages
 * source-tree ESLint / architecture rule, so `process.exit` / `console.log` /
 * `node:fs` / a raw CLI shape are all fine here. The `@comis/*` packages it
 * transitively reaches are consumed from their built `dist/` (a stale `dist/`
 * masks `src/` — build first).
 *
 * Run the unit tests under the LIVE vitest config (the bare root config
 * excludes `test/live`, collecting 0 files → false green):
 *   pnpm vitest run -c test/live/vitest.config.ts test/live/bin/chan.test.ts
 *
 * @module
 */

// ---------------------------------------------------------------------------
// parseArgs — the PURE, side-effect-free named export (mirrors runner.ts:60).
// No process.exit, no network — so chan.test.ts unit-tests it directly.
// ---------------------------------------------------------------------------

/** The parsed CLI invocation. A pure projection of argv — no side effects. */
export interface ParsedArgs {
  /** The channel key, default "telegram" (the `tg` alias). */
  readonly channel: string;
  /** The verb (the first positional), or undefined when none was given. */
  readonly verb?: string;
  /** The remaining positionals after the verb (e.g. the rpc method + json). */
  readonly args: string[];
  /** `--json` — emit a machine-readable body for a driving agent. */
  readonly json: boolean;
  /** `--endpoint <url>` — override the resolved rig-control endpoint. */
  readonly endpoint?: string;
  /** `--model <id>` — the model `tg up` boots the rig with (default keyless). */
  readonly model?: string;
  /** `--event <type>` — the `tg wait` trajectory event to block on (AUTO-03). */
  readonly event?: string;
  /** `--tool <name>` — the `tg wait` tool-result name to block on (AUTO-03). */
  readonly tool?: string;
  /** `--timeout <ms>` — the `tg wait` hard ceiling (parsed; non-finite is dropped). */
  readonly timeout?: number;
  /** `--deep` — the `tg reset --deep` clean-slate boolean sub-flag. */
  readonly deep?: boolean;
  /** `--agent <id>` — the target agent for `tg trigger` (TARGET-01 multi-agent). */
  readonly agent?: string;
  /** `--restart` — the `tg reconfigure --restart` re-boot sub-flag (AUTO-04). */
  readonly restart?: boolean;
  /**
   * `--detached` — `tg up --detached` spawns a DETACHED-subprocess rig (Plan
   * 208-08, Option A) that OUTLIVES this `tg up` process, so a SEPARATE-shell
   * `tg send`/`tg down` can drive it (the cold-shell, shell-only-unattended path).
   * Without it, `tg up` boots an IN-PROCESS rig (the certified spine) that dies
   * when `tg up` exits.
   */
  readonly detached?: boolean;
  /**
   * `--set k=v` (REPEATABLE) — the `tg reconfigure` config overrides (AUTO-04, the
   * Track-K model sweep). Each `--set agents.default.model=qwen3.6:14b` adds one
   * `key→value` pair. A malformed `--set` (no `=`) is dropped (never a crash).
   */
  readonly set?: Record<string, string>;
}

/** Strip a single pair of surrounding single/double quotes (runner.ts:96-98 shape). */
function stripQuotes(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * The string-valued flags (consume the NEXT token as their value). These MUST
 * be captured into typed {@link ParsedArgs} fields — NOT dropped as "unknown
 * boolean flags" — or the verb that reads them (e.g. `tg wait --event …`) gets
 * neither the flag nor its value (CR-01 / WR-01: the masked flag-strip).
 */
const STRING_FLAGS = new Set(["--channel", "--endpoint", "--model", "--event", "--tool", "--agent"]);

/** The boolean sub-flags (presence-only; consume no value). */
const BOOLEAN_FLAGS = new Set(["--json", "--deep", "--restart", "--detached"]);

/**
 * Parse the `chan`/`tg` CLI argv into a {@link ParsedArgs}. PURE — no side
 * effects. The first non-flag token is the verb; the rest are positional args
 * (quote-stripped). `--json`/`--deep` are boolean flags; `--channel`/
 * `--endpoint`/`--model`/`--event`/`--tool` consume the next token; `--timeout`
 * consumes a numeric next token (non-finite is dropped). Resolving the value
 * flags into TYPED fields here (rather than carrying them through as
 * positionals) keeps a verb's trajectory-file positional unambiguous regardless
 * of flag order (CR-01 / IN-01). The channel defaults to "telegram".
 */
export function parseArgs(argv: string[]): ParsedArgs {
  let channel = "telegram";
  let json = false;
  let deep = false;
  let restart = false;
  let detached = false;
  let endpoint: string | undefined;
  let model: string | undefined;
  let event: string | undefined;
  let tool: string | undefined;
  let agent: string | undefined;
  let timeout: number | undefined;
  const set: Record<string, string> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (BOOLEAN_FLAGS.has(tok)) {
      if (tok === "--json") json = true;
      else if (tok === "--deep") deep = true;
      else if (tok === "--restart") restart = true;
      else if (tok === "--detached") detached = true;
      continue;
    }
    if (tok === "--timeout") {
      const value = argv[i + 1];
      i++; // consume the value token
      if (value === undefined) continue;
      const ms = Number(value);
      if (Number.isFinite(ms)) timeout = ms; // a non-numeric --timeout is dropped, never NaN
      continue;
    }
    if (tok === "--set") {
      // `--set k=v` (REPEATABLE — AUTO-04 reconfigure overrides). Split on the
      // FIRST `=` (a value may itself contain `=`); a malformed pair (no `=`) is
      // dropped, never a crash. The reconfigure verb reads the merged map.
      const value = argv[i + 1];
      i++; // consume the value token
      if (value === undefined) continue;
      const eq = value.indexOf("=");
      if (eq > 0) set[value.slice(0, eq)] = value.slice(eq + 1);
      continue;
    }
    if (STRING_FLAGS.has(tok)) {
      const value = argv[i + 1];
      i++; // consume the value token
      if (value === undefined) continue;
      if (tok === "--channel") channel = value;
      else if (tok === "--endpoint") endpoint = value;
      else if (tok === "--model") model = value;
      else if (tok === "--event") event = value;
      else if (tok === "--tool") tool = value;
      else if (tok === "--agent") agent = value;
      continue;
    }
    if (tok.startsWith("--")) {
      // An unknown boolean flag — ignore it (never crash on extra flags).
      continue;
    }
    positionals.push(stripQuotes(tok));
  }

  const [verb, ...args] = positionals;
  return {
    channel,
    ...(verb !== undefined ? { verb } : {}),
    args,
    json,
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(event !== undefined ? { event } : {}),
    ...(tool !== undefined ? { tool } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(deep ? { deep } : {}),
    ...(restart ? { restart } : {}),
    ...(detached ? { detached } : {}),
    ...(Object.keys(set).length > 0 ? { set } : {}),
  };
}

// ---------------------------------------------------------------------------
// The honest-exit contract (CLI-04, the prime directive). A CLOSED union of
// failure kinds, each mapped to a DISTINCT non-zero exit code. A no-reply is an
// honest empty; an RPC throw is rpc_error; a dead handle is dead_handle; a
// malformed rpc json is bad_json (validated BEFORE any passthrough — V5).
// ---------------------------------------------------------------------------

/** The closed set of honest-failure classes the CLI can exit with. */
export type FailureKind = "no_reply" | "rpc_error" | "dead_handle" | "bad_json";

/** A reason-coded failure body — `{ error: <kind>, ...detail }`. */
export interface FailureBody {
  readonly error: FailureKind;
  readonly [k: string]: unknown;
}

/**
 * Build a reason-coded failure body: `{ error: kind, ...detail }`. The `--json`
 * path prints `JSON.stringify(toFailure(kind, detail))`; the exit code is
 * `exitCodeFor(kind)`. A driving agent reads the `error` string + the distinct
 * exit code to tell the classes apart.
 */
export function toFailure(kind: FailureKind, detail: Record<string, unknown> = {}): FailureBody {
  return { error: kind, ...detail };
}

/**
 * Map a {@link FailureKind} to a DISTINCT NON-ZERO exit code. Non-zero is the
 * load-bearing guarantee — a false success would be exit 0. Distinct per class
 * so a script / agent can branch on the exit status:
 *   no_reply → 2, rpc_error → 3, dead_handle → 4, bad_json → 5.
 */
export function exitCodeFor(kind: FailureKind): number {
  switch (kind) {
    case "no_reply":
      return 2;
    case "rpc_error":
      return 3;
    case "dead_handle":
      return 4;
    case "bad_json":
      return 5;
  }
}

/** The result of {@link tryParseJson} — a parsed value or an honest failure. */
export type ParseJsonResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly detail: string };

/**
 * Validate a `tg rpc` json arg BEFORE any passthrough (V5 / T-205-15). An empty
 * / whitespace string is the empty-params default `{}`. Valid JSON resolves
 * `{ ok: true, value }`; malformed JSON resolves `{ ok: false, detail }` —
 * NEVER a throw / crash. The caller turns `ok:false` into `toFailure("bad_json")`
 * + `exitCodeFor("bad_json")`, so a malformed arg can never crash the driver
 * mid-scenario.
 */
export function tryParseJson(s: string): ParseJsonResult {
  if (s.trim().length === 0) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(s) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, detail: "rpc params must be a JSON object" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (err: unknown) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// runVerb dispatch (Task 2). The seams are injected via `ctx` so the dispatch
// is unit-testable WITHOUT a daemon. `runVerb` THROWS a VerbFailure on any
// honest failure; `runMain` catches it → prints the body → process.exit with
// the distinct non-zero code. A no-reply is an honest empty, never a fabricated
// success (CLI-04, the prime directive).
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { ChanliveHandle } from "../harness/chanlive-handle.js";
import { rpcRequest } from "../../support/daemon-harness.js";
import {
  startStandaloneRig,
  RIG_CHANNELS,
  type RigChannel,
  type StandaloneRig,
  type StandaloneRigOptions,
  type StandaloneRigDeps,
} from "../harness/rig.js";
import { readMirrorText } from "../assert/channel-trace.js";
// NOTE: `wait.ts` statically imports `@comis/observability` (runtime values), the
// ONE bare `@comis/*` specifier in this CLI's static graph. It is imported
// TYPE-ONLY here and `await import()`-ed lazily inside the `wait`/`traj` verbs so
// the HTTP/handle verbs (status/send/last/history/rpc/explain/fleet/mirror/db)
// stay runnable via a bare `tsx test/live/bin/chan.ts …` (a raw shell, no vitest
// alias map). `rpcRequest`/`startStandaloneRig` are safe statically: their
// `@comis/*` imports are type-only (erased) + a dynamic `import("@comis/daemon")`
// that only fires when a daemon actually boots (the `tg up` spawn path).
import type {
  WaitSignalOptions,
  WaitSignalResult,
} from "../harness/wait.js";

export type { ChanliveHandle };

/** The exit code for the honest `not_implemented_in_phase` deferral (distinct, non-zero). */
const NOT_IMPLEMENTED_EXIT = 6;

/**
 * An honest, reason-coded verb failure. Carries the closed {@link FailureKind}
 * (one of the four CLI-04 runtime classes) and the `--json` body. `runMain`
 * maps it to `exitCodeFor(kind)` (a distinct non-zero exit) — a thrown
 * VerbFailure can NEVER become a false success.
 *
 * A DEFERRED verb is a distinct honest failure (`not_implemented_in_phase`,
 * exit {@link NOT_IMPLEMENTED_EXIT}) built via {@link VerbFailure.notImplemented}
 * — it keeps the four-class `FailureKind` union pure (the runtime contract)
 * while still exiting non-zero with an honest reason + phase pointer.
 */
export class VerbFailure extends Error {
  /** A four-class runtime kind, or `not_implemented_in_phase` for a deferred verb. */
  readonly kind: FailureKind | "not_implemented_in_phase";
  /** The distinct non-zero exit code this failure exits with. */
  readonly exitCode: number;
  /** The `--json` body (`{ error: <kind>, ...detail }`). */
  readonly body: Readonly<Record<string, unknown>> & { readonly error: string };

  constructor(
    kind: FailureKind | "not_implemented_in_phase",
    detail: Record<string, unknown> = {},
  ) {
    super(`${kind}: ${JSON.stringify(detail)}`);
    this.name = "VerbFailure";
    this.kind = kind;
    this.exitCode = kind === "not_implemented_in_phase" ? NOT_IMPLEMENTED_EXIT : exitCodeFor(kind);
    this.body = { error: kind, ...detail };
  }

  /**
   * An honest deferral: the verb is owned by a LATER phase (207/208). Exits
   * non-zero (never a silent no-op) with `error: "not_implemented_in_phase"`,
   * the verb, and the owning phase. The Deferred-Ideas boundary.
   */
  static notImplemented(verb: string, phase: string): VerbFailure {
    return new VerbFailure("not_implemented_in_phase", {
      verb,
      phase,
      hint: `\`${verb}\` is a Phase ${phase} deliverable — not implemented in this phase (honest deferral, never a silent no-op).`,
    });
  }
}

/**
 * The injectable dispatch context. The defaults wire the real seams
 * (`rpcRequest`, `startStandaloneRig`, `readMirrorText`,
 * `waitForTrajectorySignal`, the global `fetch`); the unit tests pass fakes so
 * the dispatch runs offline with no daemon.
 */
export interface VerbContext {
  /** The resolved handle (gateway URL/token, control endpoint, db path, chat id). */
  readonly handle?: ChanliveHandle;
  /**
   * The resolved channel key (default "telegram", the `tg` alias). Resolved by
   * {@link parseArgs} from `--channel`. Threaded into `up`'s
   * {@link StandaloneRigOptions} (FIX #1: `chan --channel signal up` boots a
   * Signal rig, not the hard-coded Telegram one) AND read by the caps gate
   * (FIX #2: a button/edit-dependent verb honest-degrades on a channel that
   * lacks the capability — `unsupported_on_channel`).
   */
  readonly channel?: string;
  /** The raw `--endpoint` flag (when set, `down` REFUSES to wipe — not our rig). */
  readonly flagEndpoint?: string;
  /** `--json` — emit a machine-readable body. */
  readonly json?: boolean;
  /** The handle-file base dir (default `~/.comis-chanlive`), for `up`/`down`. */
  readonly baseDir?: string;
  /** The model `up` boots with (default "keyless"). */
  readonly model?: string;
  /** The `/rpc` client (default {@link rpcRequest}) — the `tg rpc` passthrough seam. */
  readonly rpc?: (
    gatewayUrl: string,
    method: string,
    params: Record<string, unknown>,
    token: string,
  ) => Promise<unknown>;
  /** The HTTP client for `/control/*` (default global `fetch`). */
  readonly controlFetch?: typeof fetch;
  /** The discover-or-spawn launcher (default {@link startStandaloneRig}) — `up`. */
  readonly startStandaloneRigFn?: (
    opts: StandaloneRigOptions,
    deps?: StandaloneRigDeps,
  ) => Promise<StandaloneRig>;
  /** The trajectory waiter (default {@link waitForTrajectorySignal}) — `wait`. */
  readonly waitFn?: (opts: WaitSignalOptions) => Promise<WaitSignalResult>;
  /** The mirror reader (default {@link readMirrorText}) — `mirror`. */
  readonly readMirror?: (dbPath: string, sessionKey: string) => string | undefined;
  /** The `--event <type>` to block on — `wait` (AUTO-03). Resolved by {@link parseArgs}. */
  readonly event?: string;
  /** The `--tool <name>` to block on — `wait` (AUTO-03). Resolved by {@link parseArgs}. */
  readonly tool?: string;
  /** The `--timeout <ms>` hard ceiling — `wait` (AUTO-03). Resolved by {@link parseArgs}. */
  readonly timeoutMs?: number;
  /** The `--deep` clean-slate sub-flag — `reset --deep`. Resolved by {@link parseArgs}. */
  readonly deep?: boolean;
  /** The `--agent <id>` target — `trigger` (TARGET-01). Resolved by {@link parseArgs}. */
  readonly agent?: string;
  /** The `--restart` sub-flag — `reconfigure` (AUTO-04). Resolved by {@link parseArgs}. */
  readonly restart?: boolean;
  /** The `--detached` sub-flag — `up` (Plan 208-08, the cold-shell rig). Resolved by {@link parseArgs}. */
  readonly detached?: boolean;
  /** The `--set k=v` overrides — `reconfigure` (AUTO-04). Resolved by {@link parseArgs}. */
  readonly set?: Record<string, string>;
}

/**
 * Project a {@link ParsedArgs} into the flag-carrying half of a
 * {@link VerbContext} (everything but the seam fns + the FS-resolved handle).
 * This is the SINGLE source of truth for the flag → ctx mapping, so the real
 * `parseArgs → contextFromParsed → runVerb` path is exercised end-to-end by the
 * unit tests (closing the CR-01 masking gap) and re-used by `resolveContext`.
 * The handle is supplied by the caller (the FS read lives in `resolveContext`).
 */
export function contextFromParsed(
  parsed: ParsedArgs,
  handle?: ChanliveHandle,
): VerbContext {
  return {
    ...(handle !== undefined ? { handle } : {}),
    // Thread the parsed channel (default "telegram") so `up` spawns the RIGHT
    // rig (FIX #1) and the caps gate (FIX #2) keys on the resolved channel.
    channel: parsed.channel,
    ...(parsed.endpoint !== undefined ? { flagEndpoint: parsed.endpoint } : {}),
    json: parsed.json,
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    ...(parsed.event !== undefined ? { event: parsed.event } : {}),
    ...(parsed.tool !== undefined ? { tool: parsed.tool } : {}),
    ...(parsed.timeout !== undefined ? { timeoutMs: parsed.timeout } : {}),
    ...(parsed.deep === true ? { deep: true } : {}),
    ...(parsed.agent !== undefined ? { agent: parsed.agent } : {}),
    ...(parsed.restart === true ? { restart: true } : {}),
    ...(parsed.detached === true ? { detached: true } : {}),
    ...(parsed.set !== undefined ? { set: parsed.set } : {}),
  };
}

/** The recorded-outbound shape the `/control/*` reply-wait returns (subset). */
interface OutboundLine {
  readonly messageId: number;
  readonly text?: string;
}

/** The verbs that drive / read an ALREADY-RUNNING rig (need a resolved handle). */
const REQUIRES_HANDLE = new Set([
  "send",
  "react",
  // Phase 207 interactive/media drive verbs (each POSTs the control routes).
  "tap",
  "edit",
  "send-photo",
  "send-voice",
  "last",
  "history",
  "rpc",
  // AUTO-04 — `tg trigger` reaches the gateway RPCs over WS (needs the handle token).
  "trigger",
  "explain",
  "fleet",
  "mirror",
  "traj",
  "db",
  "wait",
  "down",
  "status",
  "restart",
  "reset",
  // AUTO-04 — `tg reconfigure` is a lifecycle verb (in-process-only across processes).
  "reconfigure",
]);

/**
 * The deferred verbs → the phase that owns them. Each exits with an HONEST
 * `not_implemented_in_phase` carrying the owning phase — never a silent no-op
 * (the Deferred-Ideas boundary). Phase 207 wired send-photo/send-voice/tap/edit
 * to the control routes; only `group` remains (Phase 208).
 */
const DEFERRED_VERBS: Record<string, string> = {
  group: "208",
};

/** Default reply-wait budget (ms) for `send` — bounded so a no-reply fails fast. */
const SEND_WAIT_MS = 45_000;

// ---------------------------------------------------------------------------
// Cold-shell DETACHED-rig lifecycle helpers (Plan 208-08, Option A). A separate
// process reads the handle (pid + rigControlEndpoint) and drives / reaps the
// detached rig. NO half-down / half-restart — honest non-zero on failure.
// ---------------------------------------------------------------------------

/** Grace after a cold-shell SIGTERM before the SIGKILL escalation when reaping a detached rig (ms). */
const DETACHED_DOWN_GRACE_MS = 20_000;
/** Poll cadence for the detached-rig reap (ms). */
const DETACHED_DOWN_PROBE_MS = 250;

/** Is `pid` alive? `kill(pid, 0)` throws ESRCH when not (POSIX liveness probe). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Signal the process GROUP led by `pid` (negative pid → the rig-daemon + its daemon grandchild), then the bare pid. */
function signalDetachedGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // group gone / unsupported — fall through to the single pid.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already gone — honest no-op.
  }
}

/**
 * Reap a detached rig from a COLD SHELL: SIGTERM the process group → wait up to
 * {@link DETACHED_DOWN_GRACE_MS} for the rig PROCESS to be GONE (the group leader
 * dead ⇒ the whole group — rig-daemon + daemon grandchild — reaped) → SIGKILL
 * escalation. The PROCESS-dead check is the no-leak oracle. Returns true when gone.
 */
async function reapDetachedRig(pid: number): Promise<boolean> {
  if (!pidAlive(pid)) return true;
  signalDetachedGroup(pid, "SIGTERM");
  const termDeadline = Date.now() + DETACHED_DOWN_GRACE_MS;
  while (Date.now() < termDeadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, DETACHED_DOWN_PROBE_MS));
  }
  signalDetachedGroup(pid, "SIGKILL");
  const killDeadline = Date.now() + DETACHED_DOWN_GRACE_MS;
  while (Date.now() < killDeadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, DETACHED_DOWN_PROBE_MS));
  }
  return !pidAlive(pid);
}

/** Remove the handle file for a channel (idempotent) — a cold-shell `tg down` cleans the discovery anchor. */
async function removeHandleFile(ctx: VerbContext, channel: string): Promise<void> {
  const { handlePath } = await import("../harness/chanlive-handle.js");
  const { existsSync, rmSync } = await import("node:fs");
  const path = handlePath(channel, ctx.baseDir);
  if (existsSync(path)) rmSync(path, { force: true });
}

/**
 * POST a detached rig-control route (`/restart` / `/reset` / `/reconfigure`),
 * owner-checked with the handle's gateway token. Maps a non-2xx / network error
 * to an honest `dead_handle` (never a fabricated lifecycle success). Returns the
 * parsed JSON body (the rig-control `{ ok, status, … }`).
 */
async function postRigControl(
  ctx: VerbContext,
  handle: ChanliveHandle,
  route: "/restart" | "/reset" | "/reconfigure",
  payload?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const doFetch = ctx.controlFetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${handle.rigControlEndpoint}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${handle.gatewayToken}`,
      },
      body: JSON.stringify(payload ?? {}),
      // A lifecycle re-boot is slow (the daemon grandchild restarts) — generous ceiling.
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e: unknown) {
    throw new VerbFailure("dead_handle", {
      reason: "rig_control_unreachable",
      route,
      endpoint: handle.rigControlEndpoint,
      message: String(e),
    });
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body["ok"] === false) {
    throw new VerbFailure("dead_handle", {
      reason: "rig_control_failed",
      route,
      status: res.status,
      ...body,
    });
  }
  return body;
}

/** Open the isolated `memory.db` READONLY (copy the channel-trace openReadonlyWithVec posture). */
function openReadonlyDb(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true });
  try {
    sqliteVec.load(db);
  } catch {
    // Host lacks sqlite-vec — vec reads degrade; a plain row read is unaffected.
  }
  return db;
}

/** GET the latest recorded outbounds for the handle's chat over `/control/*`. */
async function readOutbound(
  ctx: VerbContext,
  handle: ChanliveHandle,
  afterMessageId: number,
  waitMs: number,
): Promise<OutboundLine[]> {
  const doFetch = ctx.controlFetch ?? fetch;
  const url =
    `${handle.controlEndpoint}/control/chats/${handle.chatId}/outbound` +
    `?afterMessageId=${afterMessageId}&waitMs=${waitMs}`;
  const res = await doFetch(url);
  // WR-03 (false-success-adjacent): verify the HTTP status AND shape BEFORE
  // treating the body as outbounds. A non-2xx (e.g. the control-api's 400
  // `{ok:false,error}` or a 404 object) or any NON-array body would otherwise
  // make `outbounds.length` undefined → the last element undefined → `send`
  // returns `{ reply: undefined }` as an exit-0 SUCCESS. A non-array / non-ok
  // control response is NOT a reply — fail honestly, reason-coded, non-zero.
  if (!res.ok) {
    throw new VerbFailure("dead_handle", { reason: "control_http_error", status: res.status, url });
  }
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) {
    throw new VerbFailure("dead_handle", { reason: "control_bad_shape", url });
  }
  return body as OutboundLine[];
}

/**
 * Resolve the media-bytes arg for `send-photo`/`send-voice` into base64. The arg
 * is EITHER raw base64 (the common path — a scenario / test supplies the bytes
 * directly) OR `@<path>` to read a small fixture file off disk (re-encoded to
 * base64 for the JSON+base64 media transport — no form-data upload). A missing /
 * empty arg, or an unreadable `@<path>`, is a `bad_json` usage error (never a
 * silent empty push). Returns the base64 string the `/media` route expects in
 * `fileBase64`.
 */
function resolveMediaBase64(arg: string | undefined): string {
  if (arg === undefined || arg.length === 0) {
    throw new VerbFailure("bad_json", {
      detail: "send-photo/send-voice <base64|@path> — the media bytes are required.",
    });
  }
  if (arg.startsWith("@")) {
    const path = arg.slice(1);
    try {
      return readFileSync(path).toString("base64");
    } catch (e: unknown) {
      throw new VerbFailure("bad_json", {
        detail: `cannot read media fixture ${JSON.stringify(path)}: ${String(e)}`,
      });
    }
  }
  return arg;
}

/**
 * POST a media inbound (`send-photo`/`send-voice`) to the `/media` control route,
 * then reply-wait like `send`. Shares the `send` shape: the media POST returns a
 * minted `messageId` (the §4.6 `{ ok, messageId }` shape — the new media message
 * id), which becomes the reply-wait watermark; a no-reply is an honest `no_reply`,
 * NEVER a fabricated success (CLI-04 / I5). Honest-exits on a control `!ok` /
 * non-numeric messageId before waiting.
 */
async function sendMedia(
  ctx: VerbContext,
  handle: ChanliveHandle,
  kind: "photo" | "voice",
  args: string[],
): Promise<unknown> {
  const fileBase64 = resolveMediaBase64(args[0]);
  const doFetch = ctx.controlFetch ?? fetch;
  // POST the media inbound (base64 in the JSON body — no form-data upload parser).
  const postRes = await doFetch(
    `${handle.controlEndpoint}/control/chats/${handle.chatId}/media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, fromUserId: 111, fileBase64 }),
    },
  );
  // WR-03: verify the POST status + that a numeric messageId came back BEFORE
  // waiting — a 400/500 (or a body without a numeric messageId) would make the
  // watermark undefined → the reply-wait filter always false → a misleading 45s
  // no_reply. Fail fast + honestly instead (no false exit-0, T-207-14).
  if (!postRes.ok) {
    throw new VerbFailure("dead_handle", { reason: "control_post_error", status: postRes.status });
  }
  const postBody = (await postRes.json()) as { messageId?: unknown };
  const inboundId = postBody.messageId;
  if (typeof inboundId !== "number") {
    throw new VerbFailure("dead_handle", {
      reason: "control_post_error",
      hint: "the media POST returned no numeric messageId — cannot wait for a reply.",
    });
  }
  // Wait once for the reply outbound (the same primitive `send` uses).
  const outbounds = await readOutbound(ctx, handle, inboundId, SEND_WAIT_MS);
  if (outbounds.length === 0) {
    throw new VerbFailure("no_reply", { waitedMs: SEND_WAIT_MS, inboundId });
  }
  const reply = outbounds[outbounds.length - 1];
  return { inboundId, botReplyId: reply?.messageId, reply: reply?.text };
}

/**
 * Resolve the threaded channel (`ctx.channel`, default `"telegram"`) into a
 * known {@link RigChannel}. The channel is the discriminator `up` boots the rig
 * by (FIX #1) and the caps gate keys on (FIX #2). An UNKNOWN channel (one the
 * harness has no rig/caps registration for) is an honest `bad_json` usage error
 * — never a silent fallthrough to telegram (which would mask the typo as a
 * Telegram rig / Telegram caps). The default (no `--channel`) is `"telegram"`,
 * the `tg` alias, so every existing telegram caller is byte-identical.
 */
function resolveRigChannel(ctx: VerbContext): RigChannel {
  const channel = ctx.channel ?? "telegram";
  if (!Object.prototype.hasOwnProperty.call(RIG_CHANNELS, channel)) {
    throw new VerbFailure("bad_json", {
      detail: `unknown --channel "${channel}" (known: ${Object.keys(RIG_CHANNELS).join(", ")}).`,
    });
  }
  return channel as RigChannel;
}

/**
 * Dispatch a `chan`/`tg` verb. Returns the verb's result (printed by `runMain`),
 * or THROWS a {@link VerbFailure} on any honest failure (no-reply / RPC error /
 * dead handle / bad json / deferred / refusal / unsupported-on-channel). NO
 * `process.exit` here — that lives in `runMain`, so this is unit-testable with
 * injected seams.
 */
export async function runVerb(
  verb: string,
  args: string[],
  ctx: VerbContext,
): Promise<unknown> {
  // Deferred verbs exit HONESTLY with not_implemented_in_phase (never a silent no-op).
  const deferredPhase = DEFERRED_VERBS[verb];
  if (deferredPhase !== undefined) {
    throw VerbFailure.notImplemented(verb, deferredPhase);
  }

  // WR-04: `down --endpoint <url>` REFUSES — we only tear down a rig we own,
  // never one addressed by an explicit endpoint. This refusal is INDEPENDENT of
  // whether a local handle file resolved, so it must precede the generic
  // dead-handle guard below; otherwise a `down --endpoint` with no handle file
  // reports a generic `dead_handle` instead of the precise `refused` the guard
  // exists to name (and "never destroy what you didn't spawn" must still hold).
  if (verb === "down" && ctx.flagEndpoint !== undefined) {
    throw new VerbFailure("dead_handle", {
      reason: "refused",
      endpoint: ctx.flagEndpoint,
      hint: "refusing to tear down a rig addressed by --endpoint (never destroy what you didn't spawn).",
    });
  }

  // `up` is the ONLY verb that may run without a resolved handle (it discovers-
  // or-spawns one). Every other handle-requiring verb fails honestly as a dead
  // handle when none resolved — NEVER a silent spawn (T-205-08).
  if (verb !== "up" && REQUIRES_HANDLE.has(verb) && ctx.handle === undefined) {
    throw new VerbFailure("dead_handle", {
      endpoint: ctx.flagEndpoint ?? null,
      hint: "no live rig resolved — run `tg up` to start one (or pass --endpoint).",
    });
  }

  switch (verb) {
    case "up": {
      const launcher = ctx.startStandaloneRigFn ?? startStandaloneRig;
      const opts: StandaloneRigOptions = {
        // FIX #1: thread the PARSED channel (default "telegram") — NOT the
        // pre-patch hard-coded literal. `chan --channel signal up` boots a
        // Signal rig via the RIG_CHANNELS map (209-05); the default + explicit
        // `--channel telegram` stay byte-identical (telegram rig).
        channel: resolveRigChannel(ctx),
        model: ctx.model ?? "keyless",
        ...(ctx.baseDir !== undefined ? { baseDir: ctx.baseDir } : {}),
        // --detached (Plan 208-08, Option A): spawn a DETACHED subprocess rig that
        // OUTLIVES this `tg up` process so a SEPARATE-shell `tg send`/`tg down` can
        // drive it (the cold-shell, shell-only-unattended path). The launcher
        // returns once the detached rig reports healthy; this process then exits and
        // the rig keeps running (its handle carries the pid + rig-control endpoint).
        ...(ctx.detached === true ? { detached: true } : {}),
      };
      const rig = await launcher(opts);
      // Surface the discover-or-spawn outcome + the handle, but NEVER the token.
      const { gatewayToken: _omit, ...safeHandle } = rig.handle;
      void _omit;
      return {
        reused: rig.reused,
        status: rig.reused ? "reused" : "spawned",
        detached: ctx.detached === true,
        handle: safeHandle,
      };
    }

    case "down": {
      // The `down --endpoint` REFUSAL is handled by the early guard above (WR-04)
      // — it fires before the dead-handle guard so the reason is precisely
      // `refused` regardless of handle resolution. Reaching here means no
      // --endpoint was given.
      const handle = ctx.handle as ChanliveHandle;
      // DETACHED rig (Plan 208-08, Option A): the handle carries a `pid` (the
      // detached subprocess's process-group leader). Tear it down for real from a
      // COLD SHELL — SIGTERM the GROUP (the rig-daemon + its daemon grandchild),
      // confirm the rig PROCESS is gone, then remove the handle. NO half-down rig.
      if (handle.pid !== undefined) {
        const reaped = await reapDetachedRig(handle.pid);
        // The detached rig's own teardown removes the handle, but remove it here
        // too (idempotent) so a later `tg up`/discover never resolves a dead rig.
        await removeHandleFile(ctx, handle.channel);
        if (!reaped) {
          // The process would not die even after SIGKILL — an honest non-zero exit
          // (never a fabricated "down" while a daemon lingers — the no-leak absolute).
          throw new VerbFailure("dead_handle", {
            reason: "down_reap_failed",
            pid: handle.pid,
            hint: "the detached rig process did not exit after SIGTERM+SIGKILL — check for a stuck daemon.",
          });
        }
        return { status: "down", detached: true, pid: handle.pid, reaped: true };
      }
      // In-process scope (W1): the rig is owned by its in-process launcher (the
      // 205-06 / 208-07 scenario), NOT a separate process — report honestly rather
      // than fake it. (Use `tg up --detached` for a cold-shell-teardownable rig.)
      return {
        status: "down_not_owned_in_process",
        hint: "this handle has no pid → an in-process rig (torn down by its owner). Use `tg up --detached` for a cold-shell rig `tg down` can SIGTERM.",
      };
    }

    case "status": {
      const handle = ctx.handle as ChanliveHandle;
      return {
        gatewayUrl: handle.gatewayUrl,
        controlEndpoint: handle.controlEndpoint,
        chatId: handle.chatId,
        dataDir: handle.dataDir,
        // No token in the status body.
      };
    }

    case "restart":
    case "reset": {
      // WR-01: branch on the TYPED `--deep` flag (resolved by parseArgs into
      // `ctx.deep`), NOT `args[0]` — parseArgs strips the flag from positionals.
      const resetVerb = verb === "reset" && ctx.deep === true ? "reset --deep" : verb;
      const handle = ctx.handle as ChanliveHandle;
      // DETACHED rig (Plan 208-08, Option A): drive the cold-shell lifecycle for
      // real by POSTing the detached rig-control endpoint (owner-checked with the
      // gateway token). `restart` → /restart; `reset --deep` → /reset (the isolated
      // clean-slate). An honest non-zero exit on a failed POST / unhealthy re-boot.
      if (handle.pid !== undefined) {
        const route = verb === "reset" ? "/reset" : "/restart";
        const body = await postRigControl(ctx, handle, route);
        return { status: route === "/reset" ? "reset" : "restarted", verb: resetVerb, detached: true, ...body };
      }
      // In-process scope (W1): a cold-shell restart/reset against an IN-PROCESS rig
      // is not served (its controller dies with its launcher). Reason-code it.
      return {
        status: "lifecycle_in_process_only",
        verb: resetVerb,
        hint: "this handle has no pid → an in-process rig. Use `tg up --detached` for a cold-shell rig `tg restart`/`reset` can POST.",
      };
    }

    case "reconfigure": {
      // AUTO-04 (the Track-K model sweep) — rewrite the throwaway config with the
      // `--set` overrides + restart.
      const overrides = ctx.set ?? {};
      if (Object.keys(overrides).length === 0) {
        throw new VerbFailure("bad_json", {
          detail: "tg reconfigure --set k=v [--set …] [--restart] — at least one --set override is required.",
        });
      }
      const handle = ctx.handle as ChanliveHandle;
      // DETACHED rig (Plan 208-08, Option A): drive the cold-shell sweep for real —
      // POST the rig-control /reconfigure endpoint with the overrides (the detached
      // rig rewrites its throwaway config + restarts on the same gateway port). An
      // honest non-zero exit on a failed POST / unhealthy re-boot.
      if (handle.pid !== undefined) {
        const body = await postRigControl(ctx, handle, "/reconfigure", { overrides });
        return { status: "reconfigured", verb: "reconfigure", detached: true, overrides, ...body };
      }
      // In-process scope (W1): a cold-shell reconfigure against an IN-PROCESS rig
      // cannot re-pin COMIS_DATA_DIR + re-boot it — ECHO what WOULD have applied so a
      // driving agent sees it (never a silent / fabricated success). The in-proc
      // scenario (208-05 Stage-C) drives `controller.reconfigure(overrides)` directly.
      return {
        status: "lifecycle_in_process_only",
        verb: "reconfigure",
        overrides,
        restart: ctx.restart === true,
        hint: "this handle has no pid → an in-process rig. Use `tg up --detached` for a cold-shell rig `tg reconfigure` can POST.",
      };
    }

    case "send": {
      const handle = ctx.handle as ChanliveHandle;
      const text = args[0] ?? "";
      const doFetch = ctx.controlFetch ?? fetch;
      // POST the inbound.
      const postRes = await doFetch(
        `${handle.controlEndpoint}/control/chats/${handle.chatId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fromUserId: 111, text }),
        },
      );
      // WR-03: verify the POST status + that a numeric messageId came back BEFORE
      // waiting. A 400 body (or any body without a numeric messageId) would make
      // `inboundId` undefined, and the reply-wait's `messageId > undefined`
      // filter is always false → an eventual no_reply after the full 45s wait
      // (a misleading slow failure). Fail fast + honestly instead.
      if (!postRes.ok) {
        throw new VerbFailure("dead_handle", { reason: "control_post_error", status: postRes.status });
      }
      const postBody = (await postRes.json()) as { messageId?: unknown };
      const inboundId = postBody.messageId;
      if (typeof inboundId !== "number") {
        throw new VerbFailure("dead_handle", {
          reason: "control_post_error",
          hint: "the control POST returned no numeric messageId — cannot wait for a reply.",
        });
      }
      // Wait once for the reply outbound.
      const outbounds = await readOutbound(ctx, handle, inboundId, SEND_WAIT_MS);
      if (outbounds.length === 0) {
        // Honest no-reply — NEVER a fabricated success (CLI-04).
        throw new VerbFailure("no_reply", { waitedMs: SEND_WAIT_MS, inboundId });
      }
      const reply = outbounds[outbounds.length - 1];
      return { inboundId, botReplyId: reply?.messageId, reply: reply?.text };
    }

    case "react": {
      // REACT-02 — drive an inbound reaction at the ATTRIBUTED bot reply. The
      // `botReplyId` arg is the agent-authored reply's minted id from `tg send`'s
      // reply-wait return (the `{ inboundId, botReplyId, reply }` above), which is
      // the exact id `recordOutboundMessage` keyed the ReactionTrajectoryMap on
      // (setup-delivery.ts). We react to the ARG, NOT a re-read `tg last` — a
      // re-read could pick a non-attributed message in a multi-message reply, so
      // the 👍 must carry the id the caller passes (the attribution keystone, #5).
      const handle = ctx.handle as ChanliveHandle;
      const botReplyId = Number(args[0]);
      const emoji = args[1];
      if (!Number.isFinite(botReplyId) || emoji === undefined) {
        throw new VerbFailure("bad_json", {
          detail: "tg react <botReplyId> <emoji> — both required (a numeric id + an emoji).",
        });
      }
      const doFetch = ctx.controlFetch ?? fetch;
      // POST the reaction on the attributed reply. `fromUserId: 111` is the rig's
      // fixed reactor id (Plan 03 grants 111 trust ≥ known so the happy path
      // persists; an external reactor under-gates at the production write-floor).
      const res = await doFetch(
        `${handle.controlEndpoint}/control/chats/${handle.chatId}/reactions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fromUserId: 111, botMessageId: botReplyId, emoji }),
        },
      );
      // WR-03 honest-exit: a control !ok is NOT a success — reason-code it as a
      // dead_handle non-zero exit (no false exit-0 on a failed react, I5).
      if (!res.ok) {
        throw new VerbFailure("dead_handle", { reason: "control_post_error", status: res.status });
      }
      return { reacted: { botReplyId, emoji } };
    }

    case "tap": {
      // INTERACT-01 — drive an inbound callback (button tap) at the ATTRIBUTED bot
      // reply. Copied from `react` almost verbatim (the attribution keystone is
      // identical): the `botReplyId` arg is the agent-authored reply's minted id
      // from `tg send`'s reply-wait return (the `{ inboundId, botReplyId, reply }`
      // above). We tap the ARG, NOT a re-read `tg last` — a re-read could pick a
      // non-attributed message in a multi-message reply, so the callback must carry
      // the id the caller passes (T-207-15, the react attribution keystone, #5).
      const handle = ctx.handle as ChanliveHandle;
      const botReplyId = Number(args[0]);
      const data = args[1];
      if (!Number.isFinite(botReplyId) || data === undefined) {
        throw new VerbFailure("bad_json", {
          detail: "tg tap <botReplyId> <callbackData> — both required (a numeric id + the callback data).",
        });
      }
      const doFetch = ctx.controlFetch ?? fetch;
      // POST the callback on the attributed reply. `fromUserId: 111` is the rig's
      // fixed tapper id (same reactor id as `react` — the single-user happy path).
      const res = await doFetch(
        `${handle.controlEndpoint}/control/chats/${handle.chatId}/callbacks`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fromUserId: 111, botMessageId: botReplyId, data }),
        },
      );
      // WR-03 honest-exit: a control !ok is NOT a success — reason-code it as a
      // dead_handle non-zero exit (no false exit-0 on a failed tap, T-207-14).
      if (!res.ok) {
        throw new VerbFailure("dead_handle", { reason: "control_post_error", status: res.status });
      }
      return { tapped: { botReplyId, data } };
    }

    case "edit": {
      // INTERACT-02 — drive an `edited_message` for an EXISTING message id. The
      // edits route mints no id (the §4.6 `{ ok: true }` shape — the edited
      // message already exists), so we return `{ edited: { messageId } }` on a 2xx
      // rather than reply-waiting on a watermark we don't have. (An edit DOES
      // re-ingest through the inbound handler and MAY trigger a reply, but the
      // edit verb's honest contract is the edit landing; the 207-05 scenario reads
      // any resulting reply via the outbound oracle / `tg last`.)
      const handle = ctx.handle as ChanliveHandle;
      const messageId = Number(args[0]);
      const newText = args[1];
      if (!Number.isFinite(messageId) || newText === undefined) {
        throw new VerbFailure("bad_json", {
          detail: "tg edit <messageId> <newText> — both required (a numeric id + the new text).",
        });
      }
      const doFetch = ctx.controlFetch ?? fetch;
      const res = await doFetch(
        `${handle.controlEndpoint}/control/chats/${handle.chatId}/edits`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageId, newText }),
        },
      );
      // WR-03 honest-exit: a control !ok is NOT a success (no false exit-0, T-207-14).
      if (!res.ok) {
        throw new VerbFailure("dead_handle", { reason: "control_post_error", status: res.status });
      }
      return { edited: { messageId } };
    }

    case "send-photo": {
      // MEDIA-01 — POST a photo media inbound (base64) then reply-wait like `send`.
      const handle = ctx.handle as ChanliveHandle;
      return sendMedia(ctx, handle, "photo", args);
    }

    case "send-voice": {
      // MEDIA-01 — POST a voice media inbound (base64) then reply-wait like `send`.
      const handle = ctx.handle as ChanliveHandle;
      return sendMedia(ctx, handle, "voice", args);
    }

    case "last": {
      const handle = ctx.handle as ChanliveHandle;
      const outbounds = await readOutbound(ctx, handle, 0, 0);
      const last = outbounds[outbounds.length - 1];
      if (last === undefined) {
        throw new VerbFailure("no_reply", { waitedMs: 0, hint: "no recorded outbound yet." });
      }
      return { messageId: last.messageId, text: last.text };
    }

    case "history": {
      const handle = ctx.handle as ChanliveHandle;
      const outbounds = await readOutbound(ctx, handle, 0, 0);
      return { count: outbounds.length, outbound: outbounds };
    }

    case "rpc": {
      const handle = ctx.handle as ChanliveHandle;
      const method = args[0];
      if (method === undefined || method.length === 0) {
        throw new VerbFailure("bad_json", { detail: "tg rpc <method> [json] — method is required." });
      }
      // V5: validate the json BEFORE any passthrough.
      const parsed = tryParseJson(args[1] ?? "{}");
      if (!parsed.ok) {
        throw new VerbFailure("bad_json", { detail: parsed.detail, arg: args[1] });
      }
      return invokeRpc(ctx, handle, method, parsed.value);
    }

    case "trigger": {
      // AUTO-04 — fire a time-based event NOW (no real-time wait) via the gateway
      // RPCs the daemon registers, over the SAME WS `invokeRpc` seam `tg rpc` uses:
      //   • cron <id> [--agent A] → cron.run { jobName, agentId? }  (force-mode; an
      //     id is required — force resolves a job BY NAME, "Job not found" otherwise)
      //   • heartbeat [--agent A] → heartbeat.trigger { agentId }   (admin-scoped)
      //   • wake                  → scheduler.wake {}               (debounced tick)
      // A missing/unknown sub-target (or a cron with no id) is an honest bad_json
      // (non-zero, reason-coded — never an exit-0 no-op); an RPC error surfaces as
      // rpc_error via invokeRpc (the gateway answered, the trigger failed honestly).
      const handle = ctx.handle as ChanliveHandle;
      const target = args[0];
      const agentId = ctx.agent;
      switch (target) {
        case "cron": {
          const jobName = args[1];
          if (jobName === undefined || jobName.length === 0) {
            throw new VerbFailure("bad_json", {
              detail: "tg trigger cron <id> [--agent A] — the cron job id/name is required (force mode resolves by name).",
            });
          }
          return invokeRpc(ctx, handle, "cron.run", {
            jobName,
            ...(agentId !== undefined ? { agentId } : {}),
          });
        }
        case "heartbeat":
          return invokeRpc(ctx, handle, "heartbeat.trigger", {
            ...(agentId !== undefined ? { agentId } : {}),
          });
        case "wake":
          return invokeRpc(ctx, handle, "scheduler.wake", {});
        default:
          throw new VerbFailure("bad_json", {
            detail:
              target === undefined
                ? "tg trigger <cron <id>|heartbeat|wake> — a sub-target is required."
                : `tg trigger: unknown sub-target "${target}" (one of: cron <id>, heartbeat, wake).`,
          });
      }
    }

    case "explain": {
      const handle = ctx.handle as ChanliveHandle;
      const ref = args[0];
      if (ref === undefined) {
        throw new VerbFailure("bad_json", { detail: "tg explain <sessionKey|traceId> — a ref is required." });
      }
      // A 2-3-part key looks like a sessionKey; otherwise treat as a traceId.
      const params: Record<string, unknown> = ref.includes(":")
        ? { sessionKey: ref, depth: "summary" }
        : { traceId: ref, depth: "summary" };
      return invokeRpc(ctx, handle, "obs.explain", params);
    }

    case "fleet": {
      const handle = ctx.handle as ChanliveHandle;
      const since = Number(args[0] ?? "24");
      return invokeRpc(ctx, handle, "obs.fleet.health", {
        since: Number.isFinite(since) ? since : 24,
      });
    }

    case "mirror": {
      const handle = ctx.handle as ChanliveHandle;
      const sessionKey = args[0];
      if (sessionKey === undefined) {
        throw new VerbFailure("bad_json", { detail: "tg mirror <sessionKey> — a session key is required." });
      }
      const reader = ctx.readMirror ?? readMirrorText;
      // WR-02: a missing/locked memory.db makes the readonly reader throw a raw
      // sqlite/fs error. That is an oracle-read I/O condition, NOT an RPC
      // failure — reason-code it as a dead_handle so a driving agent branching
      // on the error never confuses it with a gateway/rpc fault.
      let text: string | undefined;
      try {
        text = reader(handle.memoryDbPath, sessionKey);
      } catch (e: unknown) {
        throw new VerbFailure("dead_handle", {
          reason: "mirror_unavailable",
          dbPath: handle.memoryDbPath,
          message: String(e),
        });
      }
      return { sessionKey, text: text ?? null };
    }

    case "traj": {
      const handle = ctx.handle as ChanliveHandle;
      const sessionFile = args[0];
      if (sessionFile === undefined) {
        throw new VerbFailure("bad_json", { detail: "tg traj <sessionFile> — the session file path is required." });
      }
      // Lazy import: wait.ts pulls @comis/observability (see the top-of-file note).
      const { resolveTrajectoryFile } = await import("../harness/wait.js");
      // WR-02: resolveTrajectoryFile soft-fails an absent pointer, but a path/fs
      // error is still possible — classify it honestly as a dead_handle read
      // condition rather than letting it bubble to the generic rpc_error branch.
      let trajFile: string;
      try {
        trajFile = resolveTrajectoryFile(sessionFile);
      } catch (e: unknown) {
        throw new VerbFailure("dead_handle", {
          reason: "trajectory_unavailable",
          sessionFile,
          message: String(e),
        });
      }
      return { dataDir: handle.dataDir, trajectoryFile: trajFile };
    }

    case "db": {
      const handle = ctx.handle as ChanliveHandle;
      const sql = args[0];
      if (sql === undefined || sql.length === 0) {
        throw new VerbFailure("bad_json", { detail: 'tg db "<sql>" — a SQL query is required.' });
      }
      // WR-02: a missing/locked memory.db makes `new Database(...)` throw
      // "unable to open database file" — an oracle I/O condition, not an RPC
      // fault. Map the OPEN failure to dead_handle (the rig isn't live for
      // reads) and a MALFORMED SQL to bad_json (a usage error) — never the
      // generic rpc_error the raw throw would surface.
      let db: Database.Database;
      try {
        db = openReadonlyDb(handle.memoryDbPath);
      } catch (e: unknown) {
        throw new VerbFailure("dead_handle", {
          reason: "db_unavailable",
          dbPath: handle.memoryDbPath,
          message: String(e),
        });
      }
      try {
        const rows = db.prepare(sql).all();
        return { rows };
      } catch (e: unknown) {
        throw new VerbFailure("bad_json", { detail: `SQL error: ${String(e)}`, sql });
      } finally {
        db.close();
      }
    }

    case "wait": {
      // CR-01: `--event`/`--tool`/`--timeout` are resolved by parseArgs into
      // TYPED ctx fields — NOT re-scraped from `args` (parseArgs strips the flag
      // tokens from positionals, so the old `args.indexOf("--event")` was always
      // -1 and the verb could never receive a signal through the real CLI path).
      const { event, tool, timeoutMs } = ctx;
      // The trajectory file is the first positional (now unpolluted by flags —
      // IN-01: resolve the first NON-flag positional so flag order never shadows it).
      const trajFile = args.find((a) => !a.startsWith("--"));
      if (trajFile === undefined) {
        throw new VerbFailure("bad_json", { detail: "tg wait <trajectoryFile> --event <type>|--tool <name>" });
      }
      // Lazy import: wait.ts pulls @comis/observability (see the top-of-file note).
      const waiter =
        ctx.waitFn ?? (await import("../harness/wait.js")).waitForTrajectorySignal;
      const result = await waiter({
        trajectoryFile: trajFile,
        ...(event !== undefined ? { event } : {}),
        ...(tool !== undefined ? { tool } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      if (!result.matched) {
        // settle_timeout / timeout → honest non-zero exit (no false success).
        throw new VerbFailure("no_reply", { reason: result.reason, waitedMs: null });
      }
      return result;
    }

    default:
      throw new VerbFailure("bad_json", {
        detail: `unknown verb "${verb}"`,
        hint: "run a known verb: up/down/status/restart/reset/reconfigure/send/react/tap/edit/send-photo/send-voice/last/history/rpc/trigger/explain/fleet/mirror/traj/db/wait.",
      });
  }
}

/** Invoke the `/rpc` passthrough, mapping the `RPC error …` throw to rpc_error. */
async function invokeRpc(
  ctx: VerbContext,
  handle: ChanliveHandle,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const rpc = ctx.rpc ?? rpcRequest;
  try {
    return await rpc(handle.gatewayUrl, method, params, handle.gatewayToken);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // rpcRequest throws "RPC error <code>: <message>" — extract the code if present.
    const codeMatch = /RPC error\s+(-?\d+):/.exec(message);
    const code = codeMatch?.[1] !== undefined ? Number(codeMatch[1]) : undefined;
    throw new VerbFailure("rpc_error", {
      ...(code !== undefined ? { code } : {}),
      message,
      method,
    });
  }
}

// ---------------------------------------------------------------------------
// runMain — the only place with process.exit / handle resolution. Guarded by an
// isMain check so unit tests import the pure core + runVerb with no side effects.
// ESM main-script detection: tsx sets process.argv[1] to the resolved file path.
// ---------------------------------------------------------------------------

/** Resolve the verb context (the handle + flags) for a real invocation. */
async function resolveContext(parsed: ParsedArgs): Promise<VerbContext> {
  // Lazy import so the pure-core unit tests never pull the handle FS layer.
  const { readHandle } = await import("../harness/chanlive-handle.js");
  const handle = readHandle(parsed.channel);
  // Delegate the flag → ctx projection to the SINGLE source of truth so the real
  // `runMain` path threads `--event`/`--tool`/`--timeout`/`--deep` exactly as the
  // unit tests do (CR-01: the live `tg wait`/`reset --deep` now receive them).
  return contextFromParsed(parsed, handle);
}

/** Run the CLI: parse → resolve ctx → dispatch → print | honest non-zero exit. */
async function runMain(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.verb === undefined) {
    console.error(JSON.stringify(toFailure("bad_json", { detail: "no verb given." })));
    process.exit(exitCodeFor("bad_json"));
    return;
  }
  const ctx = await resolveContext(parsed);
  try {
    const result = await runVerb(parsed.verb, parsed.args, ctx);
    console.log(JSON.stringify(result ?? { ok: true }));
    process.exit(0);
  } catch (err: unknown) {
    if (err instanceof VerbFailure) {
      // Honest, reason-coded non-zero exit — NEVER a false success (CLI-04).
      console.error(JSON.stringify(err.body));
      process.exit(err.exitCode);
      return;
    }
    // An unexpected error is still an honest non-zero exit.
    console.error(JSON.stringify(toFailure("rpc_error", { message: String(err) })));
    process.exit(1);
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("/chan.ts") || process.argv[1].endsWith("/chan.js"));

if (isMain) {
  runMain().catch((err: unknown) => {
    console.error("chan: fatal error:", err);
    process.exit(1);
  });
}
