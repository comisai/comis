// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-lens gate: `totalTokens` must declare which convention it counts.
 *
 * Incident and system-health reports both expose the reconciled provider billing
 * ledger. They therefore use the same cache-inclusive convention so cost, tokens,
 * and calls reconcile programmatically across the two lenses.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

describe("totalTokens declares its counting convention on every lens", () => {
  it("the IncidentReport schema declares the cache-inclusive basis", () => {
    const src = read("packages/core/src/api-contracts/incident-report.ts");
    expect(src).toContain('tokenBasis: z.literal("input+output+cache")');
  });

  it("the SystemHealthReport schema declares the cache-inclusive basis", () => {
    const src = read("packages/core/src/api-contracts/system-health-report.ts");
    expect(src).toContain('tokenBasis: z.literal("input+output+cache")');
  });

  it("both provider-ledger lenses declare the same counting basis", () => {
    const incident = read("packages/core/src/api-contracts/incident-report.ts");
    const system = read("packages/core/src/api-contracts/system-health-report.ts");
    expect(incident).toContain('z.literal("input+output+cache")');
    expect(system).toContain('z.literal("input+output+cache")');
  });

  it("each assembler STAMPS its basis (a schema field nothing populates is dead)", () => {
    expect(read("packages/daemon/src/api/obs-handlers/obs-explain-assemble.ts"))
      .toContain('tokenBasis: "input+output+cache"');
    expect(read("packages/daemon/src/api/obs-handlers/system-health.ts"))
      .toContain('tokenBasis: "input+output+cache"');
  });
});
