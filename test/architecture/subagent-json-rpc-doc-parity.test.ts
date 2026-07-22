// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SUBAGENT_HANDLERS_CONTRACTS } from "@comis/core";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const reference = readFileSync(resolve(repoRoot, "docs/reference/json-rpc.mdx"), "utf8");

function between(document: string, startMarker: string, endMarker: string): string {
  const start = document.indexOf(startMarker);
  const end = document.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`Documentation section is missing: ${startMarker}`);
  return document.slice(start, end);
}

function expectTokens(section: string, tokens: readonly string[]): void {
  for (const token of tokens) expect(section, `missing ${token}`).toContain(`\`${token}\``);
}

const subagent = between(
  reference,
  '<Accordion title="subagent (',
  '<Accordion title="capabilities (',
);

const orderedMethods = SUBAGENT_HANDLERS_CONTRACTS.map((contract) => contract.method);

function methodSection(method: string): string {
  const index = orderedMethods.indexOf(method);
  const next = orderedMethods[index + 1];
  return between(subagent, `### \`${method}\``, next === undefined ? "</Accordion>" : `### \`${next}\``);
}

describe("sub-agent JSON-RPC documentation parity", () => {
  it("documents the registered seven-method inventory with contract-derived scopes", () => {
    expect(subagent).toContain('<Accordion title="subagent (7 methods)">');
    for (const contract of SUBAGENT_HANDLERS_CONTRACTS) {
      expect(subagent).toContain(`### \`${contract.method}\``);
      const scope = contract.scopes.map((value) => `\`${value}\``).join(", ");
      expect(methodSection(contract.method), `${contract.method} scope`).toContain(`| **Scope** | ${scope} |`);
    }
  });

  it("documents exact list wait kill and steer request and response contracts", () => {
    expectTokens(methodSection("subagent.list"), [
      "recentMinutes", "agentId", "rootRunId", "runs", "total", "rpc", "admin",
    ]);
    expectTokens(methodSection("subagent.wait"), [
      "runIds", "timeoutMs", "results", "runId", "completed", "denied_unknown",
      "timeout", "cancelled", "completion", "endReason", "completedAtMs", "errorKind",
      "summary", "resultRef",
    ]);
    expectTokens(methodSection("subagent.kill"), ["target", "killed", "runId"]);
    expectTokens(methodSection("subagent.steer"), [
      "target", "message", "security.agentToAgent.steerInject", "steered", "oldRunId",
      "newRunId", "steered_inject", "runId",
    ]);
  });

  it("requires owner projection steer modes and restart-reset admission semantics", () => {
    expect(subagent).toMatch(/agent callers?.*owned|owner-scoped/isu);
    expect(methodSection("subagent.steer")).toMatch(/2 seconds|2s/iu);
    expect(methodSection("subagent.steer")).toMatch(/next step boundary/iu);
    expect(methodSection("subagent.steer")).toMatch(/kill.*respawn/isu);

    for (const method of ["subagent.pause", "subagent.resume"]) {
      expectTokens(methodSection(method), [
        "paused", "acceptingSpawns", "resetsOnRestart", "changed",
      ]);
    }
    expectTokens(methodSection("subagent.status"), [
      "paused", "acceptingSpawns", "resetsOnRestart",
    ]);
    expect(subagent).toMatch(/process-lifetime|process lifetime/iu);
    expect(subagent).toMatch(/restart.*unpaused|unpaused.*restart/iu);
    expect(subagent).toMatch(/existing|running.*continue/iu);
  });
});
