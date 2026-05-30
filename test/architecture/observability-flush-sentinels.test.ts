// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariant — flush-sentinel symmetry.
 *
 * Any *.ts file under packages/observability/src/ that consumes the
 * queued-file-writer (imports it or calls `getQueuedFileWriter`) AND defines
 * a `flushAndClose` method MUST reference BOTH `"trace.truncated"` AND
 * `"trace.write_failures"` string literals in its source body.
 *
 * The trajectory recorder has TWO control-plane sentinels for writer-side
 * failure modes:
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
 * Scope: this test does NOT walk runtime behavior; it greps source. It
 * catches the "I forgot to add the second sentinel" class of bug. A recorder
 * that emits a string-formatted sentinel without the literal "type" key
 * escapes detection — that gap is intentional (string-match is the cheapest
 * invariant available; the runtime test is the stricter semantic gate).
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

describe("architecture — observability flush sentinel symmetry", () => {
  it("every consumer of getQueuedFileWriter that defines flushAndClose references at least one namespaced *.write_failures sentinel", () => {
    // Sanity check the source root resolves to a real directory.
    expect(statSync(OBSERVABILITY_SRC).isDirectory()).toBe(true);

    const files = listSourceFiles(OBSERVABILITY_SRC);
    expect(files.length).toBeGreaterThan(0);

    // Per-namespace sentinel registry. Each recorder family may use its
    // own naming (trajectory uses `trace.*`, cache-trace uses `cache_trace.*`).
    // The invariant is: a flush-defining consumer of the queued-file-writer
    // MUST emit AT LEAST the namespace's `write_failures` sentinel.
    //
    // The `truncated` sentinel is optional per-recorder: trajectory needs
    // it because it enforces a per-file byte cap above the writer's own
    // cap (with 2 KB sentinel head-room reserved); cache-trace defers
    // bounds entirely to the queued writer chassis so it has no
    // additional dropped-events accounting and emits only the
    // `write_failures` sentinel. The check below picks the right pair
    // based on which namespace literals appear in the source.
    const namespaces = [
      { truncated: '"trace.truncated"', writeFailures: '"trace.write_failures"', name: "trace" },
      { truncated: '"cache_trace.truncated"', writeFailures: '"cache_trace.write_failures"', name: "cache_trace" },
      // recall-trace (Phase 86): a daemon-wide JSONL recorder built on the
      // queued-file-writer chassis with its own `recall_trace.*` namespace.
      // Like cache_trace it delegates bounds to the writer chassis (no
      // separate per-file dropped-event accounting), so only the
      // `write_failures` sentinel is required for symmetry.
      { truncated: '"recall_trace.truncated"', writeFailures: '"recall_trace.write_failures"', name: "recall_trace" },
    ];

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

      // Pick the namespace by which write-failures literal is present.
      const ns = namespaces.find((n) =>
        new RegExp(n.writeFailures.replace(/\./g, "\\.")).test(src),
      );
      if (!ns) {
        offenders.push(
          `${file}: no namespaced *.write_failures sentinel found (expected one of ${namespaces.map((n) => n.writeFailures).join(" / ")})`,
        );
        continue;
      }

      // For the trajectory namespace, both sentinels are required (the
      // recorder enforces a per-file cap above the writer's own and
      // emits a separate `truncated` sentinel when events were dropped).
      // For cache_trace, only the write_failures sentinel is required
      // (no separate per-file dropped-event accounting — bounds are
      // delegated to the writer chassis).
      if (ns.name === "trace") {
        const hasTruncated = new RegExp(ns.truncated.replace(/\./g, "\\.")).test(src);
        if (!hasTruncated) {
          offenders.push(
            `${file}: missing ${ns.truncated} (namespace="${ns.name}" requires BOTH sentinels for symmetry)`,
          );
        }
      }
    }

    expect(offenders, [
      "Files that consume the queued-file-writer and define flushAndClose",
      "must emit the namespace-correct control-plane sentinel(s).",
      "Add the missing string-literal emit alongside the existing one. See",
      "packages/observability/src/trajectory/runtime.ts:flushAndClose for",
      "the canonical buildEvent + encodeLine + writer.write pattern.",
      "",
      "Offenders:",
      ...offenders,
    ].join("\n")).toEqual([]);
  });
});
