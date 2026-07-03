// SPDX-License-Identifier: Apache-2.0
/**
 * Drift gate: `pnpm sdk:generate` produces zero diff against the
 * committed `comis_tools.{d.ts,js,py}`. Because the SDK is emitted from the SAME
 * `TOOL_CAPABILITY_MAP` as the `tool.invoke` gate, this gate makes
 * SDK ↔ gate drift a BUILD failure — a hand-edit surfacing a tool the gate
 * denies (or hiding one it allows) no longer compiles past CI.
 *
 * Test strategy (a verbatim adaptation of `contract-codegen-drift.test.ts`):
 *   1. Read the committed `packages/skills/.../orchestrate/comis_tools.{d.ts,js,py}`.
 *   2. Run `runCodegen()` into a throwaway temp dir — produces fresh strings
 *      AND the freshly-written bytes, without touching the committed artifacts.
 *   3. Compare byte-for-byte. Any mismatch indicates either:
 *      - The cap-map changed without rerunning `pnpm sdk:generate`.
 *      - A non-determinism regression in the codegen.
 *      - A hand-edit of the committed SDK (a tampering vector).
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
  OUT_PY,
} from "../../scripts/orchestrate-sdk/generate-comis-tools-sdk.js";

describe("orchestrate comis_tools SDK drift gate", () => {
  it("the comis_tools SDK is byte-identical to a fresh regen from the cap-map", () => {
    // Snapshot the committed artifacts.
    const committedDts = readFileSync(OUT_DTS, "utf8");
    const committedJs = readFileSync(OUT_JS, "utf8");
    const committedPy = readFileSync(OUT_PY, "utf8");

    // Regenerate into a throwaway temp dir so we never touch (or race on) the
    // committed artifacts. The artifact filenames are constant across dirs.
    const tmp = mkdtempSync(join(tmpdir(), "comis-sdk-drift-"));
    let generatedDts: string;
    let generatedJs: string;
    let generatedPy: string;
    let result: ReturnType<typeof runCodegen>;
    try {
      result = runCodegen(tmp);
      generatedDts = readFileSync(join(tmp, "comis_tools.d.ts"), "utf8");
      generatedJs = readFileSync(join(tmp, "comis_tools.js"), "utf8");
      generatedPy = readFileSync(join(tmp, "comis_tools.py"), "utf8");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    // The codegen returns the strings it wrote — assert disk matches the
    // in-memory result (catches a writeFileSync regression).
    expect(generatedDts, "in-memory dts diverges from disk").toBe(result.dts);
    expect(generatedJs, "in-memory js diverges from disk").toBe(result.js);
    expect(generatedPy, "in-memory py diverges from disk").toBe(result.py);

    // CRITICAL ASSERTION: the committed files must be byte-identical to the
    // freshly-regenerated ones. If this fails, run `pnpm sdk:generate` and
    // commit the resulting changes to comis_tools.{d.ts,js}.
    const dtsMatch = committedDts === generatedDts;
    const jsMatch = committedJs === generatedJs;
    const pyMatch = committedPy === generatedPy;

    if (!dtsMatch || !jsMatch || !pyMatch) {
      const drifted: string[] = [];
      if (!dtsMatch) drifted.push("comis_tools.d.ts");
      if (!jsMatch) drifted.push("comis_tools.js");
      if (!pyMatch) drifted.push("comis_tools.py");
      expect.fail(
        `comis_tools SDK drift detected — files differ from committed versions: ${drifted.join(", ")}. ` +
          `The SDK is generated from TOOL_CAPABILITY_MAP — run \`pnpm sdk:generate\` and commit the changes ` +
          `to packages/skills/src/tools/builtin/orchestrate/comis_tools.{d.ts,js,py}.`,
      );
    }

    expect(dtsMatch).toBe(true);
    expect(jsMatch).toBe(true);
    expect(pyMatch).toBe(true);
  });

  it("describe() carries a worked example per capability group in all three SDKs", () => {
    // Read the committed artifacts (the exact bytes the drift gate above locks).
    const committedDts = readFileSync(OUT_DTS, "utf8");
    const committedJs = readFileSync(OUT_JS, "utf8");
    const committedPy = readFileSync(OUT_PY, "utf8");

    // (1) The `.d.ts` typed surface: the ToolDescriptor interface must declare the
    // `example` field, so the typed SDK carries the worked example too.
    expect(
      committedDts,
      "comis_tools.d.ts: ToolDescriptor must declare `readonly example` — run `pnpm sdk:generate`",
    ).toContain("readonly example");

    // (2)+(3) The `.js` and `.py` runtime surfaces: parse the emitted DESCRIPTORS
    // array. Its values are string-only, so the pretty-printed JSON block is the
    // IDENTICAL text in both artifacts (parity by construction) and JSON-parses in
    // each. The array closes on a line-start `]` (`\n]`); example strings live on
    // indented lines, so an inner `]` (e.g. a `.[0:3]` slice) never matches the
    // terminator.
    const parseDescriptors = (
      src: string,
      label: string,
    ): Array<{ name: string; capability: string; summary: string; example?: unknown }> => {
      const match = src.match(/DESCRIPTORS = (\[[\s\S]*?\n\])/);
      expect(match, `${label}: could not locate the DESCRIPTORS array literal`).not.toBeNull();
      return JSON.parse(match![1]!);
    };

    for (const [label, src] of [
      ["comis_tools.js", committedJs],
      ["comis_tools.py", committedPy],
    ] as const) {
      const entries = parseDescriptors(src, label);
      expect(entries.length, `${label}: DESCRIPTORS is empty`).toBeGreaterThan(0);

      // Every descriptor carries a non-empty string worked example.
      for (const entry of entries) {
        expect(
          typeof entry.example,
          `${label}: descriptor "${entry.name}" is missing a string example`,
        ).toBe("string");
        expect(
          (entry.example as string).length,
          `${label}: descriptor "${entry.name}" has an empty example`,
        ).toBeGreaterThan(0);
      }

      // The example is keyed by capability GROUP: both groups (orch:read, orch:web)
      // are covered, and every descriptor sharing a capability shares the SAME
      // worked example (the single `exampleFor(capability)` source).
      const examplesByCap = new Map<string, Set<string>>();
      for (const entry of entries) {
        const set = examplesByCap.get(entry.capability) ?? new Set<string>();
        set.add(entry.example as string);
        examplesByCap.set(entry.capability, set);
      }
      expect(
        new Set(entries.map((entry) => entry.capability)).size,
        `${label}: expected exactly two capability groups (orch:read, orch:web)`,
      ).toBe(2);
      for (const [capability, examples] of examplesByCap) {
        expect(
          examples.size,
          `${label}: capability "${capability}" must map to exactly one worked example`,
        ).toBe(1);
        expect(
          [...examples][0]!.length,
          `${label}: capability "${capability}" has an empty example`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
