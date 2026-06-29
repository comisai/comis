// SPDX-License-Identifier: Apache-2.0
/**
 * `obs.explain` report-level bounding pass (X2) — the NEW bounding discipline.
 *
 * `boundIncidentReport(report, depth)` enforces the X2 budget on a §6.3
 * {@link IncidentReport} before it leaves the daemon:
 *
 *   - **summary budget** — `depth:"summary"` serializes to ≤ 6144 bytes
 *     (`SUMMARY_MAX_BYTES`), the conservative ~1,500-token proxy at the
 *     ~4 bytes/token rule of thumb (there is no `estimateTokens` util, so the
 *     serialized byte length is the gate). `depth:"full"` relaxes the ARRAY
 *     caps but keeps every per-string cap (digest-only is depth-independent).
 *   - **failures cap** — newest-first, ≤ `SUMMARY_MAX_FAILURES` at summary,
 *     ≤ `FULL_MAX_FAILURES` at full. Dropped tail is recorded in `truncations[]`.
 *   - **breakerTimeline / offloads caps** — the SAME newest-first length cap as
 *     `failures` (≤ `SUMMARY_MAX_BREAKER` / `SUMMARY_MAX_OFFLOADS` at summary,
 *     relaxed at full). A flapping breaker or a heavily-offloading session pushes
 *     one event per transition with NO upstream dedup in the EVENT shape, so
 *     these arrays are reachable at scale (up to the reader's MAX_RECORDS). Both
 *     are ALSO shed in the progressive-shed loop so the byte budget converges.
 *     Without these caps the ≤6144-byte summary guarantee was provably false
 *     (a 2000-event flapping breaker yielded a ~150 KB summary report).
 *   - **errorPreview cap** — ≤ `SUMMARY_MAX_ERROR_PREVIEW_CHARS` per failure at
 *     BOTH depths.
 *   - **digest-only** — NO raw tool-output body is ever inlined. Any string
 *     field that exceeds `MAX_INLINE_STRING` is replaced with its
 *     {@link fingerprint} (a 12-hex digest), guaranteeing the 678 fixture's
 *     50 KB `web_fetch` body + its prompt-injection block ("SECURITY NOTICE")
 *     never survives — regardless of any upstream leak (threat T-153-10). The
 *     sweep covers `summary`, `failures[].errorPreview`, `offloads[].pointer`
 *     AND (WR-03) the report-level free-text scalars `channel.type`/`channel.id`
 *     /`agentId`/`traceId`/`endReason` plus oversized `toolStats` KEYS — all of
 *     which carry untrusted session/peer-derived data and were otherwise bounded
 *     only by the 32 KB structural floor.
 *   - **honest lossiness** — every cap that fires pushes a `TruncationEntry`
 *     onto the `truncations[]` ledger so the consumer can trust the report is
 *     lossy-but-honest, not silently trimmed (threat T-153-12).
 *
 * `limitPayloadValue` (from `@comis/observability`) runs LAST as the structural
 * backstop (32 KB / 64-item / depth-6 with `{__bounded__}` sentinels). It is a
 * DIFFERENT mechanism from this report-level pass: the report-level sentinel is
 * the `{truncated:true,…}`-shaped `truncations[]` ledger entry; the structural
 * backstop sentinel is `{__bounded__:…}`. The two are deliberately NOT
 * conflated. Because this pass already collapses oversized STRINGS to a short
 * fingerprint, the backstop only catches non-string pathological sub-trees that
 * escaped the per-field caps.
 *
 * Pure module — no I/O, no logging, no globals.
 *
 * @module
 */

