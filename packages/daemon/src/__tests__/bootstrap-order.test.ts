// SPDX-License-Identifier: Apache-2.0
/**
 * FILE-SPLIT-07 bootstrap-order smoke test.
 *
 * Records the call-order of the 5 stage* functions in daemon.ts's main()
 * orchestrator. Pre/post the daemon.ts split, the recorded sequence MUST
 * be byte-identical:
 *
 *   stageFoundation → stageAgents → stageChannels → stageGateway → stageShutdown
 *
 * Pre-split state (Phase 43 Wave 1, this commit): this test runs against
 * the existing daemon.ts and is GREEN — the sequence above is the current
 * orchestration order.
 *
 * Post-Wave-8 state: daemon.ts has shrunk (per FILE-SPLIT-06) but keeps the
 * 5 stage functions in place per DAEMON-API-06 (≤200L cap each). The
 * sequence is unchanged. The test is the regression gate that proves the
 * daemon.ts split did not silently reorder stages.
 *
 * ## Test-shape rationale (FILE-SPLIT-07 — fallback to Pattern C, AST static check)
 *
 * The plan offers three patterns:
 *   - Pattern A (DaemonOverrides stage injection) — UNAVAILABLE: the live
 *     DaemonOverrides interface in daemon-types.ts (verified 2026-05-16,
 *     153L) does NOT include stage* override fields. Adding fields would be
 *     a daemon.ts/daemon-types.ts source change, which is Wave 8 work
 *     (out of scope for Wave 1).
 *   - Pattern B (vi.spyOn on module) — UNAVAILABLE: stageFoundation,
 *     stageAgents, stageChannels, stageGateway, stageShutdown are
 *     module-internal `async function` declarations (NOT `export
 *     async function`). They are not addressable from
 *     `import * as daemonModule` consumers, so vi.spyOn cannot intercept
 *     them.
 *   - Pattern C (AST-based static call-order check) — the third pattern
 *     selected here. Mirrors the AST machinery already in place in the
 *     sibling test packages/daemon/src/__tests__/architecture.test.ts
 *     (DAEMON-API-06 ≤200L cap check uses ts.createSourceFile +
 *     getLineAndCharacterOfPosition with the SAME source file). Parses
 *     daemon.ts source, walks the main() body, collects the sequence of
 *     stage* CallExpressions, and asserts the sequence matches the
 *     documented order.
 *
 * AST-based check is sufficient because the smoke test's purpose is a
 * regression gate: "did the documented stage order change?" An AST gate
 * answers that question reliably without paying the cost of mocking
 * bootstrap, SecretManager, gateway, watchdog, schedulers, etc. that a
 * runtime invocation of main() would require. The trade-off is
 * documented in 43-01-SUMMARY.md.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import * as ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");
const DAEMON_TS_PATH = resolve(SRC_ROOT, "daemon.ts");
// Phase 43 FILE-SPLIT-06: the inter-stage Handle interfaces (FoundationHandle,
// AgentsHandle, ChannelsHandle, GatewayHandle) were moved from daemon.ts to
// daemon-types.ts. The handle-chaining (it #3 below) reads both files; the
// stage call sequence (it #1, #2, #3 stage-call assertions) stays in daemon.ts.
const DAEMON_TYPES_TS_PATH = resolve(SRC_ROOT, "daemon-types.ts");

/**
 * Expected stage call sequence — the documented orchestration order
 * (daemon.ts main() at line ~2544 per FILE-SPLIT-01 baseline 2026-05-16).
 *
 * Any reordering of this list is an architectural change that requires
 * design-doc + REQUIREMENTS.md updates; the test FAILS if the source
 * deviates from this sequence.
 */
const EXPECTED_STAGE_ORDER = [
  "stageFoundation",
  "stageAgents",
  "stageChannels",
  "stageGateway",
  "stageShutdown",
] as const;
const STAGE_NAMES = new Set<string>(EXPECTED_STAGE_ORDER);

