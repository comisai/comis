// SPDX-License-Identifier: Apache-2.0
/**
 * RED — `cwd` must be validated against the scope's bound paths.
 *
 * THE GAP. `terminal_session_create` accepts an agent-supplied `cwd` (the jail
 * `--chdir` target). It flows verbatim — tool params -> `resolveCreateWorkspace`
 * (`cwd: req.cwd ?? workspace`) -> `planSpawnFromCreateFrame` -> `buildSpawnPlan`
 * -> `buildScopeArgs` -> `--chdir <cwd>` — with NO check that `cwd` actually lands
 * inside a path the scope binds into the jail. The only places a valid cwd can sit
 * are: the always-bound `workspace`, plus whatever `scope.filesystem` adds
 * (`listed-paths` -> `scope.paths`; `home` -> `home`; `full` -> everything).
 *
 * Today, a `cwd` OUTSIDE those binds is composed straight into the bwrap argv and
 * the jail dies with an opaque `bwrap: Can't chdir to <p>: No such file or
 * directory` — surfaced as a generic spawn failure, NOT the typed
 * `permission_denied` + `errorKind`/`hint` the spec mandates on every governance
 * failure branch (§4.8 fail-closed). `cwd` is an agent-supplied, prompt-injectable
 * input governed by the OPERATOR's scope, so a mismatch must fail CLEAN and EARLY
 * — a typed rejection at the composition seam, before any bwrap spawn.
 *
 * This is the mirror of the allowlist gate: the agent proposes, the operator's
 * scope disposes. It is NOT a sandbox escape (bwrap contains chdir within the new
 * mount namespace) — it is a fail-clean / observability requirement.
 *
 * EXPECTED BEHAVIOR (drives the fix): `buildSpawnPlan` REJECTS with a typed error
 * carrying `errorKind: "permission_denied"` and a message naming `cwd` when the
 * resolved `cwd` is not contained by `workspace ∪ <scope binds>`. Pure function,
 * no bwrap — macOS-runnable (the live chdir proof is the VPS scope matrix).
 *
 * STATUS: RED against current code — `buildSpawnPlan` currently RESOLVES for every
 * cell below (it composes `--chdir <out-of-bounds>` instead of rejecting). The
 * positive controls already pass and guard the fix against over-rejecting.
 */
import { describe, it, expect } from "vitest";

import { buildSpawnPlan, type SpawnPlanInput } from "./terminal-spawn-plan.js";
import type { TerminalScope } from "./allowlist-matcher.js";

function makeScope(overrides: Partial<TerminalScope> = {}): TerminalScope {
  return {
    filesystem: "workspace",
    network: "none",
    credentialPaths: [],
    uid: "dedicated",
    ...overrides,
  };
}

function makeInput(overrides: Partial<SpawnPlanInput> = {}): SpawnPlanInput {
  return {
    scope: makeScope(),
    bin: "/bin/cat",
    argv: [],
    workspace: "/ws",
    cwd: "/ws",
    home: "/home/u",
    dataDir: "/home/u/.comis",
    systemRoPaths: ["/usr", "/bin"],
    env: {},
    ...overrides,
  };
}

const BWRAP = { bwrapPath: "/usr/bin/bwrap" } as const;

describe("buildSpawnPlan — cwd must be within the scope's bound paths (fail-closed, typed)", () => {
  // ---- RED: these must REJECT; current code resolves (composes --chdir out-of-bounds) ----

  it("filesystem:workspace — a cwd outside the workspace bind is rejected (permission_denied)", async () => {
    await expect(
      buildSpawnPlan(
        makeInput({ scope: makeScope({ filesystem: "workspace" }), workspace: "/ws", cwd: "/home/u/project" }),
        BWRAP,
      ),
    ).rejects.toMatchObject({ errorKind: "permission_denied" });
  });

  it("filesystem:listed-paths — a cwd not under any listed path is rejected", async () => {
    await expect(
      buildSpawnPlan(
        makeInput({
          scope: makeScope({ filesystem: "listed-paths", paths: ["/projects/a"] }),
          workspace: "/ws",
          cwd: "/projects/b",
        }),
        BWRAP,
      ),
    ).rejects.toMatchObject({ errorKind: "permission_denied" });
  });

  it("filesystem:home — a cwd outside HOME (and outside the workspace) is rejected", async () => {
    await expect(
      buildSpawnPlan(
        makeInput({ scope: makeScope({ filesystem: "home" }), workspace: "/ws", home: "/home/u", cwd: "/etc" }),
        BWRAP,
      ),
    ).rejects.toMatchObject({ errorKind: "permission_denied" });
  });

  it("rejects a prefix-spoofed sibling of the workspace (/ws-evil is NOT under /ws)", async () => {
    // Guards the implementation against a naive `cwd.startsWith(workspace)` check.
    await expect(
      buildSpawnPlan(makeInput({ workspace: "/ws", cwd: "/ws-evil" }), BWRAP),
    ).rejects.toMatchObject({ errorKind: "permission_denied" });
  });

  it("rejects a `..` traversal that escapes the bound path lexically", async () => {
    await expect(
      buildSpawnPlan(
        makeInput({
          scope: makeScope({ filesystem: "listed-paths", paths: ["/projects/a"] }),
          workspace: "/ws",
          cwd: "/projects/a/../../etc",
        }),
        BWRAP,
      ),
    ).rejects.toMatchObject({ errorKind: "permission_denied" });
  });

  it("the rejection message names `cwd` (operator-actionable hint, not an opaque chdir crash)", async () => {
    await expect(
      buildSpawnPlan(makeInput({ workspace: "/ws", cwd: "/home/u/project" }), BWRAP),
    ).rejects.toThrow(/cwd/i);
  });

  // ---- Positive controls: these must RESOLVE (the fix must not over-reject) ----

  it("default cwd === workspace resolves (the common path)", async () => {
    const plan = await buildSpawnPlan(makeInput({ workspace: "/ws", cwd: "/ws" }), BWRAP);
    expect(plan.argv).toContain("--chdir");
  });

  it("a cwd UNDER the workspace resolves", async () => {
    const plan = await buildSpawnPlan(makeInput({ workspace: "/ws", cwd: "/ws/sub/dir" }), BWRAP);
    expect(plan.argv).toContain("/ws/sub/dir");
  });

  it("filesystem:listed-paths — a cwd under a listed project path resolves (the headline use case)", async () => {
    const plan = await buildSpawnPlan(
      makeInput({
        scope: makeScope({ filesystem: "listed-paths", paths: ["/projects/a"] }),
        workspace: "/ws",
        cwd: "/projects/a/src",
      }),
      BWRAP,
    );
    expect(plan.argv).toContain("/projects/a/src");
  });

  it("filesystem:full — any cwd resolves (everything is bound)", async () => {
    const plan = await buildSpawnPlan(
      makeInput({ scope: makeScope({ filesystem: "full" }), workspace: "/ws", cwd: "/anywhere/at/all" }),
      BWRAP,
    );
    expect(plan.argv).toContain("/anywhere/at/all");
  });
});
