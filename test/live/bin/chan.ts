// SPDX-License-Identifier: Apache-2.0
/**
 * `chan` / `tg` — the standalone channel-driver CLI (Phase 205, Plan 05).
 *
 * `tg` is the alias `chan --channel telegram`. This is the agent/shell driver
 * that replaces the ad-hoc `/tmp/chat.sh` + `/tmp/vps.sh` scripts for the
 * channel surface: a THIN client over the three surfaces the handle records —
 * the emulator `/control/*` (drive verbs: send / react / last / history), the
 * gateway `/rpc` (the `tg rpc` AUTO-01 verbatim passthrough + the curated
 * explain / fleet), and the rig lifecycle (up / down / status / restart /
 * reset --deep).
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
const STRING_FLAGS = new Set(["--channel", "--endpoint", "--model", "--event", "--tool"]);

/** The boolean sub-flags (presence-only; consume no value). */
const BOOLEAN_FLAGS = new Set(["--json", "--deep"]);

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
  let endpoint: string | undefined;
  let model: string | undefined;
  let event: string | undefined;
  let tool: string | undefined;
  let timeout: number | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (BOOLEAN_FLAGS.has(tok)) {
      if (tok === "--json") json = true;
      else if (tok === "--deep") deep = true;
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
    if (STRING_FLAGS.has(tok)) {
      const value = argv[i + 1];
      i++; // consume the value token
      if (value === undefined) continue;
      if (tok === "--channel") channel = value;
      else if (tok === "--endpoint") endpoint = value;
      else if (tok === "--model") model = value;
      else if (tok === "--event") event = value;
      else if (tok === "--tool") tool = value;
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
    ...(timeout !== undefined ? { timeout } : {}),
    ...(deep ? { deep } : {}),
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

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { ChanliveHandle } from "../harness/chanlive-handle.js";
import { rpcRequest } from "../../support/daemon-harness.js";
import {
  startStandaloneRig,
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
    ...(parsed.endpoint !== undefined ? { flagEndpoint: parsed.endpoint } : {}),
    json: parsed.json,
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    ...(parsed.event !== undefined ? { event: parsed.event } : {}),
    ...(parsed.tool !== undefined ? { tool: parsed.tool } : {}),
    ...(parsed.timeout !== undefined ? { timeoutMs: parsed.timeout } : {}),
    ...(parsed.deep === true ? { deep: true } : {}),
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
  "last",
  "history",
  "rpc",
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
]);

/**
 * The deferred verbs → the phase that owns them. Each exits with an HONEST
 * `not_implemented_in_phase` carrying the owning phase — never a silent no-op
 * (the Deferred-Ideas boundary: send-photo/send-voice/tap/edit → 207, group → 208).
 */
const DEFERRED_VERBS: Record<string, string> = {
  "send-photo": "207",
  "send-voice": "207",
  tap: "207",
  edit: "207",
  group: "208",
};

/** Default reply-wait budget (ms) for `send` — bounded so a no-reply fails fast. */
const SEND_WAIT_MS = 45_000;

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
  return (await res.json()) as OutboundLine[];
}

/**
 * Dispatch a `chan`/`tg` verb. Returns the verb's result (printed by `runMain`),
 * or THROWS a {@link VerbFailure} on any honest failure (no-reply / RPC error /
 * dead handle / bad json / deferred / refusal). NO `process.exit` here — that
 * lives in `runMain`, so this is unit-testable with injected seams.
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
        channel: "telegram",
        model: ctx.model ?? "keyless",
        ...(ctx.baseDir !== undefined ? { baseDir: ctx.baseDir } : {}),
      };
      const rig = await launcher(opts);
      // Surface the discover-or-spawn outcome + the handle, but NEVER the token.
      const { gatewayToken: _omit, ...safeHandle } = rig.handle;
      void _omit;
      return { reused: rig.reused, status: rig.reused ? "reused" : "spawned", handle: safeHandle };
    }

    case "down": {
      // The `down --endpoint` REFUSAL is handled by the early guard above (WR-04)
      // — it fires before the dead-handle guard so the reason is precisely
      // `refused` regardless of handle resolution. Reaching here means no
      // --endpoint was given.
      //
      // In-process scope (W1): the standalone CLI cannot tear down a separate-
      // process rig from a cold shell. Report honestly rather than fake it.
      return {
        status: "down_not_owned_in_process",
        hint: "a cold-shell `tg down` of a separate-process rig is a Phase 208 deliverable; the in-process rig is torn down by its owner (the 205-06 scenario).",
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
      // W1 honesty: the rig controller is IN-PROCESS (205-04) — a cold-shell
      // `tg restart`/`tg reset --deep` against a separate-process rig is NOT
      // served this phase. Reason-code it; the in-proc scenario (205-06) drives
      // the controller directly.
      //
      // WR-01: branch on the TYPED `--deep` flag (resolved by parseArgs into
      // `ctx.deep`), NOT `args[0]` — parseArgs strips the flag from positionals,
      // so `args[0] === "--deep"` was ALWAYS false and `reset --deep` was
      // indistinguishable from a plain `reset` in the reported body.
      const resetVerb = verb === "reset" && ctx.deep === true ? "reset --deep" : verb;
      return {
        status: "lifecycle_in_process_only",
        verb: resetVerb,
        hint: "a cross-process `tg restart`/`reset --deep` needs the detached-subprocess rig (Phase 208); the in-process controller is driven by the 205-06 scenario.",
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
      const { messageId: inboundId } = (await postRes.json()) as { messageId: number };
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
      // The record-outbound base only — the inbound-reaction loop is Phase 206.
      const handle = ctx.handle as ChanliveHandle;
      const outbounds = await readOutbound(ctx, handle, 0, 0);
      return { reactionsScope: "record-outbound-only (inbound reactions: Phase 206)", count: outbounds.length };
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
        hint: "run a known verb: up/down/status/restart/reset/send/react/last/history/rpc/explain/fleet/mirror/traj/db/wait.",
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
