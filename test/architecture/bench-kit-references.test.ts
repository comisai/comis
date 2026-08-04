// SPDX-License-Identifier: Apache-2.0
/**
 * Bench-kit reference guard: `scripts/bench-memory.sh` names its harnesses as
 * literal paths, and nothing machine-checked that those files exist.
 *
 * `*.bench.test.ts` matches the `src/**\/*.test.ts` exclude in every package
 * tsconfig and belongs to no vitest project, so the benchmark tree sits outside
 * build, lint and coverage alike. The runner is the only thing that reaches it,
 * and the runner addresses each harness by a hand-written path.
 *
 * A path that no longer resolves does not announce itself: `vitest run
 * <missing>` prints its project list and exits non-zero with "No test files
 * found", which reads like a runner misconfiguration rather than a renamed
 * file. `recall-learning` pointed at `learning-lift-harness.bench.test.ts`
 * while the harness on disk was `learning-iq.bench.test.ts`, and that tier
 * simply never ran.
 *
 * Deliberately narrow: this asserts only that every declared path resolves.
 * Whether a tier is wired to the right harness is a judgement a gate cannot
 * supply, and a noisy gate gets disabled.
 *
 * @module
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const RUNNER_REL = "scripts/bench-memory.sh";

/** `BENCH_DIR` as the runner itself defines it. */
const BENCH_DIR_REL = "packages/agent/src/memory/benchmark";

interface HarnessRef {
  readonly variable: string;
  readonly relPath: string;
  readonly line: number;
}

/**
 * Collect every `NAME="$BENCH_DIR/<file>"` assignment, with the 1-indexed line
 * so a failure cites the assignment a reader must edit.
 */
function collectHarnessRefs(source: string): HarnessRef[] {
  const refs: HarnessRef[] = [];
  const lines = source.split("\n");
  for (const [index, text] of lines.entries()) {
    const match = /^([A-Z0-9_]+)="\$BENCH_DIR\/([^"]+)"/.exec(text);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    refs.push({ variable: match[1], relPath: match[2], line: index + 1 });
  }
  return refs;
}

describe("bench-memory runner -- harness path references", () => {
  const source = readFileSync(resolve(REPO_ROOT, RUNNER_REL), "utf8");
  const refs = collectHarnessRefs(source);

  it("declares at least one harness path so the scan cannot pass vacuously", () => {
    expect(
      refs.length,
      `sanity: no NAME="$BENCH_DIR/..." assignments parsed out of ${RUNNER_REL} -- ` +
        "the matcher drifted from the runner's syntax and every check below is vacuous",
    ).toBeGreaterThan(0);
  });

  it("points every declared harness variable at a file that exists on disk", () => {
    const violations = refs.filter(
      (ref) => !existsSync(resolve(REPO_ROOT, BENCH_DIR_REL, ref.relPath)),
    );
    expect(
      violations.map((v) => `${v.variable} -> ${v.relPath}`),
      formatViolations({
        description:
          `Every ${RUNNER_REL} harness variable must name a file under ${BENCH_DIR_REL}. ` +
          "A dangling path makes its tier exit non-zero with \"No test files found\", which reads " +
          "as a broken runner rather than a renamed harness.",
        violations: violations.map((v) => ({
          file: RUNNER_REL,
          line: v.line,
          snippet: `${v.variable}="$BENCH_DIR/${v.relPath}" -- no such file`,
        })),
        suggestedFix:
          `Rename the path to the harness that exists under ${BENCH_DIR_REL}, or delete the ` +
          "variable and the tier that runs it if the harness is gone.",
        designRef: "the benchmark tree is outside build, lint and coverage; the runner is its only caller",
      }),
    ).toEqual([]);
  });
});
