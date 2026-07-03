// SPDX-License-Identifier: Apache-2.0
/**
 * `orchestrate-preflight` — three pure, total static-analysis helpers for the
 * orchestrate PTC runner. No eval, no fs, no net: a TS-tolerant token scan over
 * the model-authored script (read as INERT TEXT — it is neither run nor an
 * injection sink) plus two total string projections.
 *
 *   - {@link extractCapabilityFootprint} — scans `comis_tools.<method>(` call
 *     sites and maps each method to its {@link AgentCapability} via
 *     `TOOL_CAPABILITY_MAP` (the single source of truth). Whitespace/newline
 *     tolerant across the `comis_tools . method` boundary; the ts/js floor is
 *     the `comis_tools.<m>(` form (a python `from comis_tools import x` bare
 *     call is out of the floor and falls through to the endpoint). Methods not
 *     in the cap-map are REPORTED as data (`unknownMethods`), never thrown.
 *   - {@link classifyRecoverableStderr} — projects a bounded, already-scrubbed
 *     stderr tail onto a CLOSED recoverable class (or `undefined`); it never
 *     executes or reflects the tail.
 *   - {@link buildDescribeDigest} — a deterministic name+capability projection
 *     of `TOOL_CAPABILITY_MAP` for the repair prompt (no clock/random).
 *
 * ADVISORY ONLY: this module REPORTS a footprint + a class — it grants nothing.
 * The authoritative deny stays at the jail cap-socket endpoint (default-deny by
 * absence); a script that obfuscates or dodges the scan is still denied there.
 * Pure: no I/O, no globals, no ambient state; total over any finite input.
 *
 * @module
 */
import { TOOL_CAPABILITY_MAP, type AgentCapability } from "@comis/core";

/** The declared capability footprint of a script: the caps, the known methods, the unknowns. */
export interface CapabilityFootprint {
  /** The distinct {@link AgentCapability} values the script's call sites require. */
  readonly caps: ReadonlySet<AgentCapability>;
  /** The sorted, deduped cap-mapped method names the script calls. */
  readonly methods: readonly string[];
  /** The sorted, deduped `comis_tools.<x>(` methods NOT in the cap-map (advisory). */
  readonly unknownMethods: readonly string[];
}

/**
 * Match a `comis_tools.<ident>(` call site — the ts/js floor. `\s*` around the
 * dot makes it tolerant of newlines/indentation between `comis_tools`, `.`, and
 * the method; the capture group is the method identifier.
 */
const CALL_SITE_RE = /\bcomis_tools\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

/**
 * Statically extract the capability footprint of a model-authored script by
 * scanning its `comis_tools.<method>(` call sites and mapping each method to its
 * required capability via `TOOL_CAPABILITY_MAP`. Reads the script as inert text
 * (no eval/fs/net). Total: an unknown method is DATA in `unknownMethods`, never
 * an error; a script with no call sites yields three empty results.
 */
export function extractCapabilityFootprint(script: string): CapabilityFootprint {
  const caps = new Set<AgentCapability>();
  const methods = new Set<string>();
  const unknownMethods = new Set<string>();
  for (const match of script.matchAll(CALL_SITE_RE)) {
    const method = match[1];
    const cap = TOOL_CAPABILITY_MAP[method as keyof typeof TOOL_CAPABILITY_MAP];
    if (cap) {
      caps.add(cap);
      methods.add(method);
    } else {
      unknownMethods.add(method);
    }
  }
  return {
    caps,
    methods: [...methods].sort(),
    unknownMethods: [...unknownMethods].sort(),
  };
}

/**
 * Classify a bounded stderr tail into a known-recoverable failure class, or
 * `undefined` for anything else. Ordered first-match: `bad_import` (a missing
 * module/package/import), then `comis_tools_misuse` (a `comis_tools` reference
 * paired with a Type/Attribute error shape), then `syntax_error` (a malformed
 * script body — the most frequent weak-model authoring failure; Node and Python
 * both emit the exact token `SyntaxError`), then the generic `type_error`. The
 * misuse class is tested BEFORE `syntax_error`/`type_error` so a `comis_tools`
 * TypeError classifies as misuse; `syntax_error` is kept a DISTINCT class (not
 * folded into a generic bucket) so its one-shot-repair success rate stays
 * separately observable. The classes are disjoint in practice (a SyntaxError tail
 * carries no Import/Type/Attribute token), so a `comis_tools` SyntaxError still
 * classifies as `syntax_error`, not misuse. Case-sensitive: the token names are
 * engine-emitted. Pure: a bounded regex projection — it never executes or reflects
 * the tail. A repaired script re-runs in the SAME jail, so a bad regeneration
 * still fails closed at the cap-socket endpoint.
 */
export function classifyRecoverableStderr(
  tail: string,
): "bad_import" | "comis_tools_misuse" | "syntax_error" | "type_error" | undefined {
  if (/ImportError|ModuleNotFoundError|ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/.test(tail)) {
    return "bad_import";
  }
  if (
    /comis_tools/.test(tail) &&
    /TypeError|AttributeError|is not a function|has no attribute/.test(tail)
  ) {
    return "comis_tools_misuse";
  }
  if (/SyntaxError/.test(tail)) {
    return "syntax_error";
  }
  if (/TypeError|AttributeError/.test(tail)) {
    return "type_error";
  }
  return undefined;
}

/**
 * Build a deterministic, bounded digest of the available `comis_tools` methods
 * grouped by the capability each requires — a pure projection of
 * `TOOL_CAPABILITY_MAP` the repair prompt hands the utility model. Caps and the
 * methods within each are sorted, so two calls are byte-identical (no
 * clock/random). The `orch:*` cap identifiers and method names are real code
 * identifiers (kept verbatim).
 */
export function buildDescribeDigest(): string {
  const byCap = new Map<AgentCapability, string[]>();
  for (const [method, cap] of Object.entries(TOOL_CAPABILITY_MAP) as [string, AgentCapability][]) {
    const bucket = byCap.get(cap);
    if (bucket) {
      bucket.push(method);
    } else {
      byCap.set(cap, [method]);
    }
  }
  const lines: string[] = ["comis_tools methods and the capability each requires:"];
  for (const [cap, capMethods] of [...byCap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push("", `${cap}:`);
    for (const method of [...capMethods].sort()) {
      lines.push(`  ${method} (${cap})`);
    }
  }
  return lines.join("\n");
}
