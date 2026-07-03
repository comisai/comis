// SPDX-License-Identifier: Apache-2.0
/**
 * The dated, append-only, NEVER-OVERWRITTEN results ledger -- the per-release
 * history that makes the continuous regression gate real. Every scheduled gate
 * run appends ONE dated row carrying
 * {date, commit, branch, systemVersions, tier, judgeSpread, N, significance,
 * cost, latency}; a prior dated entry can NEVER be mutated or overwritten by a
 * later release.
 *
 * THE NEVER-OVERWRITE MECHANISM (verified against
 * fs-safe.ts:436-452): `writeRegularFile`'s default
 * `unlinkExisting:true` does `fs.unlinkSync(path)` (swallowing ENOENT) and THEN
 * opens with O_EXCL on the now-clean path -- so it SILENTLY OVERWRITES a
 * pre-existing dated file. The O_EXCL there is anti-TOCTOU-symlink-recreation,
 * NOT anti-clobber. The assumption that "O_EXCL gives never-overwrite for free"
 * was FALSE on the default path. The invariant is therefore enforced HERE by an explicit
 * `existsSync` guard in {@link appendLedgerRow}: a write to an already-existing
 * dated path is REFUSED (returns `err`) and the prior bytes are left untouched.
 * The dated filename embeds the commit (`<date>-<commit>.json`), so two runs of
 * DIFFERENT commits on the same day are non-colliding, while a re-run of the
 * SAME commit is correctly refused (it would clobber a committed row). The RED
 * Test-3 in results-ledger.test.ts proves the real semantics (2nd same-path
 * write refused + 1st file byte-identical).
 *
 * SECURITY -- structural secret omission (the suite-report.ts / qa-report.ts
 * doctrine): the row is persisted via `writeRegularFile`, OUTSIDE
 * Pino's redaction net, so the builder must guarantee no credential ever reaches
 * the file. It does so STRUCTURALLY: the input is NEVER spread; every field is
 * rebuilt field-by-field; `systemVersions` is rematerialized as a null-prototype
 * map (prototype-pollution-safe) whose free-form URI values are run through
 * {@link sanitizeModelUri} (userinfo + query/fragment stripped); `cost`/`latency`
 * are rebuilt via {@link pickCost}/{@link pickLatency} (numbers only); `judgeSpread`
 * is rebuilt per-entry. An off-contract secret hung anywhere on the input has no
 * path to the output. (RED gate: results-ledger.test.ts Test 2 asserts the
 * serialized row matches none of /apiKey|sk-|Bearer|secret@/.)
 *
 * SECURITY -- path confinement: the dated path is composed via
 * `safePath(historyDir, filename)` (rejects traversal/null-byte/symlink escape,
 * per OWASP V12 -- the source-rules safePath gate), and `writeRegularFile` is
 * additionally given `confinedBaseDir: historyDir` (O_NOFOLLOW + assertConfinedPath).
 * A traversal-shaped commit segment yields an `err`, never a write outside the dir.
 *
 * GLOBALS: `timestamp` is `systemDateFrom(nowMs).toISOString()` with `nowMs`
 * INJECTED by the caller -- never a wall-clock read (the bench modules are `src/`;
 * `globals.test.ts` forbids `Date.now()`/`new Date()`). Mirrors suite-report.ts /
 * qa-report.ts / filesystem-baseline.ts.
 *
 * ARCHITECTURE CUT (architecture-graph.test.ts:133): a pure builder + a confined
 * writer; the agent package may NOT import the memory package. Imports are limited
 * to `systemDateFrom` + `safePath` from `@comis/core`, `writeRegularFile` from
 * `@comis/observability`, `ok`/`err`/`Result` from `@comis/shared`, `existsSync`
 * from `node:fs`, and in-package TYPES (`CategorySpread`, `ProportionTest`,
 * `BenchmarkCost`, `BenchmarkLatency`). No `@comis/memory`.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { systemDateFrom, safePath, PathTraversalError } from "@comis/core";
import { writeRegularFile } from "@comis/observability";
import { ok, err, type Result } from "@comis/shared";
import type { CategorySpread } from "./cross-judge-spread.js";
import type { ProportionTest } from "./significance.js";
import type { BenchmarkCost, BenchmarkLatency } from "./qa-report.js";

/**
 * One dated ledger row -- the per-release regression-gate record. The headline
 * accuracy is NOT stored here directly (it lives in the per-run manifest the
 * row's tier points at); the row carries the believability metadata that makes a
 * cross-release comparison trustworthy: the commit + branch + system versions
 * (what produced it), N + significance (is the number real), cost + latency (at
 * what spend/speed), and the per-category judge spread (is it stable across
 * judges). All structurally secret-free.
 */
