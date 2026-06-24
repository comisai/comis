// SPDX-License-Identifier: Apache-2.0
/**
 * `comis-agent-cli` — the in-jail `comis-agent` CLI body (Surface 3, v8 §7).
 * {@link runComisAgent} parses an attacker-controlled argv (the agent's own
 * script) into EXACTLY ONE cap-socket call and dispatches it via the injected
 * {@link callCapSocket} (CLI-04 — the lease cap socket, never a WebSocket /
 * gateway client). A `{kind:"tool"}` subcommand rides `tool.invoke`
 * (`callCapSocket("tool.invoke", { tool, args })`); a `{kind:"method"}`
 * subcommand sends the DIRECT method (`callCapSocket(method, params)`).
 *
 * It adds NO authority: the subcommand→target table is {@link CLI_SUBCOMMAND_MAP}
 * (the cap is DERIVED from the existing cap-maps), and the CLI does NO
 * client-side capability pre-check — it sends the call and lets the endpoint's
 * `requireCapability` decide (a denial surfaces as the endpoint's content-free
 * message, never re-implemented here). An unknown subcommand — including the
 * deliberately-absent `skill` (denylisted orch:skill closed door) and the admin
 * verbs `secrets`/`config`/`tokens` (CLI-03) — exits non-zero WITHOUT touching
 * the socket. A missing lease loud-fails (the {@link callCapSocket} reject
 * surfaces as a non-zero exit + a loud stderr naming the env + "jail", CLI-06).
 *
 * Containment (AGENTS.md §2.3): this runs INSIDE the orchestrate jail, so the
 * parser is deliberately DEPENDENCY-FREE — a tiny hand-rolled flag/positional
 * splitter with NO third-party argv-parsing library on the jail surface, and the
 * only import-graph egress is {@link callCapSocket}.
 *
 * @module
 */
import { CLI_SUBCOMMAND_MAP, type CliCallTarget } from "@comis/core";

import type { callCapSocket } from "./orchestrate-sdk-runtime.js";

/** Injected side-effects so the unit test drives the CLI without a real socket. */
export interface ComisAgentDeps {
  /**
   * The cap-socket wire — the real {@link callCapSocket} (from
   * `orchestrate-sdk-runtime.ts`) in the entrypoint; a fake in tests. Typed as
   * `typeof callCapSocket` so the dep can NEVER drift from the real wire's shape.
   */
  readonly callCapSocket: typeof callCapSocket;
  /** stdout sink (defaults to `process.stdout.write`). */
  readonly stdout?: (s: string) => void;
  /** stderr sink (defaults to `process.stderr.write`). */
  readonly stderr?: (s: string) => void;
}

/** The flag/positional split of one argv tail (after the subcommand token). */
interface ParsedArgs {
  readonly positionals: string[];
  readonly flags: Record<string, string | true>;
}

/**
 * A per-subcommand arg spec: how to fold the parsed positionals into named
 * params. The known flags are passed through verbatim (kebab→snake-normalized);
 * `positionals` names each positional slot in order. The LAST named positional
 * is greedy — it absorbs every remaining positional joined by a space (so a
 * `spawn do the thing` multi-word task becomes one `task` string).
 */
interface SubcommandArgSpec {
  /** Ordered names for the positional args (last is greedy). */
  readonly positionals: readonly string[];
}

/**
 * The per-subcommand positional-naming specs. A subcommand absent here takes no
 * positional (all params come from flags). The flags themselves are generic
 * (any `--name value` / `--name` boolean), so only the positional naming is
 * declared. Names match the EXISTING contract/tool param names so the call is a
 * faithful 1:1 (e.g. `spawn`'s positional is `task`; `send`'s is `message`).
 */
const SUBCOMMAND_ARG_SPECS: Readonly<Record<string, SubcommandArgSpec>> = {
  spawn: { positionals: ["task"] },
  run: { positionals: ["graphId"] },
  schedule: { positionals: ["schedule"] },
  send: { positionals: ["message"] },
  search: { positionals: ["query"] },
  fetch: { positionals: ["url"] },
  read: { positionals: ["path"] },
  grep: { positionals: ["pattern"] },
  find: { positionals: ["pattern"] },
  ls: { positionals: ["path"] },
  status: { positionals: ["runId"] },
  // whoami / list take no positional.
};

/** Convert a `--kebab-case` flag name to the `snake_case` param name. */
function flagToParam(name: string): string {
  return name.replace(/-/g, "_");
}

/**
 * Split an argv tail into positionals + flags (dependency-free). Recognizes
 * `--flag value`, `--flag=value`, and a trailing/standalone `--flag` boolean
 * (true when the next token is another `--flag` or absent). Everything else is a
 * positional. No option bundling, no third-party parser — the minimal surface
 * the jail needs.
 */
