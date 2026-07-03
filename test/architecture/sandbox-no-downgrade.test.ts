// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture guard for the sandbox no-downgrade invariant.
 *
 * The invariant: a spawned child may never be LESS confined than its spawner.
 * It is enforced fail-closed at the SINGLE spawn chokepoint
 * (`subAgentRunner.spawn()`), which is the one funnel for all 6 spawn call
 * sites. This test is the regression guard against the way the invariant would
 * silently regress: the gate is REMOVED from the spawn path, or the daemon stops
 * injecting the resolver.
 *
 * "Built but not wired" (or un-built) has been this program's #1 recurring
 * blocker — a comparator can exist and pass its own unit tests while the runner
 * never calls it, or the daemon never injects the resolver. This is a shrink-only
 * SOURCE GUARD (no allowlist, mirroring audio-wiring-guard.test.ts): a
 * comment-stripped source-grep pins the gate's presence in `sub-agent-runner.ts`,
 * its resolver injection in the daemon wiring, and the cross-package re-export of
 * the pure primitives through the `@comis/agent` index — so a refactor cannot
 * regress to unwired without turning this test red.
 *
 * The fail-closed REFUSAL behavior (spawn() throws before any run/session on both
 * the immediate and queued branches) is the load-bearing assertion, proven
 * behaviorally against the real runner in
 * `packages/agent/src/spawn/sub-agent-runner.test.ts`'s "sandbox no-downgrade
 * gate" describe block. This architecture test deliberately stays source-grep
 * only (the file's documented invariant: don't alias-route heavy packages to
 * dist/ when a source guard suffices).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const RUNNER_TS = resolve(REPO_ROOT, "packages/agent/src/spawn/sub-agent-runner.ts");
const AGENT_INDEX_TS = resolve(REPO_ROOT, "packages/agent/src/index.ts");
const WIRING_TS = resolve(
  REPO_ROOT,
  "packages/daemon/src/wiring/setup-cross-session/setup-cross-session-runtime.ts",
);

/** Strip line + block comments so a token inside a comment cannot satisfy a
 *  wiring assertion (a comment naming comparePosture is NOT the gate). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .split(/\r?\n/)
    .map((l) => {
      const t = l.trim();
      return t.startsWith("//") || t.startsWith("*") ? "" : l;
    })
    .join("\n");
}

describe("sandbox no-downgrade invariant — spawn-path source guard", () => {
  it("sub-agent-runner.ts enforces the gate via comparePosture, resolvePosture, and sandboxNoDowngrade", () => {
    const src = stripComments(readFileSync(RUNNER_TS, "utf8"));
    // The comparator is called on the spawn path.
    expect(src).toMatch(/comparePosture\s*\(/);
    // The injected resolver dep is consulted (not config.agents reached directly).
    expect(src).toMatch(/deps\.resolvePosture/);
    // The gate is gated by the config flag (default-active via `!== false`).
    expect(src).toMatch(/sandboxNoDowngrade/);
    // Fail-closed: the runner never reaches the daemon's full agents config.
    expect(src).not.toMatch(/config\.agents\b/);
  });

  it("setup-cross-session-runtime.ts injects a resolvePosture closure built on resolvePostureFromSkills", () => {
    const src = stripComments(readFileSync(WIRING_TS, "utf8"));
    expect(src).toMatch(/resolvePosture\s*:/);
    expect(src).toMatch(/resolvePostureFromSkills\s*\(/);
    // The closure reads per-agent skills config (the source of posture).
    expect(src).toMatch(/container\.config\.agents/);
  });

  it("the @comis/agent index re-exports the pure posture primitives for the daemon consumer", () => {
    const src = stripComments(readFileSync(AGENT_INDEX_TS, "utf8"));
    expect(src).toMatch(/\bcomparePosture\b/);
    expect(src).toMatch(/\bresolvePostureFromSkills\b/);
  });
});
