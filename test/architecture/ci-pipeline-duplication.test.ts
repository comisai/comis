// SPDX-License-Identifier: Apache-2.0
/**
 * CI pipeline duplication + shard-threshold guard.
 *
 * Two invariants that only a static read of `ci.yml` can hold, both learned
 * from measured runs rather than reasoning:
 *
 * 1. NO TIER RUNS TWICE. `pnpm test:orchestrate` shells out to
 *    `npx vitest run --config test/vitest.config.ts` with no filter — the exact
 *    command `pnpm test:integration` runs. So an `e2e` job that invoked
 *    orchestrate executed the whole integration suite a SECOND time: both jobs
 *    reported `341 files / 3460 tests`, and the duplicate cost 22m24s of the
 *    31-min wall clock (run 31112678958). Orchestrate's only post-run input is
 *    `test/.test-results.json` — one `readFileSync`, no daemon logs — so the
 *    analysis belongs beside the run that produced the report, and the separate
 *    job keeps only `--check-matrix`, which never spawns vitest at all.
 *
 * 2. A SHARD COLLECTS; THE MERGE ENFORCES. A single shard sees a fraction of the
 *    suite, so a run-level coverage threshold evaluated on that fraction always
 *    fails. Both tiers therefore set `VITEST_SHARD_COLLECT_ONLY=1` on the shard
 *    step (the configs gate their thresholds on it) and enforce on the merged
 *    blobs in a dedicated job. Sharding a tier while leaving its thresholds
 *    live per-shard is the regression this pins — it reds every shard at once
 *    and reads like a coverage drop rather than a config error.
 *
 * Static and cross-platform: parses YAML, runs no runner, hits no network.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const CI = resolve(REPO_ROOT, ".github/workflows/ci.yml");

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  uses?: string;
}
interface Job {
  needs?: string | string[];
  strategy?: { matrix?: Record<string, unknown> };
  steps?: Step[];
}

const workflow = parse(readFileSync(CI, "utf8")) as { jobs: Record<string, Job> };
const jobs = workflow.jobs;
const steps = (id: string): Step[] => jobs[id]?.steps ?? [];
const runs = (id: string): string[] => steps(id).flatMap((s) => (s.run ? [s.run] : []));
const needsOf = (id: string): string[] => {
  const n = jobs[id]?.needs;
  return n === undefined ? [] : Array.isArray(n) ? n : [n];
};

/**
 * Every step that executes a WHOLE tier.
 *
 * Excluded, because none of them run the tier: `--merge-reports` (re-derives a
 * report from existing blobs), `--check-matrix` (never spawns vitest),
 * `--report-only` (analyzes a report produced elsewhere), and any invocation
 * naming explicit `*.test.ts` files — the deterministic-gate step deliberately
 * re-runs three named files in isolation without coverage, which is a different
 * assertion from running the tier.
 */
function suiteRunSteps(id: string): Step[] {
  return steps(id).filter((s) => {
    const r = s.run ?? "";
    if (!/\bvitest\b|test:integration|test:orchestrate|test:coverage/.test(r)) return false;
    if (r.includes("--merge-reports")) return false;
    if (r.includes("--check-matrix")) return false;
    if (r.includes("--report-only")) return false;
    if (/\S+\.test\.[cm]?tsx?\b/.test(r)) return false;
    return true;
  });
}

describe("CI pipeline: no duplicated tier, no per-shard thresholds", () => {
  it("keeps the integration suite out of the e2e job", () => {
    // `test:orchestrate` with no flag IS `test:integration`. Only the
    // matrix check — which never spawns vitest — may live here.
    expect(suiteRunSteps("e2e")).toEqual([]);
    for (const r of runs("e2e")) {
      if (r.includes("test:orchestrate")) {
        expect(r, "orchestrate in the e2e job must be the matrix check only").toContain(
          "--check-matrix",
        );
      }
      expect(r, "the e2e job must not re-run the integration tier").not.toContain(
        "test:integration",
      );
    }
  });

  it("shards the integration tier and keeps every shard collect-only", () => {
    const shards = jobs["integration"]?.strategy?.matrix?.["shard"];
    expect(Array.isArray(shards), "the integration job must fan out over a shard matrix").toBe(true);
    const total = (shards as unknown[]).length;
    expect(total).toBeGreaterThan(1);

    const suite = suiteRunSteps("integration");
    expect(suite.length, "exactly one step runs the integration suite").toBe(1);
    const step = suite[0]!;

    // The shard denominator must match the matrix, or a slice of files never runs.
    expect(step.run).toContain(`--shard=\${{ matrix.shard }}/${total}`);
    // Blob feeds the merge; default keeps a failing test's name in the job log
    // (blob alone is silent on failure, and the blob is not uploaded on a red step).
    expect(step.run).toContain("--reporter=blob");
    expect(step.run).toContain("--reporter=default");
    expect(step.env?.["VITEST_SHARD_COLLECT_ONLY"]).toBe("1");
  });

  it("enforces the integration threshold once, on the merged blobs", () => {
    const mergeJobs = Object.keys(jobs).filter((id) =>
      runs(id).some((r) => r.includes("--merge-reports") && r.includes("test/vitest.config.ts")),
    );
    expect(mergeJobs.length, "one job merges the integration blobs and gates on them").toBe(1);
    const merge = mergeJobs[0]!;

    // The gate must see the FULL picture: never collect-only.
    for (const s of steps(merge)) {
      expect(s.env?.["VITEST_SHARD_COLLECT_ONLY"]).toBeUndefined();
    }
    expect(needsOf(merge)).toContain("integration");

    // A merge job outside `ci-success` is a gate nothing requires.
    expect(needsOf("ci-success")).toContain(merge);
  });

  it("requires every tier job in the aggregate check", () => {
    const required = needsOf("ci-success");
    for (const id of ["build", "unit", "coverage", "integration", "e2e", "tarball", "audit"]) {
      expect(required, `ci-success must require ${id}`).toContain(id);
    }
  });
});