export interface LedgerRow {
  /** The run date (YYYY-MM-DD; the dated-history key, half of the filename). */
  date: string;
  /** The Comis commit SHA the run measured (the other half of the filename). */
  commit: string;
  /** The git branch the run was taken on (e.g. "bench/prove-climb"). */
  branch: string;
  /** Component -> version map (e.g. {comis:"1.0.0", pi:"0.78.0"}); URI values sanitized. */
  systemVersions: Record<string, string>;
  /** The benchmark tier (OPEN string -- e.g. "head-to-head", "longmemeval-v2"). */
  tier: string;
  /** The per-category inter-judge spread -- a number headlines only if it survives. */
  judgeSpread: CategorySpread[];
  /** The sample size behind the headline (the N every credible number reports). */
  n: number;
  /** The two-proportion significance result, or null for a degenerate/un-tested run. */
  significance: ProportionTest | null;
  /** Tokens/query (answer + judge) -- the cost axis. */
  cost: BenchmarkCost;
  /** Wall-clock latency (recall/answer/judge/end-to-end, p50/p95) -- the speed axis. */
  latency: BenchmarkLatency;
  /** ISO timestamp derived from the INJECTED `nowMs` (never a wall-clock read). */
  timestamp: string;
}

/**
 * Strip embedded credentials from a free-form URI value (a model/embedding URI a
 * caller may hang on `systemVersions`). Drops userinfo (`user:pass@`) + query +
 * fragment, keeping scheme+host+path. Copied in style from qa-report.ts:243 (the
 * sanitizer there is private to that module). ReDoS-free (non-nested quantifiers).
 *
 * @param uri a version string that MAY be a credentialed URI
 * @returns the sanitized URI (or the input unchanged when it is not a URI)
 */
function sanitizeModelUri(uri: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) return uri; // no authority -> no embedded credential
  try {
    const u = new URL(uri);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    // Unparseable authority URL: fall back to a userinfo strip so a `user:pass@`
    // credential still cannot survive (no worse than the input for anything else).
    return uri.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
  }
}

/**
 * Rebuild the cost block field-by-field (never spreads the input), keeping the
 * optional USD fields only when present. Mirrors qa-report.ts:277 `pickCost`.
 */
function pickCost(c: BenchmarkCost): BenchmarkCost {
  const base: BenchmarkCost = {
    answerTokensPerQuery: c.answerTokensPerQuery,
    judgeTokensPerQuery: c.judgeTokensPerQuery,
    totalTokensPerQuery: c.totalTokensPerQuery,
  };
  if (c.answerCostUsd !== undefined) base.answerCostUsd = c.answerCostUsd;
  if (c.judgeCostUsd !== undefined) base.judgeCostUsd = c.judgeCostUsd;
  return base;
}

/** Rebuild the latency block field-by-field (never spreads the input). qa-report.ts:289. */
function pickLatency(l: BenchmarkLatency): BenchmarkLatency {
  return {
    recallP50Ms: l.recallP50Ms,
    recallP95Ms: l.recallP95Ms,
    answerP50Ms: l.answerP50Ms,
    answerP95Ms: l.answerP95Ms,
    judgeP50Ms: l.judgeP50Ms,
    judgeP95Ms: l.judgeP95Ms,
    endToEndP50Ms: l.endToEndP50Ms,
    endToEndP95Ms: l.endToEndP95Ms,
  };
}

/** Rebuild one cross-judge spread entry field-by-field (never spreads the input). */
function pickSpread(s: CategorySpread): CategorySpread {
  return { category: s.category, judgeA: s.judgeA, judgeB: s.judgeB, spread: s.spread, survives: s.survives };
}

/** Rebuild the two-proportion test field-by-field, or null (never spreads the input). */
function pickSignificance(sig: ProportionTest | null): ProportionTest | null {
  return sig === null ? null : { n: sig.n, pValue: sig.pValue, significant: sig.significant };
}

/**
 * Rebuild the `systemVersions` map as a fresh null-prototype object with
 * literal-keyed writes (prototype-pollution-safe), running each VALUE through
 * {@link sanitizeModelUri} so a credentialed model URI cannot leak. The keys are
 * component names supplied by the caller; treating the map as null-proto means a
 * `__proto__`/`constructor` key is an ordinary own data property, never a
 * prototype mutation (the qa-accuracy.ts:135 discipline).
 */
