// SPDX-License-Identifier: Apache-2.0
/**
 * `orchestrate_failed` — the failed-run root-cause verdict spliced into the
 * `obs-explain-heuristics` registry.
 *
 * A sibling file (the `obs-explain-terminal-drive-verdict.ts` discipline) so
 * `obs-explain-heuristics.ts` stays under the 500-line `obs-handlers/*` subdir
 * cap. PURE: no LLM, no I/O, no globals — same signals ⇒ same verdict forever.
 *
 * The failure mode this verdict makes visible: an `orchestrate` PTC run (a jailed
 * child script driving tools through the capability socket) exited non-zero, OR a
 * `tool.invoke` inside the jail was DENIED for exceeding the run's attenuated
 * capability lease — while the surrounding turn returned fine, so `comis explain`
 * reported a clean `endReason` and root-caused NOTHING. This verdict turns a
 * failed run into a one-call diagnosis.
 *
 * Keyed PURELY on the folded, content-free `s.orchestrate` section (one entry per
 * run): fires when ANY run has `outcome:"failure"` (a non-zero exit) OR a
 * `toolCalls` entry with `decision:"deny"`. Returns null when the section is
 * absent/empty or every run succeeded with no denial. Because the section is
 * ABSENT on any non-orchestrate session (and on the established cost and breaker fixtures,
 * which carry no orchestrate records), the verdict cannot regress them — it is
 * registered in the acute tier, BELOW the two frozen codes and ABOVE the
 * `completed_with_tool_errors` catch-all (a failed run is a specific cause, more
 * root than "some tools errored"). The return type is structurally identical to
 * the registry's `RootCause` (no cross-module type import ⇒ no cycle).
 *
 * Content-free (INV-5): the detail names only ids + closed enums + counts (run
 * count, `failureClass`, `exitCode`, capability id) — never the script, the
 * stderr tail, tool args, or a secret.
 *
 * @module
 */

import type { IncidentSignals } from "@comis/core";

/** Structural twin of `obs-explain-heuristics.RootCause` (kept local — no import cycle). */
type OrchestrateVerdict = { code: string; detail: string; suggestedNextSteps: string[] };

/**
 * `orchestrate_failed` — fires when an `orchestrate` run exited non-zero or
 * carried an in-jail capability denial.
 */
export const orchestrateFailedVerdict = (s: IncidentSignals): OrchestrateVerdict | null => {
  const runs = s.orchestrate;
  // No orchestrate section (any non-orchestrate session, incl. the frozen
  // 678/503 fixtures) → not this cause.
  if (runs === undefined || runs.length === 0) return null;

  // A run FAILED if it exited non-zero OR a jailed tool.invoke was denied by its
  // attenuated lease (a denial is a failure signal even on an exit-0 run).
  const failedRuns = runs.filter(
    (r) => r.outcome === "failure" || r.toolCalls.some((t) => t.decision === "deny"),
  );
  if (failedRuns.length === 0) return null; // every run succeeded with no denial → clean.

  // Exit-failed runs: name the closed failureClass + numeric exitCode (content-free).
  const exitFailed = failedRuns.filter((r) => r.outcome === "failure");
  const failureClasses = [
    ...new Set(
      exitFailed
        .map((r) => r.failureClass)
        .filter((c): c is NonNullable<typeof c> => c !== undefined),
    ),
  ];
  const exitCodes = [...new Set(exitFailed.map((r) => r.exitCode))];
  // Denied capability ids across the failed runs (ids — content-free, never a body).
  const deniedCaps = [
    ...new Set(
      failedRuns.flatMap((r) =>
        r.toolCalls.filter((t) => t.decision === "deny").map((t) => t.capability),
      ),
    ),
  ];

  const clauses: string[] = [];
  if (exitFailed.length > 0) {
    const fcClause =
      failureClasses.length > 0 ? `failureClass: ${failureClasses.join(", ")}; ` : "";
    clauses.push(
      `${exitFailed.length} exited non-zero (${fcClause}exitCode: ${exitCodes.join(", ")})`,
    );
  }
  if (deniedCaps.length > 0) {
    clauses.push(`in-jail capability denial(s) (capability: ${deniedCaps.join(", ")})`);
  }

  return {
    code: "orchestrate_failed",
    detail:
      `${failedRuns.length} of ${runs.length} orchestrate run(s) failed — ${clauses.join("; ")}. ` +
      "A run exits non-zero on a script/jail/resource failure, or records a deny when a tool.invoke " +
      "exceeded the run's attenuated capability lease.",
    suggestedNextSteps: [
      "obs.explain depth=full for the failed run's per-run failureClass, exitCode, and tool-call/denial sequence",
      deniedCaps.length > 0
        ? "for a denial: widen the agent's autonomy-profile capability grant (orch:*) or narrow the script to the capabilities the run holds"
        : "for a non-zero exit: inspect the script's failure class (timeout / stdout_cap / spawn_fail / lease_absent) against the jail and resource limits",
    ],
  };
};
