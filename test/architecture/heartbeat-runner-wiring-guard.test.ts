// SPDX-License-Identifier: Apache-2.0
/** Pins the live coordinator path used by heartbeat management RPCs. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const daemonFile = resolve(repoRoot, "packages/daemon/src/daemon.ts");
const dispatchFile = resolve(repoRoot, "packages/daemon/src/api/rpc-dispatch.ts");
const heartbeatHandlersFile = resolve(repoRoot, "packages/daemon/src/api/heartbeat-handlers.ts");

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => line.trim().startsWith("//") ? "" : line)
    .join("\n");
}

describe("heartbeat coordinator live wiring source guard", () => {
  it("heartbeat handlers submit manual work through the coordinator", () => {
    const code = stripComments(readFileSync(heartbeatHandlersFile, "utf8"));
    expect(code).toMatch(/deps\.heartbeatCoordinator\.submitWake\(/);
    expect(code).not.toMatch(/perAgentRunner/);
    expect(code).not.toMatch(/wakeCoalescer/);
  });

  it("RPC dispatch forwards the shared orchestration dependencies without a runner override", () => {
    const code = stripComments(readFileSync(dispatchFile, "utf8"));
    expect(code).toMatch(/createHeartbeatHandlers\(\{\s*\.\.\.deps,/);
    expect(code).not.toMatch(/perAgentRunner:\s*deps\.perAgentRunner/);
    expect(code).not.toMatch(/wakeCoalescer/);
  });

  it("daemon dispatch dependencies expose coordinator phase and clock inputs", () => {
    const code = stripComments(readFileSync(daemonFile, "utf8"));
    expect(code).toMatch(/heartbeatCoordinator:\s*c\.heartbeatCoordinator/);
    expect(code).toMatch(/getAgentSchedulerSeed:\s*c\.getAgentSchedulerSeed/);
    expect(code).toMatch(/schedulerNowMs:\s*\(\)\s*=>\s*c\.clock\.now\(\)/);
    expect(code).not.toMatch(/perAgentRunner:\s*c\.perAgentRunner/);
    expect(code).not.toMatch(/wakeCoalescer:\s*c\.wakeCoalescer/);
  });
});
