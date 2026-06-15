// SPDX-License-Identifier: Apache-2.0
/**
 * buildSpawnPlan — the scope-jail COMPOSITION seam (macOS-testable, pure).
 *
 * These tests prove the PRODUCTION composition (not just `buildScopeArgs` in
 * isolation): `buildSpawnPlan` threads the resolved in-jail relay-as-init SCRIPT
 * path into the bwrap argv as a `--ro-bind` for `network: listed-hosts` ONLY, so
 * the in-jail `node <relayInit>` can READ its own init script. The file exists on
 * the HOST but is not bound by default — the VPS scope-matrix egress cell died with
 * `Cannot find module …/egress-relay-init.js` because that bind was missing.
 *
 * NO bwrap spawn, NO real socket — a fixed in-memory `EgressControlPort` echoes a
 * socket path, so the full argv composition is asserted on macOS. The live relay
 * bridge is the VPS suite (`terminal-scope-matrix.linux.test.ts`).
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";

import type { EgressControlPort } from "@comis/core";

import { buildSpawnPlan, type SpawnPlanInput } from "./terminal-spawn-plan.js";
import { RELAY_INIT_SCRIPT_URL } from "./terminal-egress-relay.js";
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

/** A fixed EgressControlPort that echoes a socket path (no real proxy stood up). */
function fixedEgressControl(socketPath: string): EgressControlPort {
  return {
    materialize: () => Promise.resolve({ socketPath, dispose: () => Promise.resolve() }),
  };
}

/** Check that args contain a `flag src dest` triple. */
function hasBind(args: string[], flag: string, src: string, dest?: string): boolean {
  const d = dest ?? src;
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === flag && args[i + 1] === src && args[i + 2] === d) return true;
  }
  return false;
}

const RELAY_INIT_PATH = fileURLToPath(RELAY_INIT_SCRIPT_URL);

describe("buildSpawnPlan — relay-init script bind (the VPS Cannot-find-module fix)", () => {
  it("listed-hosts ro-binds the relay-init script into the jail (so in-jail node can read it)", async () => {
    const plan = await buildSpawnPlan(
      makeInput({ scope: makeScope({ network: "listed-hosts", hosts: ["example.com"] }) }),
      { bwrapPath: "/usr/bin/bwrap", egressControl: fixedEgressControl("/tmp/egress.sock") },
    );
    // The bound path must be the SAME path node execs (relayArgv[1]) — never drift.
    expect(hasBind(plan.argv, "--ro-bind", RELAY_INIT_PATH, RELAY_INIT_PATH)).toBe(true);
    // And the relay-init is actually invoked in the argv (the path is load-bearing).
    expect(plan.argv).toContain(RELAY_INIT_PATH);
  });

  it("none does NOT ro-bind the relay-init script (no relay in the path)", async () => {
    const plan = await buildSpawnPlan(makeInput({ scope: makeScope({ network: "none" }) }), {
      bwrapPath: "/usr/bin/bwrap",
    });
    expect(plan.argv).not.toContain(RELAY_INIT_PATH);
  });

  it("full does NOT ro-bind the relay-init script (host net, no relay)", async () => {
    const plan = await buildSpawnPlan(makeInput({ scope: makeScope({ network: "full" }) }), {
      bwrapPath: "/usr/bin/bwrap",
    });
    expect(plan.argv).not.toContain(RELAY_INIT_PATH);
  });
});