function pickSystemVersions(versions: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(versions)) {
    // Coerce to string then sanitize -- a value is never spread or copied as an object.
    out[key] = sanitizeModelUri(String(versions[key]));
  }
  return out;
}

/**
 * Build a structurally-secret-free {@link LedgerRow} from the run metadata + an
 * injected `nowMs`.
 *
 * SECURITY: the input is NEVER spread -- every field is rebuilt field-by-field
 * (primitives copied; `systemVersions` rematerialized + URI-sanitized;
 * `judgeSpread`/`cost`/`latency`/`significance` rebuilt via their pickers), so no
 * off-contract credential field hung on the input can reach the output (and thus
 * the persisted file). The timestamp uses the injected clock.
 *
 * @param input the row metadata (everything but the timestamp)
 * @param nowMs the INJECTED epoch ms for the timestamp (never a wall-clock read)
 * @returns the rebuilt {@link LedgerRow}
 */
export function buildLedgerRow(input: Omit<LedgerRow, "timestamp">, nowMs: number): LedgerRow {
  return {
    date: input.date,
    commit: input.commit,
    branch: input.branch,
    systemVersions: pickSystemVersions(input.systemVersions),
    tier: input.tier,
    judgeSpread: input.judgeSpread.map(pickSpread),
    n: input.n,
    significance: pickSignificance(input.significance),
    cost: pickCost(input.cost),
    latency: pickLatency(input.latency),
    timestamp: systemDateFrom(nowMs).toISOString(),
  };
}

/**
 * Compose the dated ledger-row path `<historyDir>/<date>-<commit>.json` via
 * {@link safePath} (OWASP V12 -- rejects traversal/null-byte/symlink escape, the
 * source-rules safePath gate). The commit-in-the-filename makes same-day
 * DIFFERENT-commit runs non-colliding while a same-commit re-run resolves to the
 * SAME path (and is then refused by {@link appendLedgerRow}'s existsSync guard).
 *
 * @param historyDir the absolute committed history directory
 * @param date the run date (YYYY-MM-DD)
 * @param commit the commit SHA
 * @returns the validated absolute path (throws {@link PathTraversalError} on escape)
 */
export function ledgerRowPath(historyDir: string, date: string, commit: string): string {
  return safePath(historyDir, `${date}-${commit}.json`);
}

/** Options for {@link appendLedgerRow}. */
export interface AppendLedgerRowOptions {
  /** The absolute committed history directory (the confinement base). */
  historyDir: string;
  /** The (already-built, secret-free) row to append. */
  row: LedgerRow;
}

/** Success payload: the dated path the row was written to. */
export interface AppendLedgerRowSuccess {
  /** The absolute path of the freshly-written dated row file. */
  path: string;
}

/**
 * Append a dated row to the ledger -- the NEVER-OVERWRITE writer.
 * Computes the dated path; **refuses** if a file already exists at
 * that path (the explicit `existsSync` guard -- `writeRegularFile`'s default
 * would SILENTLY clobber it, fs-safe.ts:436-452); else writes it confined to
 * `historyDir`. A traversal-shaped date/commit is rejected at the `safePath`
 * layer (returned as an `err`, never thrown out).
 *
 * @param opts the history dir + the row to append
 * @returns `ok({ path })` on a fresh write; `err` if the dated path already
 *   exists (the never-overwrite refusal), if the path escapes the dir, or if the
 *   confined write fails
 */
export function appendLedgerRow(opts: AppendLedgerRowOptions): Result<AppendLedgerRowSuccess, Error> {
  let path: string;
  try {
    path = ledgerRowPath(opts.historyDir, opts.row.date, opts.row.commit);
  } catch (e) {
    // safePath threw (traversal/null-byte/symlink escape) -- surface as an err,
    // never let it propagate out of the Result boundary.
    if (e instanceof PathTraversalError) return err(e);
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  // THE NEVER-OVERWRITE GUARD: refuse to clobber a prior dated entry.
  // writeRegularFile's default unlinkExisting:true would silently overwrite it
  // (the O_EXCL is anti-TOCTOU-symlink, not anti-clobber -- fs-safe.ts:436-452).
  if (existsSync(path)) {
    return err(new Error(`refusing to overwrite a prior dated ledger entry: ${path}`));
  }

  const written = writeRegularFile({
    path,
    content: JSON.stringify(opts.row, null, 2),
    confinedBaseDir: opts.historyDir,
  });
  if (!written.ok) return err(written.error);
  return ok({ path });
}
