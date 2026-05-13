// SPDX-License-Identifier: Apache-2.0
/**
 * WEB-CONTRACTS-13 CI drift gate: `pnpm contracts:generate` produces zero
 * diff against the committed artifacts. If a contract is added/modified/
 * removed without rerunning the generator, this test fails.
 *
 * Phase 35 Wave D Plan 35-20 (WARNING 3 fix — wired into pnpm test via
 * vitest.config.ts `projects: ["packages/*", "test/architecture"]`).
 *
 * Test strategy:
 *   1. Run `runCodegen()` in-process — produces a fresh CodegenResult.
 *   2. Read the committed `packages/web/src/api/contracts.generated.*` files.
 *   3. Compare byte-for-byte. Any mismatch indicates either:
 *      - A contract added/changed without rerunning `pnpm contracts:generate`.
 *      - A non-determinism regression in the codegen pipeline.
 *
 * RESEARCH §"Determinism rules (RES-PIT-19)" item 4 — this is the
 * authoritative CI drift gate.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import {
  runCodegen,
  OUT_TS,
  OUT_JSON,
  OUT_SIZE,
} from "../../scripts/contracts/generate-web-artifact.js";

describe("WEB-CONTRACTS-13: codegen drift gate", () => {
  it("pnpm contracts:generate is a no-op against the committed artifacts", () => {
    // Snapshot the committed files BEFORE rerunning codegen.
    const committedTs = readFileSync(OUT_TS, "utf8");
    const committedJson = readFileSync(OUT_JSON, "utf8");
    const committedSize = readFileSync(OUT_SIZE, "utf8");

    // Rerun codegen in-process. The result writes the artifacts to disk
    // (overwriting the snapshot) but we already captured the committed
    // bytes above.
    const result = runCodegen();

    // Read the freshly-written files.
    const generatedTs = readFileSync(OUT_TS, "utf8");
    const generatedJson = readFileSync(OUT_JSON, "utf8");
    const generatedSize = readFileSync(OUT_SIZE, "utf8");

    // The codegen pipeline returns the TS string it wrote — assert disk
    // matches the in-memory result (catches a writeFileSync regression).
    expect(generatedTs, "in-memory tsSource diverges from disk").toBe(result.tsSource);

    // CRITICAL ASSERTION: the committed files must be byte-identical to the
    // freshly-regenerated ones. If this fails, the developer needs to run
    // `pnpm contracts:generate` and commit the resulting changes.
    const tsMatch = committedTs === generatedTs;
    const jsonMatch = committedJson === generatedJson;
    const sizeMatch = committedSize === generatedSize;

    if (!tsMatch || !jsonMatch || !sizeMatch) {
      // Restore the freshly-generated artifacts; the test failure message
      // tells the developer how to fix.
      const drifted: string[] = [];
      if (!tsMatch) drifted.push("contracts.generated.ts");
      if (!jsonMatch) drifted.push("contracts.generated.json");
      if (!sizeMatch) drifted.push("contracts.generated.size.json");
      expect.fail(
        `Codegen drift detected — files differ from committed versions: ${drifted.join(", ")}. ` +
          `Run \`pnpm contracts:generate\` and commit the changes to packages/web/src/api/contracts.generated.*.`,
      );
    }

    expect(tsMatch).toBe(true);
    expect(jsonMatch).toBe(true);
    expect(sizeMatch).toBe(true);

    // Defensive: restore the committed artifacts even on success (no-op
    // when match; but guards against partial writes in interrupted runs).
    if (!tsMatch) writeFileSync(OUT_TS, committedTs);
    if (!jsonMatch) writeFileSync(OUT_JSON, committedJson);
    if (!sizeMatch) writeFileSync(OUT_SIZE, committedSize);
  });
});
