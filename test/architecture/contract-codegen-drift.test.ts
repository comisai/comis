// SPDX-License-Identifier: Apache-2.0
/**
 * CI drift gate: `pnpm contracts:generate` produces zero diff against the
 * committed artifacts. If a contract is added/modified/removed without
 * rerunning the generator, this test fails.
 *
 * Test strategy:
 *   1. Read the committed `packages/web/src/api/contracts.generated.*` files.
 *   2. Run `runCodegen()` into a throwaway temp dir — produces a fresh
 *      CodegenResult AND the freshly-written bytes, without touching the
 *      committed artifacts.
 *   3. Compare byte-for-byte. Any mismatch indicates either:
 *      - A contract added/changed without rerunning `pnpm contracts:generate`.
 *      - A non-determinism regression in the codegen pipeline.
 *
 * Why a temp dir (not the committed paths): `scripts/contracts/generate.test.ts`
 * is a SEPARATE vitest project that also calls `runCodegen()` (6×). The two
 * projects run in parallel forks, so if this gate wrote-then-read-back the
 * shared committed files it would race that test's concurrent writes and
 * report a spurious drift (catching an in-progress writeFileSync). Writing to
 * a per-run temp dir removes the gate from that race entirely while asserting
 * the identical invariant: committed bytes == fresh codegen output.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runCodegen,
  OUT_TS,
  OUT_JSON,
  OUT_SIZE,
} from "../../scripts/contracts/generate-web-artifact.js";

describe("contract codegen drift gate", () => {
  it("pnpm contracts:generate is a no-op against the committed artifacts", () => {
    // Snapshot the committed files.
    const committedTs = readFileSync(OUT_TS, "utf8");
    const committedJson = readFileSync(OUT_JSON, "utf8");
    const committedSize = readFileSync(OUT_SIZE, "utf8");

    // Regenerate into a throwaway temp dir so we never touch (or race on) the
    // committed artifacts. The artifact filenames are constant across dirs.
    const tmp = mkdtempSync(join(tmpdir(), "comis-codegen-drift-"));
    let generatedTs: string;
    let generatedJson: string;
    let generatedSize: string;
    let result: ReturnType<typeof runCodegen>;
    try {
      result = runCodegen(tmp);
      generatedTs = readFileSync(join(tmp, "contracts.generated.ts"), "utf8");
      generatedJson = readFileSync(join(tmp, "contracts.generated.json"), "utf8");
      generatedSize = readFileSync(join(tmp, "contracts.generated.size.json"), "utf8");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

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
  });
});