/**
 * Extract the FunctionDeclaration node for `main` from daemon.ts.
 */
function findMainFunction(sf: ts.SourceFile): ts.FunctionDeclaration | undefined {
  let found: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node): void {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "main"
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

/**
 * Walk a node and collect the names of all CallExpressions whose callee is
 * an Identifier matching one of STAGE_NAMES. Returns the sequence in
 * source order (depth-first, left-to-right — matches execution order for
 * top-level statements in async function bodies).
 *
 * `await stageFoundation(...)` parses as ExpressionStatement → AwaitExpression
 * → CallExpression (callee: Identifier "stageFoundation"). The walker
 * unwraps Await and ExpressionStatement nodes transparently because
 * ts.forEachChild recurses into them.
 */
function collectStageCalls(node: ts.Node): string[] {
  const calls: string[] = [];
  function visit(n: ts.Node): void {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const name = n.expression.text;
      if (STAGE_NAMES.has(name)) {
        calls.push(name);
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return calls;
}

describe("daemon bootstrap order (FILE-SPLIT-07)", () => {
  it("daemon.ts main() calls stageFoundation, stageAgents, stageChannels, stageGateway, stageShutdown in that exact sequence", () => {
    // === Arrange: parse daemon.ts source via TypeScript compiler API ===
    const sourceText = readFileSync(DAEMON_TS_PATH, "utf8");
    const sf = ts.createSourceFile(
      "daemon.ts",
      sourceText,
      ts.ScriptTarget.ES2023,
      /* setParentNodes */ true,
    );

    // === Act: locate main(), collect stage call sequence ===
    const mainNode = findMainFunction(sf);
    expect(
      mainNode,
      "main() function declaration not found in packages/daemon/src/daemon.ts — " +
        "the AST walker could not find an `async function main(...)` at top level. " +
        "If daemon.ts was renamed or main was renamed, update DAEMON_TS_PATH or the " +
        "node.name?.text check above.",
    ).toBeDefined();

    expect(
      mainNode!.body,
      "main() has no body — daemon.ts must define `async function main(overrides) { ... }` " +
        "with a non-empty body that calls the 5 stage functions in sequence.",
    ).toBeDefined();

    const stageCallSequence = collectStageCalls(mainNode!.body!);

    // === Assert (FILE-SPLIT-07 invariant): the recorded sequence matches ===
    expect(
      stageCallSequence,
      `daemon.ts main() stage call sequence MUST match the documented order. ` +
        `Expected: ${JSON.stringify([...EXPECTED_STAGE_ORDER])}. ` +
        `Found: ${JSON.stringify(stageCallSequence)}. ` +
        `If you intentionally changed the orchestration order, update both this test ` +
        `and the design doc (code-quality-plan §9) + REQUIREMENTS.md FILE-SPLIT-06/07 ` +
        `language. Silent reordering breaks the post-Wave-8 daemon.ts split contract.`,
    ).toEqual([...EXPECTED_STAGE_ORDER]);
  });

  it("each stage name appears exactly once in main() (no duplicate or missing stage calls)", () => {
    // Independent assertion of stage-set completeness — guards against a
    // partial reordering that happens to preserve relative ordering of a
    // subset (e.g., dropping stageShutdown but keeping the first four in
    // the right order). The "exactly once" rule means the call-order
    // assertion above can be a simple `.toEqual([...])` rather than a
    // subsequence check.
    const sourceText = readFileSync(DAEMON_TS_PATH, "utf8");
    const sf = ts.createSourceFile(
      "daemon.ts",
      sourceText,
      ts.ScriptTarget.ES2023,
      /* setParentNodes */ true,
    );
    const mainNode = findMainFunction(sf);
    expect(mainNode).toBeDefined();
    const stageCallSequence = collectStageCalls(mainNode!.body!);

    for (const name of EXPECTED_STAGE_ORDER) {
      const occurrences = stageCallSequence.filter((s) => s === name).length;
      expect(
        occurrences,
        `stage call ${name} must appear exactly once in main(); found ${occurrences}. ` +
          `If a stage was deleted or duplicated, the daemon.ts split contract is broken.`,
      ).toBe(1);
    }
    expect(
      stageCallSequence.length,
      `main() must call exactly ${EXPECTED_STAGE_ORDER.length} stage functions; ` +
        `found ${stageCallSequence.length}. Unexpected stage calls were introduced ` +
        `or expected ones were removed.`,
    ).toBe(EXPECTED_STAGE_ORDER.length);
  });

  it("foundation handle threads into stageAgents (handle chaining contract is documented in source)", () => {
    // Behavioral invariant from the plan §interfaces (43-01-PLAN.md):
    // stageFoundation returns a FoundationHandle that stageAgents consumes.
    // The chaining is enforced at the type level (AgentsHandle extends
    // FoundationHandle — see daemon-types.ts after Phase 43 FILE-SPLIT-06; was
    // daemon.ts:748 before the split) and at the call site (main() passes
    // `{ overrides, foundation }` to stageAgents — daemon.ts).
    //
    // This test asserts the source structure (not runtime behavior) — it
    // proves the source documents the handle chaining contract via:
    //   1. AgentsHandle extends FoundationHandle (interface inheritance,
    //      checked in daemon-types.ts after Phase 43 FILE-SPLIT-06).
    //   2. stageAgents accepts a `foundation` parameter.
    //   3. stageChannels accepts `agents` (the AgentsHandle composite).
    //   4. stageGateway accepts `channels` (the ChannelsHandle composite).
    //
    // If any of these surface contracts drift, the smoke test catches it
    // at the source level before runtime behavior diverges.
    const daemonSource = readFileSync(DAEMON_TS_PATH, "utf8");
    const daemonTypesSource = readFileSync(DAEMON_TYPES_TS_PATH, "utf8");
    // Phase 43 FILE-SPLIT-06: the Handle interface chain moved from daemon.ts
    // (lines 748, 1231, 1754 pre-split) into daemon-types.ts. The chaining
    // declarations are searched in either file so the test stays robust to
    // future re-arrangements within the daemon module.
    const moduleSource = daemonSource + "\n" + daemonTypesSource;
    expect(
      moduleSource.includes("AgentsHandle extends FoundationHandle"),
      "daemon module must declare `AgentsHandle extends FoundationHandle` to thread " +
        "the foundation handle through stageAgents (checked in daemon.ts + daemon-types.ts).",
    ).toBe(true);
    expect(
      moduleSource.includes("ChannelsHandle extends AgentsHandle"),
      "daemon module must declare `ChannelsHandle extends AgentsHandle` to thread " +
        "the agents handle through stageChannels (checked in daemon.ts + daemon-types.ts).",
    ).toBe(true);
    expect(
      moduleSource.includes("GatewayHandle extends ChannelsHandle"),
      "daemon module must declare `GatewayHandle extends ChannelsHandle` to thread " +
        "the channels handle through stageGateway (checked in daemon.ts + daemon-types.ts).",
    ).toBe(true);
    // Stage call signatures — each stage past the first takes the prior
    // handle as a named parameter. These are stable identifiers in
    // daemon.ts even after Wave 8c helper extraction (the stage* functions
    // themselves stay in daemon.ts per DAEMON-API-06).
    expect(
      daemonSource.includes("await stageAgents({ overrides, foundation })"),
      "main() must call stageAgents with the foundation handle threaded through.",
    ).toBe(true);
    expect(
      daemonSource.includes("await stageChannels({ agents })"),
      "main() must call stageChannels with the agents handle threaded through.",
    ).toBe(true);
    expect(
      daemonSource.includes("await stageGateway({ overrides, channels"),
      "main() must call stageGateway with the channels handle threaded through.",
    ).toBe(true);
    expect(
      daemonSource.includes("await stageShutdown({ overrides, gateway"),
      "main() must call stageShutdown with the gateway handle threaded through.",
    ).toBe(true);
  });
});
