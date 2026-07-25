// SPDX-License-Identifier: Apache-2.0
/**
 * The registry leaf hosts `setupAgents` (top-level orchestrator). This
 * test inspects the for-loop that delegates per configured agent to
 * setupSingleAgent.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setupAgents } from "./setup-agents-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readRegistrySource(): string {
  return readFileSync(join(__dirname, "setup-agents-registry.ts"), "utf-8");
}

describe("setup-agents-registry orchestration", () => {
  const source = readRegistrySource();

  it("setupAgents is exported and is an async function", () => {
    expect(typeof setupAgents).toBe("function");
    expect(source).toContain("export async function setupAgents(deps:");
  });

  it("rejects startup when the canonical context store is missing", async () => {
    await expect(setupAgents({} as Parameters<typeof setupAgents>[0])).rejects.toThrow(
      "ContextStorePort",
    );
  });

  it("setupAgents loop body delegates to setupSingleAgent", () => {
    // Find the for-loop in setupAgents (after the singleAgentDeps construction)
    const loopStart = source.indexOf("for (const [agentId, agentConfig] of Object.entries(agents))");
    expect(loopStart).toBeGreaterThan(-1);

    // Find the end of the for-loop block
    const afterLoop = source.indexOf("const defaultAgentId", loopStart);
    expect(afterLoop).toBeGreaterThan(loopStart);

    const loopBody = source.slice(loopStart, afterLoop);

    // Loop body must call setupSingleAgent
    expect(loopBody).toContain("setupSingleAgent(");

    // Loop body must NOT contain inline executor creation (that logic lives in
    // setup-agents-runtime.ts's setupSingleAgent post-split).
    expect(loopBody).not.toContain("createPiExecutor(");
    expect(loopBody).not.toContain("createCircuitBreaker(");
    expect(loopBody).not.toContain("createBudgetGuard(");
    expect(loopBody).not.toContain("createCostTracker(");
  });

  it("AgentsResult includes singleAgentDeps field", () => {
    // Find AgentsResult interface
    const agentsResultStart = source.indexOf("export interface AgentsResult {");
    expect(agentsResultStart).toBeGreaterThan(-1);
    const agentsResultEnd = source.indexOf("\n}", agentsResultStart);
    const agentsResultBlock = source.slice(agentsResultStart, agentsResultEnd);

    expect(agentsResultBlock).toContain("singleAgentDeps: SingleAgentDeps");
  });

  it("setupAgents body constructs the daemon-level OAuthCredentialStore handle once", () => {
    // Regression guard for the "ONCE per daemon" guarantee that setupAgents
    // gives downstream rpc-dispatch deps (agents.update existence checks).
    const fnStart = source.indexOf("export async function setupAgents(deps:");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart);
    expect(fnBody).toContain("selectOAuthCredentialStore({");
    // The encrypted-store guard must fail fast (raw throw, allowlist entry).
    expect(fnBody).toContain('throw new Error(');
    expect(fnBody).toContain("secretsDb || !deps.secretsCrypto");
  });
});
