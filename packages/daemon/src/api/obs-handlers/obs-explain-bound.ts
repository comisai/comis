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
 *   - **errorPreview cap** — ≤ `SUMMARY_MAX_ERROR_PREVIEW_CHARS` per failure at
 *     BOTH depths.
 *   - **digest-only** — NO raw tool-output body is ever inlined. Any string
 *     field that exceeds `MAX_INLINE_STRING` is replaced with its
 *     {@link fingerprint} (a 12-hex digest), guaranteeing the 678 fixture's
 *     50 KB `web_fetch` body + its prompt-injection block ("SECURITY NOTICE")
 *     never survives — regardless of any upstream leak (threat T-153-10).
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

// ---------------------------------------------------------------------------
// X2 report-level caps (distinct from limitPayloadValue's PAYLOAD_BOUNDS).
// ---------------------------------------------------------------------------

/** summary depth: keep at most this many failures (newest-first; drop oldest). */
const SUMMARY_MAX_FAILURES = 20;
/** Per-failure `errorPreview` hard cap (both depths — digest-only is depth-independent). */
const SUMMARY_MAX_ERROR_PREVIEW_CHARS = 200;
/**
 * The summary hard gate: 6 KB. At the ~4 bytes/token rule of thumb this is the
 * ~1,500-token proxy. There is no `estimateTokens` util, so the serialized byte
 * length of the report is the conservative budget.
 */
const SUMMARY_MAX_BYTES = 6 * 1024;
/** full depth relaxes the array cap (still digest-only, still per-string-capped). */
const FULL_MAX_FAILURES = 200;
/**
 * Any string field longer than this is collapsed to a `fingerprint` digest by
 * the defensive sweep — guarantees no 50 KB tool body survives regardless of
 * upstream. Kept comfortably above the 200-char preview cap so a normal
 * already-capped preview is never re-digested.
 */
const MAX_INLINE_STRING = 256;
/** Bound on the progressive-shed loop — never spin forever. */
const MAX_SHED_ITERATIONS = 8;
/** Short form the shed loop collapses the summary prose to (chars, + ellipsis). */
const SHED_SUMMARY_CHARS = 80;
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
]);

/**
 * A single honest-lossiness ledger entry: the report-level sentinel. Distinct
 * from `limitPayloadValue`'s structural `{__bounded__:…}` sentinel.
 */
export interface TruncationEntry {
  field: string;
  reason: string;
  pointer?: string;
}

// ---------------------------------------------------------------------------

/**
 * Apply the X2 report-level bounding pass, then the structural backstop.
 *
 * Order matters (see the algorithm comments inline):
 *   1. seed `truncations` from any upstream entries (preserve assembly's ledger),
 *   2. cap `failures[]` to the depth-appropriate max (newest-first),
 *   3. cap each `errorPreview` to 200 chars (both depths),
 *   4. defensive digest-only sweep: any string > `MAX_INLINE_STRING` → fingerprint,
 *   5. `limitPayloadValue` structural backstop,
 *   6. progressive shed until ≤ 6144 bytes at summary depth.
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
  let summary = report.summary;
  if (summary.length > MAX_INLINE_STRING) {
    truncations.push({
      field: "summary",
      reason: `oversized (${summary.length} chars) — replaced with digest`,
    });
    summary = `[digest:${fingerprint(summary)}]`;
  }

  const offloads = report.offloads.map((o) => {
    if (o.pointer.length <= MAX_INLINE_STRING) return o;
    truncations.push({
      field: "offloads[].pointer",
      reason: `oversized (${o.pointer.length} chars) — replaced with digest`,
    });
    return { ...o, pointer: `[digest:${fingerprint(o.pointer)}]` };
  });

  let bounded: IncidentReport = {
    ...report,
    summary,
    failures,
    offloads,
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
  //    failures), appending a report-level truncation each time, until ≤
  //    SUMMARY_MAX_BYTES or no discretionary field is left to shed.
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