function parseArgs(tail: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < tail.length; i++) {
    const tok = tail[i];
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[flagToParam(body.slice(0, eq))] = body.slice(eq + 1);
        continue;
      }
      const next = tail[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[flagToParam(body)] = next;
        i++;
      } else {
        flags[flagToParam(body)] = true;
      }
      continue;
    }
    positionals.push(tok);
  }
  return { positionals, flags };
}

/**
 * Coerce a flag value: `true` (boolean flag) stays boolean; a numeric string
 * stays a string UNLESS it is a clean integer (so `--max-steps 5` → `5`). The
 * endpoint/contracts validate the final shape; this keeps obvious numerics
 * numeric without a schema in the jail.
 */
function coerceFlag(value: string | true): string | number | boolean {
  if (value === true) return true;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

/**
 * Fold parsed args into a flat params object: each named positional slot (last
 * greedy) plus every flag (coerced). The result is the `params` for a
 * `{kind:"method"}` call, or the `args` for a `{kind:"tool"}` call.
 */
function buildParams(spec: SubcommandArgSpec | undefined, parsed: ParsedArgs): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const names = spec?.positionals ?? [];
  for (let i = 0; i < names.length; i++) {
    const isLast = i === names.length - 1;
    if (isLast) {
      const rest = parsed.positionals.slice(i);
      if (rest.length > 0) params[names[i]] = rest.join(" ");
    } else if (parsed.positionals[i] !== undefined) {
      params[names[i]] = parsed.positionals[i];
    }
  }
  for (const [k, v] of Object.entries(parsed.flags)) {
    params[k] = coerceFlag(v);
  }
  return params;
}

/**
 * Resolve the subcommand token (handling the two-token `status list` alias) to
 * its {@link CliCallTarget} and the argv tail to fold into params. Returns
 * `undefined` for an unknown/absent verb (incl. `skill` + the admin verbs).
 */
function resolveSubcommand(
  argv: readonly string[],
): { sub: string; target: CliCallTarget; tail: string[] } | undefined {
  const sub = argv[0];
  if (sub === undefined) return undefined;
  // Two-token alias: `status list` → the `list` table entry (consume both).
  if (sub === "status" && argv[1] === "list") {
    return { sub: "list", target: CLI_SUBCOMMAND_MAP.list, tail: argv.slice(2) };
  }
  const target = (CLI_SUBCOMMAND_MAP as Record<string, CliCallTarget>)[sub];
  if (target === undefined) return undefined;
  return { sub, target, tail: argv.slice(1) };
}

/**
 * Render a result for stdout. Strings pass through; everything else is
 * JSON-stringified (pretty) so a structured `{ runId }` is readable.
 */
function renderResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

/**
 * Parse `argv` into exactly one cap-socket call and dispatch it. Returns the
 * process exit code (0 success; 2 unknown/absent subcommand; 1 a call
 * reject/transport/denial). Does NO client-side capability pre-check — the
 * endpoint's `requireCapability` is the only gate.
 *
 * @param argv - The subcommand + its args (`process.argv.slice(2)` in the entry).
 * @param deps - Injected callCapSocket + stdout/stderr sinks (test seam).
 * @returns The exit code.
 */
export async function runComisAgent(argv: readonly string[], deps: ComisAgentDeps): Promise<number> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const stderr = deps.stderr ?? ((s: string) => void process.stderr.write(s));

  const resolved = resolveSubcommand(argv);
  if (resolved === undefined) {
    const given = argv[0] ?? "(none)";
    const known = Object.keys(CLI_SUBCOMMAND_MAP).sort().join(", ");
    stderr(`comis-agent: no such subcommand: ${given}\n` + `available subcommands: ${known}\n`);
    return 2;
  }

  const { target, tail } = resolved;
  const parsed = parseArgs(tail);

  let method: string;
  let params: Record<string, unknown>;
  if (target.kind === "tool") {
    const spec = SUBCOMMAND_ARG_SPECS[resolved.sub];
    method = "tool.invoke";
    params = { tool: target.tool, args: buildParams(spec, parsed) };
  } else {
    const spec = SUBCOMMAND_ARG_SPECS[resolved.sub];
    method = target.method;
    params = buildParams(spec, parsed);
  }

  try {
    const result = await deps.callCapSocket(method, params);
    stdout(renderResult(result) + "\n");
    return 0;
  } catch (err) {
    // Content-free (§2.7): surface the endpoint's `{error}` string (or the
    // callCapSocket loud-fail message naming the env + jail) only — never the
    // lease/socket/params.
    const message = err instanceof Error ? err.message : "comis-agent: call failed";
    stderr(message + "\n");
    return 1;
  }
}
