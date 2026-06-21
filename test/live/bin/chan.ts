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

/** The string-valued flags (consume the NEXT token as their value). */
const STRING_FLAGS = new Set(["--channel", "--endpoint", "--model"]);

/**
 * Parse the `chan`/`tg` CLI argv into a {@link ParsedArgs}. PURE — no side
 * effects. The first non-flag token is the verb; the rest are positional args
 * (quote-stripped). `--json` is a boolean flag; `--channel`/`--endpoint`/
 * `--model` consume the next token. The channel defaults to "telegram".
 */
export function parseArgs(argv: string[]): ParsedArgs {
  let channel = "telegram";
  let json = false;
  let endpoint: string | undefined;
  let model: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok === "--json") {
      json = true;
      continue;
    }
    if (STRING_FLAGS.has(tok)) {
      const value = argv[i + 1];
      i++; // consume the value token
      if (value === undefined) continue;
      if (tok === "--channel") channel = value;
      else if (tok === "--endpoint") endpoint = value;
      else if (tok === "--model") model = value;
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
// isMain guard (mirrors runner.ts:114-120). All network / process.exit live in
// runVerb / runMain (Task 2); Task 1 is the pure, unit-testable core above.
// ESM main-script detection: tsx sets process.argv[1] to the resolved file path.
// ---------------------------------------------------------------------------

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("/chan.ts") || process.argv[1].endsWith("/chan.js"));

if (isMain) {
  // Task 2 wires runMain() here (parseArgs → resolve ctx → runVerb), guarded so
  // unit tests can import the pure core with no side effects.
  void isMain;
}
