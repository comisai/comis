// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariant — flush-sentinel symmetry (TRAJ-FIX-03).
 *
 * RESEARCH.md §5 Invariant 2. Any *.ts file under packages/observability/src/
 * that consumes the queued-file-writer (imports it or calls
 * `getQueuedFileWriter`) AND defines a `flushAndClose` method MUST reference
 * BOTH `"trace.truncated"` AND `"trace.write_failures"` string literals in
 * its source body.
 *
 * Rationale (Finding H3, plan 45.1-02):
 * The trajectory recorder currently has TWO control-plane sentinels for
 * writer-side failure modes:
 *   - "trace.truncated" — emitted at flushAndClose when events were dropped
 *     because the per-file budget or queued-bytes cap was exceeded.
 *   - "trace.write_failures" — emitted at flushAndClose when the underlying
 *     queued writer reported per-line append failures (failureCount > 0).
 *
 * These sentinels are SYMMETRIC: any future recorder built on the
 * queued-file-writer chassis that defines its own flushAndClose surface MUST
 * emit BOTH (or neither). The architecture test locks in this symmetry as a
 * structural-fitness check (source string-match). The semantic-correctness
 * gate is the unit test in trajectory/runtime.test.ts.
 *
 * Out of scope: this test does NOT walk runtime behavior; it greps source.
 * It catches the "I forgot to add the second sentinel" class of bug. A
 * recorder that emits a string-formatted sentinel without the literal "type"
 * key escapes detection — that gap is intentional (string-match is the
 * cheapest invariant available; the runtime test in 45.1-02 task 4 is the
 * stricter semantic gate).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OBSERVABILITY_SRC = resolve(here, "../..", "packages/observability/src");

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.isFile() && full.endsWith(".ts") && !full.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("architecture — observability flush sentinel symmetry (TRAJ-FIX-03)", () => {
  it("every consumer of getQueuedFileWriter that defines flushAndClose references BOTH trace.truncated AND trace.write_failures string literals", () => {
    // Sanity check the source root resolves to a real directory.
    expect(statSync(OBSERVABILITY_SRC).isDirectory()).toBe(true);

    const files = listSourceFiles(OBSERVABILITY_SRC);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      // The queued-file-writer's own source is the chassis providing
      // flushAndClose; it is not a CONSUMER of itself. Skip it — the
      // invariant targets recorders/writers BUILT ON the chassis.
      if (file.endsWith("/shared/queued-file-writer.ts")) continue;

      const src = readFileSync(file, "utf8");
      const usesWriter = /queued-file-writer|getQueuedFileWriter/.test(src);
      const hasFlush = /flushAndClose\s*\(/.test(src);
      if (!usesWriter || !hasFlush) continue;

      const hasTruncated = /"trace\.truncated"/.test(src);
      const hasWriteFailures = /"trace\.write_failures"/.test(src);
      if (!hasTruncated || !hasWriteFailures) {
        offenders.push(
          `${file}: truncated=${hasTruncated} write_failures=${hasWriteFailures}`,
        );
      }
    }

    expect(offenders, [
      "Files that consume the queued-file-writer and define flushAndClose",
      "must emit BOTH control-plane sentinels (TRAJ-FIX-03). Add the missing",
      "string-literal emit alongside the existing one. See",
      "packages/observability/src/trajectory/runtime.ts:flushAndClose for",
      "the canonical buildEvent + encodeLine + writer.write pattern.",
      "",
      "Offenders:",
      ...offenders,
    ].join("\n")).toEqual([]);
  });
});