import { fingerprint } from "@comis/core";
import type { IncidentReport } from "@comis/core";
import { limitPayloadValue } from "@comis/observability";
import {
  capNewestFirst,
  digestIfOversized,
  type TruncationEntry,
} from "./obs-explain-bound-helpers.js";
import {
  SUMMARY_MAX_FAILURES,
  SUMMARY_MAX_BREAKER,
  SUMMARY_MAX_OFFLOADS,
  SUMMARY_MAX_ERROR_PREVIEW_CHARS,
  SUMMARY_MAX_BYTES,
  FULL_MAX_FAILURES,
  FULL_MAX_BREAKER,
  FULL_MAX_OFFLOADS,
  MAX_INLINE_STRING,
  SUMMARY_MAX_CACHE_BREAKS,
  FULL_MAX_CACHE_BREAKS,
  SUMMARY_MAX_SPAWN_NODES,
  FULL_MAX_SPAWN_NODES,
  SUMMARY_MAX_TOOLSTATS,
  FULL_MAX_TOOLSTATS,
  MAX_SHED_ITERATIONS,
  SHED_SUMMARY_CHARS,
} from "./obs-explain-bound-caps.js";

// ---------------------------------------------------------------------------
// X2 report-level caps (distinct from limitPayloadValue's PAYLOAD_BOUNDS) live
// in the sibling obs-explain-bound-caps.ts (file-size-cap-driven extraction,
// 176-05). REPORT_ARRAY_FIELDS stays here (it is consumed only by this module).
// ---------------------------------------------------------------------------

/**
 * The report-level array slots whose length is governed by SUMMARY_MAX_FAILURES
 * / FULL_MAX_FAILURES (which can exceed the backstop's 64-item cap). Exempted
 * from `limitPayloadValue`'s array-length cap so the backstop never replaces a
 * whole array with a sentinel — the per-element string caps inside still apply.
 */
const REPORT_ARRAY_FIELDS: ReadonlySet<string> = new Set([
  "failures",
  "breakerTimeline",
  "offloads",
  // CR-01: spawnTree is report-level-capped below (SUMMARY/FULL_MAX_SPAWN_NODES,
  // both can exceed the backstop's 64-item cap), so exempt it from the structural
  // backstop — otherwise a >64-lease fan-out becomes a {__bounded__} sentinel and
  // the typed `SpawnTreeNode[]` slot fails IncidentReportSchema.parse.
  "spawnTree",
]);

// `TruncationEntry`, `capNewestFirst`, and `digestIfOversized` live in the
// sibling `obs-explain-bound-helpers.ts` (file-size-cap-driven extraction, CR-01).
// Re-export the type so the module's public surface is unchanged.
export type { TruncationEntry };

/**
 * Apply the X2 report-level bounding pass, then the structural backstop.
 *
 * Order matters (see the algorithm comments inline):
 *   1. seed `truncations` from any upstream entries (preserve assembly's ledger),
 *   2. cap `failures[]`, `breakerTimeline[]`, and `offloads[]` to the depth-
 *      appropriate max (newest-first),
 *   3. cap each `errorPreview` to 200 chars (both depths),
 *   4. defensive digest-only sweep: any string > `MAX_INLINE_STRING` → fingerprint,
 *   5. `limitPayloadValue` structural backstop,
 *   6. progressive shed (summary → failures → breakerTimeline → offloads) until
 *      ≤ 6144 bytes at summary depth.
 *
 * @returns the bounded report with an honest `truncations[]` ledger.
 */
