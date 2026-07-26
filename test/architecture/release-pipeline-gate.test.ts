// SPDX-License-Identifier: Apache-2.0
/**
 * Guards the release pipeline's two structural properties: the publish path
 * must not re-run CI's work, and the workflow that waits on the publish must
 * budget more time than the publish can take.
 *
 * The live failure (v1.0.56): `npm-publish.yml` ran `pnpm validate:full`, which
 * re-executed the entire gate suite SERIALLY in one job — the same suite
 * `ci.yml` had already run for that exact commit, sharded across ~7 parallel
 * jobs. That step alone took 48m57s of a 51-minute publish. Meanwhile
 * `dockerhub-release.yml` waits for the publish on a fixed 120x15s = 30-minute
 * budget, so it timed out 2m38s before the publish finished and failed the
 * release. v1.0.55 had cleared the identical wait with 18 seconds to spare —
 * the gate was passing by accident, decided by how fast the image builds ran,
 * because the waiter only starts after them.
 *
 * Neither property is visible to any other gate: workflow files are not built,
 * linted, or executed by `pnpm validate`, and the race only manifests on a tag
 * push, which no PR ever exercises.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatViolations, type ViolationCitation } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

const PUBLISH_WORKFLOW = ".github/workflows/npm-publish.yml";
const DOCKERHUB_WORKFLOW = ".github/workflows/dockerhub-release.yml";
const DESIGN_REF =
  "CLAUDE.md — Releases: the publish path gates on ci.yml's result for the tagged commit instead of re-running it";

/**
 * The wait must outlast the publish. The publish itself waits for CI (up to 45
 * minutes) and then builds and packs, so anything under this floor can expire
 * while a healthy publish is still running.
 */
const MIN_WAIT_BUDGET_MINUTES = 45;

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

/** Attempt count x sleep interval, in minutes, for a polling loop. */
function pollBudgetMinutes(source: string): number | null {
  const attempts = source.match(/^\s*ATTEMPTS=(\d+)\s*$/m);
  const interval = source.match(/^\s*INTERVAL_SECONDS=(\d+)\s*$/m);
  if (attempts === null || interval === null) {
    return null;
  }
  return (Number(attempts[1]) * Number(interval[1])) / 60;
}

describe("release pipeline gate", () => {
  it("does not re-run CI's gate suite on the publish path", () => {
    const publish = read(PUBLISH_WORKFLOW);
    const violations: ViolationCitation[] = [];

    // `validate:full` = validate + integration + tarball smoke, serially. CI
    // already ran all of it for this commit, in parallel.
    for (const script of ["validate:full", "test:coverage", "test:integration"]) {
      if (new RegExp(`pnpm\\s+${script.replace(":", ":")}(\\s|$)`).test(publish)) {
        violations.push({
          file: PUBLISH_WORKFLOW,
          line: 0,
          snippet: `runs \`pnpm ${script}\` — duplicates ci.yml serially and stretches the publish past the budget dockerhub-release.yml waits on`,
        });
      }
    }

    expect(
      violations,
      formatViolations({
        description: "The publish path re-runs work ci.yml already did for the same commit.",
        violations,
        suggestedFix:
          "Gate on ci.yml's result for the tagged commit, then run only publish-specific work (build the artifact, verify the packed tarball).",
        designRef: DESIGN_REF,
      }),
    ).toEqual([]);
  });

  it("refuses to publish a commit whose CI did not pass", () => {
    const publish = read(PUBLISH_WORKFLOW);
    const violations: ViolationCitation[] = [];

    if (!/actions\/workflows\/ci\.yml\/runs\?head_sha=/.test(publish)) {
      violations.push({
        file: PUBLISH_WORKFLOW,
        line: 0,
        snippet: "does not look up ci.yml's run for the tagged commit — nothing proves the commit was validated",
      });
    }
    if (!/actions:\s*read/.test(publish)) {
      violations.push({
        file: PUBLISH_WORKFLOW,
        line: 0,
        snippet: "missing `actions: read` permission, so the CI lookup cannot read workflow runs",
      });
    }
    if (!/timeout-minutes:/.test(publish)) {
      violations.push({
        file: PUBLISH_WORKFLOW,
        line: 0,
        snippet: "no job timeout-minutes — a wedged step burns the 6-hour GitHub default (one run sat 2h26m)",
      });
    }

    expect(
      violations,
      formatViolations({
        description: "The publish job can ship a commit without a proven-green CI run.",
        violations,
        suggestedFix:
          "Poll `ci.yml` for the tagged commit's run, fail on any non-success conclusion, grant `actions: read`, and bound the job with timeout-minutes.",
        designRef: DESIGN_REF,
      }),
    ).toEqual([]);
  });

  it("budgets the publish wait longer than a publish can take", () => {
    const dockerhub = read(DOCKERHUB_WORKFLOW);
    const violations: ViolationCitation[] = [];
    const budget = pollBudgetMinutes(dockerhub);

    if (budget === null) {
      violations.push({
        file: DOCKERHUB_WORKFLOW,
        line: 0,
        snippet:
          "wait budget is not stated as ATTEMPTS + INTERVAL_SECONDS — a hard-coded loop bound drifts from the message that prints it",
      });
    } else if (budget < MIN_WAIT_BUDGET_MINUTES) {
      violations.push({
        file: DOCKERHUB_WORKFLOW,
        line: 0,
        snippet: `wait budget is ${budget} min, under the ${MIN_WAIT_BUDGET_MINUTES} min floor; a healthy publish can outlast it and fail the release`,
      });
    }

    expect(
      violations,
      formatViolations({
        description: "The release wait can expire while the publish it waits on is still healthy.",
        violations,
        suggestedFix: `State the budget once as ATTEMPTS + INTERVAL_SECONDS and keep it above ${MIN_WAIT_BUDGET_MINUTES} minutes.`,
        designRef: DESIGN_REF,
      }),
    ).toEqual([]);
  });
});
