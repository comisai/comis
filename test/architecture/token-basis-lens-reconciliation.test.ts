// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-lens gate: `totalTokens` must declare which convention it counts.
 *
 * The drift this pins: `IncidentReport.cost.totalTokens` counts input + output +
 * CACHE, while `SystemHealthReport.cost.totalTokens` counts input + output only.
 * One 27-minute session legitimately reported 6,043,245 on one lens and 18,637 on
 * the other, and neither JSON said which convention it followed — so a reader
 * comparing them concludes a lens is broken. The `tokenBasis` discriminator makes
 * the two reconcilable programmatically.
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

  it("the SystemHealthReport schema declares the cache-exclusive basis", () => {
    const src = read("packages/core/src/api-contracts/system-health-report.ts");
    expect(src).toContain('tokenBasis: z.literal("input+output")');
  });

  it("the two lenses declare DIFFERENT bases (the whole point of the field)", () => {
    const incident = read("packages/core/src/api-contracts/incident-report.ts");
    const system = read("packages/core/src/api-contracts/system-health-report.ts");
    expect(incident).toContain("input+output+cache");
    // …and the system lens must NOT claim the cache-inclusive basis.
    expect(system).not.toContain('z.literal("input+output+cache")');
  });

  it("each assembler STAMPS its basis (a schema field nothing populates is dead)", () => {
    expect(read("packages/daemon/src/api/obs-handlers/obs-explain-assemble.ts"))
      .toContain('tokenBasis: "input+output+cache"');
    expect(read("packages/daemon/src/api/obs-handlers/system-health.ts"))
      .toContain('tokenBasis: "input+output"');
  });
});