export function boundIncidentReport(
  report: IncidentReport,
  depth: "summary" | "full",
): IncidentReport {
  // 1. Preserve any upstream truncations (assembly may have already digested).
  const truncations: TruncationEntry[] = [...report.truncations];

  let failures = report.failures;

  // 2. Cap failures[] newest-first. They arrive newest-first from the
  //    assembler, but re-sort defensively (descending seq) before slicing the
  //    HEAD so "newest" is well-defined regardless of upstream ordering.
  const maxFailures = depth === "summary" ? SUMMARY_MAX_FAILURES : FULL_MAX_FAILURES;
  if (failures.length > maxFailures) {
    const sorted = [...failures].sort((a, b) => b.seq - a.seq);
    failures = sorted.slice(0, maxFailures);
    truncations.push({
      field: "failures",
      reason: `capped at ${maxFailures} newest entries (had ${report.failures.length})`,
      pointer: "obs.explain depth=full",
    });
  }

  // 2b. Cap breakerTimeline[] and offloads[] newest-first — the CR-01 fix. These
  //     arrays were exempt from the structural cap (REPORT_ARRAY_FIELDS) AND
  //     never length-capped here, so a flapping breaker / heavily-offloading
  //     session could blow the ≤6144-byte summary budget (a 2000-event timeline
  //     yielded a ~150 KB summary report). Cap them the same way failures is:
  //     newest-first (highest seq), with an honest truncations[] ledger entry
  //     for the dropped tail. Relaxed at full depth (lossless-by-design there).
  const maxBreaker = depth === "summary" ? SUMMARY_MAX_BREAKER : FULL_MAX_BREAKER;
  const breakerTimeline = capNewestFirst(report.breakerTimeline, maxBreaker, "breakerTimeline", truncations);
  const maxOffloads = depth === "summary" ? SUMMARY_MAX_OFFLOADS : FULL_MAX_OFFLOADS;
  const cappedOffloads = capNewestFirst(report.offloads, maxOffloads, "offloads", truncations);

  // 3+4. Per-failure errorPreview bounding — digest-only FIRST, then the
  //    200-char cap. The order is load-bearing for T-153-10: a grossly
  //    oversized preview (raw-body territory, > MAX_INLINE_STRING) is replaced
  //    WHOLESALE with a fingerprint digest. Slicing it to 200 chars first would
  //    let a head-of-string injection marker ("SECURITY NOTICE" at offset 0)
  //    survive inside the retained 200 chars — so the digest replacement MUST
  //    take precedence over the slice. A merely-long preview (between the
  //    200-char cap and MAX_INLINE_STRING) is a normal error message and gets
  //    the simple 200-char slice. Both depths (digest-only does not relax at
  //    full). The digest replacement keeps the typed `string` shape so the
  //    structural backstop below never coerces this field into a sentinel
  //    object. One aggregate truncation per reason (not per-row) saves bytes.
  let previewSliced = false;
  let previewDigested = false;
  failures = failures.map((f) => {
    if (f.errorPreview.length > MAX_INLINE_STRING) {
      previewDigested = true;
      return {
        ...f,
        errorPreview: `[digest:${fingerprint(f.errorPreview)}]`,
        // Ensure a resultDigest stands in for the dropped body when blank.
        resultDigest: f.resultDigest !== "" ? f.resultDigest : fingerprint(f.errorPreview),
      };
    }
    if (f.errorPreview.length > SUMMARY_MAX_ERROR_PREVIEW_CHARS) {
      previewSliced = true;
      return {
        ...f,
        errorPreview: f.errorPreview.slice(0, SUMMARY_MAX_ERROR_PREVIEW_CHARS),
        resultDigest: f.resultDigest !== "" ? f.resultDigest : fingerprint(f.errorPreview),
      };
    }
    return f;
  });
  if (previewDigested) {
    truncations.push({
      field: "failures[].errorPreview",
      reason: "oversized preview replaced with digest (raw body never inlined)",
    });
  }
  if (previewSliced) {
    truncations.push({
      field: "failures[].errorPreview",
      reason: `preview capped at ${SUMMARY_MAX_ERROR_PREVIEW_CHARS} chars; see resultDigest`,
    });
  }

  // Defensive digest-only sweep for the remaining free-text string fields —
  // the PRIMARY control for T-153-10. Any string > MAX_INLINE_STRING (a raw
  // body that escaped assembly) is replaced with its fingerprint, so a 50 KB
  // injection body can never be emitted. STRING→string keeps the typed shape.
  const summary = digestIfOversized(report.summary, "summary", truncations);

  // WR-03: the SAME digest sweep over the remaining report-level free-text
  // scalars (channel.type/id, agentId, traceId, endReason). These flow from
  // session metadata into the report with no per-field cap; channel.id is
  // channel/peer-derived (attacker-influenced). Without this they were bounded
  // only by limitPayloadValue's 32 KB floor — a 32 KB channel.id would serialize
  // verbatim into a "summary" report. The digest keeps the `string` shape the
  // schema requires (lowering the structural cap would emit a {__bounded__}
  // object instead). endReason is also interpolated into the summary one-liner
  // at assembly time, but that string is itself swept above.
  const channel = {
    type: digestIfOversized(report.channel.type, "channel.type", truncations),
    id: digestIfOversized(report.channel.id, "channel.id", truncations),
  };
  const agentId = digestIfOversized(report.agentId, "agentId", truncations);
  const traceId = digestIfOversized(report.traceId, "traceId", truncations);
  const outcome = {
    ...report.outcome,
    endReason: digestIfOversized(report.outcome.endReason, "outcome.endReason", truncations),
  };

  // WR-03: digest oversized toolStats KEYS (tool names). The keys are untrusted
  // free-text too, and an object key cannot carry a {__bounded__} sentinel, so
  // the structural backstop cannot bound it — only this report-level sweep can.
  // A digested key collides-safely (fingerprint is per-string) and stays short.
  let toolStats = report.toolStats;
  const oversizedToolKey = Object.keys(toolStats).some((k) => k.length > MAX_INLINE_STRING);
  if (oversizedToolKey) {
    const rekeyed: IncidentReport["toolStats"] = {};
    for (const [tool, stat] of Object.entries(toolStats)) {
      const key = tool.length > MAX_INLINE_STRING ? `[digest:${fingerprint(tool)}]` : tool;
      rekeyed[key] = stat;
    }
    truncations.push({
      field: "toolStats",
      reason: `oversized tool name(s) replaced with digest key(s)`,
    });
    toolStats = rekeyed;
  }

  // OBS-TOOLSTATS-SENTINEL: cap the NUMBER of tools. `toolStats` is a RECORD (not an
  // array), so it is NOT exempted from the structural backstop's plain-object KEY cap —
  // a >maxObjectKeys(64) session (long, or a multi-workload trajectory) would have its
  // WHOLE toolStats replaced with a `{__bounded__, originalKeyCount}` sentinel whose
  // values are not `{ok,failed}` objects → IncidentReportSchema.parse throws. Keep the
  // top-N tools FAILURES-FIRST (the diagnostic priority — the report exists to explain
  // failures), then by total activity, as proper objects, recording the dropped tail.
  const maxToolStats = depth === "summary" ? SUMMARY_MAX_TOOLSTATS : FULL_MAX_TOOLSTATS;
  const toolKeys = Object.keys(toolStats);
  if (toolKeys.length > maxToolStats) {
    const ranked = Object.entries(toolStats).sort(([, a], [, b]) => {
      const af = a.failed ?? 0;
      const bf = b.failed ?? 0;
      if (bf !== af) return bf - af; // most failures first
      return (b.ok ?? 0) + bf - ((a.ok ?? 0) + af); // then most-active
    });
    const kept: IncidentReport["toolStats"] = {};
    for (const [tool, stat] of ranked.slice(0, maxToolStats)) kept[tool] = stat;
    truncations.push({
      field: "toolStats",
      reason: `capped at ${maxToolStats} tools (failures-first) — had ${toolKeys.length}`,
      pointer: "obs.explain depth=full",
    });
    toolStats = kept;
  }

  // Per-pointer digest sweep over the ALREADY length-capped offloads (step 2b).
  const offloads = cappedOffloads.map((o) => {
    if (o.pointer.length <= MAX_INLINE_STRING) return o;
    truncations.push({
      field: "offloads[].pointer",
      reason: `oversized (${o.pointer.length} chars) — replaced with digest`,
    });
    return { ...o, pointer: `[digest:${fingerprint(o.pointer)}]` };
  });

  // PERSIST-01 (176-05): cap cacheBreaks? highest-count-first (arrives count-desc
  // from the signals collapse), recording a truncations[] entry for the dropped tail.
  let cacheBreaks = report.cacheBreaks;
  const maxCacheBreaks = depth === "summary" ? SUMMARY_MAX_CACHE_BREAKS : FULL_MAX_CACHE_BREAKS;
  if (cacheBreaks !== undefined && cacheBreaks.length > maxCacheBreaks) {
    truncations.push({
      field: "cacheBreaks",
      reason: `capped at ${maxCacheBreaks} highest-count reasons (had ${cacheBreaks.length})`,
      pointer: "obs.explain depth=full",
    });
    cacheBreaks = cacheBreaks.slice(0, maxCacheBreaks);
  }

  // CR-01 (TREE-01/02): cap spawnTree first-seen (the fold's materialization
  // order — slicing the HEAD keeps the topology head: root + earliest children),
  // recording a truncations[] entry for the dropped tail. Combined with the
  // REPORT_ARRAY_FIELDS exemption above, this keeps the typed `SpawnTreeNode[]`
  // shape so IncidentReportSchema.parse holds even on a deep fan-out.
  let spawnTree = report.spawnTree;
  const maxSpawn = depth === "summary" ? SUMMARY_MAX_SPAWN_NODES : FULL_MAX_SPAWN_NODES;
  if (spawnTree !== undefined && spawnTree.length > maxSpawn) {
    truncations.push({
      field: "spawnTree",
      reason: `capped at ${maxSpawn} nodes (had ${spawnTree.length})`,
      pointer: "obs.explain depth=full",
    });
    spawnTree = spawnTree.slice(0, maxSpawn);
  }

  let bounded: IncidentReport = {
    ...report,
    channel,
    agentId,
    traceId,
    outcome,
    toolStats,
    summary,
    failures,
    breakerTimeline,
    offloads,
    ...(cacheBreaks !== undefined ? { cacheBreaks } : {}),
    ...(spawnTree !== undefined ? { spawnTree } : {}),
    truncations,
  };

  // 5. Structural backstop — catches any sub-tree (non-string, deep, wide) that
  //    escaped the per-field caps. Distinct sentinel ({__bounded__}) from the
  //    report-level truncations[] ledger above; do NOT conflate the two.
  //
  //    The report-level array caps (SUMMARY_MAX_FAILURES=20, FULL_MAX_FAILURES
  //    =200) are the authority on array length — both can EXCEED the backstop's
  //    64-item `maxArrayLength`, so the report-level array slots are exempted
  //    from the backstop's length cap (otherwise the backstop would replace the
  //    whole `failures` array with a `{__bounded__}` sentinel, defeating the
  //    report-level cap AND breaking the typed array shape). The per-element
  //    string caps inside those arrays are still backstop-enforced (the
  //    exemption is on the containing field name only, not its children).
  bounded = limitPayloadValue(bounded, {
    arrayFieldExempt: REPORT_ARRAY_FIELDS,
  }) as IncidentReport;

  // 6. Progressive shed to the summary byte budget. Bounded loop — shed the
  //    largest discretionary fields first (summary prose once, then halve
  //    failures, then halve breakerTimeline, then halve offloads), appending a
  //    report-level truncation each time, until ≤ SUMMARY_MAX_BYTES or no
  //    discretionary field is left to shed. The pre-loop step-2b caps already
  //    bring these arrays to ≤20 at summary, so these branches are a defensive
  //    convergence backstop (e.g. if the per-cap is ever raised) rather than the
  //    primary control — but they ensure the loop can ALWAYS make progress.
  if (depth === "summary") {
    let iterations = 0;
    while (
      Buffer.byteLength(JSON.stringify(bounded), "utf8") > SUMMARY_MAX_BYTES &&
      iterations < MAX_SHED_ITERATIONS
    ) {
      iterations += 1;

      // Summary-shorten fires AT MOST ONCE: guard on the pre-shorten length
      // (> SHED_SUMMARY_CHARS + the ellipsis) so an already-shortened summary
      // does not re-trigger this branch and starve the failures-halve branch.
      if (bounded.summary.length > SHED_SUMMARY_CHARS + 1) {
        bounded = {
          ...bounded,
          summary: `${bounded.summary.slice(0, SHED_SUMMARY_CHARS)}…`,
          truncations: [
            ...bounded.truncations,
            {
              field: "summary",
              reason: `report exceeded ${SUMMARY_MAX_BYTES} bytes; summary shortened`,
              pointer: "obs.explain depth=full",
            },
          ],
        };
        continue;
      }

      if (bounded.failures.length > 1) {
        // Then halve the retained failures (still newest-first).
        const half = Math.max(1, Math.floor(bounded.failures.length / 2));
        bounded = {
          ...bounded,
          failures: bounded.failures.slice(0, half),
          truncations: [
            ...bounded.truncations,
            {
              field: "failures",
              reason: `report exceeded ${SUMMARY_MAX_BYTES} bytes; failures trimmed to ${half}`,
              pointer: "obs.explain depth=full",
            },
          ],
        };
        continue;
      }

      if (bounded.breakerTimeline.length > 1) {
        // Then halve the breaker timeline (still newest-first — already sorted
        // by the step-2b cap; slicing the HEAD keeps the highest-seq entries).
        const half = Math.max(1, Math.floor(bounded.breakerTimeline.length / 2));
        bounded = {
          ...bounded,
          breakerTimeline: bounded.breakerTimeline.slice(0, half),
          truncations: [
            ...bounded.truncations,
            {
              field: "breakerTimeline",
              reason: `report exceeded ${SUMMARY_MAX_BYTES} bytes; breakerTimeline trimmed to ${half}`,
              pointer: "obs.explain depth=full",
            },
          ],
        };
        continue;
      }

      if (bounded.offloads.length > 1) {
        // Finally halve the offloads (still newest-first).
        const half = Math.max(1, Math.floor(bounded.offloads.length / 2));
        bounded = {
          ...bounded,
          offloads: bounded.offloads.slice(0, half),
          truncations: [
            ...bounded.truncations,
            {
              field: "offloads",
              reason: `report exceeded ${SUMMARY_MAX_BYTES} bytes; offloads trimmed to ${half}`,
              pointer: "obs.explain depth=full",
            },
          ],
        };
        continue;
      }

      // ORCH-OBS: halve the per-node budget breaches last (optional + typically
      // tiny — a graph has few nodes; only a pathological run needs trimming).
      if (bounded.nodeBudgetBreaches !== undefined && bounded.nodeBudgetBreaches.length > 1) {
        const half = Math.max(1, Math.floor(bounded.nodeBudgetBreaches.length / 2));
        bounded = {
          ...bounded,
          nodeBudgetBreaches: bounded.nodeBudgetBreaches.slice(0, half),
          truncations: [
            ...bounded.truncations,
            {
              field: "nodeBudgetBreaches",
              reason: `report exceeded ${SUMMARY_MAX_BYTES} bytes; nodeBudgetBreaches trimmed to ${half}`,
              pointer: "obs.explain depth=full",
            },
          ],
        };
        continue;
      }

      // CR-01: halve the spawnTree (first-seen retained) — the pre-loop cap
      // already brings it to ≤40 at summary, so this is the convergence backstop
      // for a tree whose nodes are individually large (many caps/tools per node).
      if (bounded.spawnTree !== undefined && bounded.spawnTree.length > 1) {
        const half = Math.max(1, Math.floor(bounded.spawnTree.length / 2));
        bounded = {
          ...bounded,
          spawnTree: bounded.spawnTree.slice(0, half),
          truncations: [
            ...bounded.truncations,
            {
              field: "spawnTree",
              reason: `report exceeded ${SUMMARY_MAX_BYTES} bytes; spawnTree trimmed to ${half}`,
              pointer: "obs.explain depth=full",
            },
          ],
        };
        continue;
      }

      // Nothing discretionary left to shed — stop (the post-loop honesty check
      // below records the residual overage).
      break;
    }

    // Honest-lossiness backstop (threat T-153-12): if discretionary shedding
    // could not get the report under budget, record ONE residual-overage entry
    // so the consumer is never silently handed an over-budget report. Reachable
    // whenever the fixed fields alone exceed the budget.
    if (Buffer.byteLength(JSON.stringify(bounded), "utf8") > SUMMARY_MAX_BYTES) {
      bounded = {
        ...bounded,
        truncations: [
          ...bounded.truncations,
          {
            field: "report",
            reason: `report still exceeded ${SUMMARY_MAX_BYTES} bytes after shedding; consumer should use depth=full`,
            pointer: "obs.explain depth=full",
          },
        ],
      };
    }
  }

  return bounded;
}
