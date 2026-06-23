// SPDX-License-Identifier: Apache-2.0
/**
 * ORCH-03 drift gate: `pnpm sdk:generate` produces zero diff against the
 * committed `comis_tools.{d.ts,js}`. Because the SDK is emitted from the SAME
 * `TOOL_CAPABILITY_MAP` as the `tool.invoke` gate (Plan 02), this gate makes
 * SDK ↔ gate drift a BUILD failure — a hand-edit surfacing a tool the gate
 * denies (or hiding one it allows) no longer compiles past CI.
 *
 * Test strategy (a verbatim adaptation of `contract-codegen-drift.test.ts`):
 *   1. Read the committed `packages/skills/.../orchestrate/comis_tools.{d.ts,js}`.
 *   2. Run `runCodegen()` into a throwaway temp dir — produces fresh strings
 *      AND the freshly-written bytes, without touching the committed artifacts.
 *   3. Compare byte-for-byte. Any mismatch indicates either:
 *      - The cap-map changed without rerunning `pnpm sdk:generate`.
 *      - A non-determinism regression in the codegen.
 *      - A hand-edit of the committed SDK (the tampering threat T-212-12).
 *
 * Why a temp dir (not the committed paths): the same cross-project parallel-fork
 * write race documented at `contract-codegen-drift.test.ts:16-22`. Writing to a
 * per-run temp dir removes this gate from that race while asserting the
 * identical invariant: committed bytes == fresh codegen output.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runCodegen,
  OUT_DTS,
  OUT_JS,
} from "../../scripts/orchestrate-sdk/generate-comis-tools-sdk.js";

describe("orchestrate comis_tools SDK drift gate (ORCH-03)", () => {
  it("the comis_tools SDK is byte-identical to a fresh regen from the cap-map", () => {
    // Snapshot the committed artifacts.
    const committedDts = readFileSync(OUT_DTS, "utf8");
    const committedJs = readFileSync(OUT_JS, "utf8");

    // Regenerate into a throwaway temp dir so we never touch (or race on) the
    // committed artifacts. The artifact filenames are constant across dirs.
    const tmp = mkdtempSync(join(tmpdir(), "comis-sdk-drift-"));
    let generatedDts: string;
    let generatedJs: string;
    let result: ReturnType<typeof runCodegen>;
    try {
      result = runCodegen(tmp);
      generatedDts = readFileSync(join(tmp, "comis_tools.d.ts"), "utf8");
      generatedJs = readFileSync(join(tmp, "comis_tools.js"), "utf8");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    // The codegen returns the strings it wrote — assert disk matches the
    // in-memory result (catches a writeFileSync regression).
    expect(generatedDts, "in-memory dts diverges from disk").toBe(result.dts);
    expect(generatedJs, "in-memory js diverges from disk").toBe(result.js);

    // CRITICAL ASSERTION: the committed files must be byte-identical to the
    // freshly-regenerated ones. If this fails, run `pnpm sdk:generate` and
    // commit the resulting changes to comis_tools.{d.ts,js}.
    const dtsMatch = committedDts === generatedDts;
    const jsMatch = committedJs === generatedJs;

    if (!dtsMatch || !jsMatch) {
      const drifted: string[] = [];
      if (!dtsMatch) drifted.push("comis_tools.d.ts");
      if (!jsMatch) drifted.push("comis_tools.js");
      expect.fail(
        `comis_tools SDK drift detected — files differ from committed versions: ${drifted.join(", ")}. ` +
          `The SDK is generated from TOOL_CAPABILITY_MAP — run \`pnpm sdk:generate\` and commit the changes ` +
          `to packages/skills/src/tools/builtin/orchestrate/comis_tools.{d.ts,js}.`,
      );
    }

    expect(dtsMatch).toBe(true);
    expect(jsMatch).toBe(true);
  });
});
