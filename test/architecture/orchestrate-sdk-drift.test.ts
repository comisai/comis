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
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runCodegen,
  OUT_DTS,
  OUT_JS,
  OUT_PY,
} from "../../scripts/orchestrate-sdk/generate-comis-tools-sdk.js";

/**
 * True if a `python3` interpreter is invocable on this host (macOS dev, the Linux
 * CI runner, and the Docker image all ship one). A genuinely python-less host
 * skips only the Python-validity check below rather than hard-failing.
 */
function python3Available(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
const PYTHON3_PRESENT = python3Available();

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

  it("emits the mcp surface as a runtime proxy (JS Proxy / Python __getattr__), not a flat method", () => {
    // The connected MCP server/tool set is dynamic per connection, so it CANNOT be a
    // static per-tool method — the generator special-cases `mcp` as a runtime proxy
    // resolving comis_tools.mcp.<server>.<tool>(args) to ONE tool.invoke over the cap
    // socket (the fixed wire literal "mcp"; the {server,tool} ride inside args).
    const tmp = mkdtempSync(join(tmpdir(), "comis-sdk-mcp-"));
    let js: string;
    let py: string;
    try {
      const result = runCodegen(tmp);
      js = result.js;
      py = result.py;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    // JS: the proxy composes callCapSocket (the arbitrary-method wire), so the import
    // header pulls it in beside invoke/wrapResultRef.
    expect(
      js,
      "the JS SDK import header must include callCapSocket for the mcp proxy",
    ).toContain(
      'import { invoke, wrapResultRef, callCapSocket } from "./orchestrate-sdk-runtime.js"',
    );
    // The `mcp` binding is a runtime Proxy, NOT a flat `async mcp(args)` invoke method.
    expect(js, "mcp must be a runtime Proxy binding").toMatch(/mcp:\s*new Proxy/);
    expect(js, "mcp must NOT be a flat invoke method").not.toMatch(/async mcp\s*\(/);
    // It frames a single tool.invoke with the fixed literal wire tool "mcp".
    expect(js).toContain('callCapSocket("tool.invoke"');
    expect(js).toContain('tool: "mcp"');

    // Python: an _McpNamespace __getattr__ proxy bound to the module-level `mcp`,
    // resolving to _call_cap_socket("tool.invoke", …) with "tool": "mcp".
    expect(py, "the .py must define the _McpNamespace proxy class").toContain("class _McpNamespace");
    expect(py, "the proxy resolves attribute access via __getattr__").toContain("def __getattr__");
    expect(py, "mcp is bound to the namespace at module level").toMatch(/^mcp = _McpNamespace\(\)$/m);
    expect(py, "mcp must NOT be a flat def").not.toMatch(/^def mcp\(/m);
    expect(py).toContain("_call_cap_socket(");
    expect(py).toContain('"tool": "mcp"');
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
        `${label}: expected exactly three capability groups (orch:read, orch:web, orch:mcp)`,
      ).toBe(3);
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

  // The `.py` describe() worked example is the discovery surface a py model reads
  // to learn how to CHAIN the tools — so it must be valid Python for the
  // module-level, synchronous `comis_tools.py` SDK, not TypeScript. The drift gate
  // above only byte-locks the emitted text; the py_compile gate only proves the
  // MODULE parses (the example is an inert string literal inside DESCRIPTORS, so a
  // TS example there never trips it). This gate closes that blind spot: it extracts
  // each committed `.py` example and parses it AS Python. Before this the examples
  // were TS (`const ref = await comis_tools.grep({ path: … })`) → an instant
  // SyntaxError for a py author (which the recoverable-stderr classifier also
  // excluded from one-shot repair). Skipped only on a genuinely python-less host.
  it.skipIf(!PYTHON3_PRESENT)(
    "the comis_tools.py describe() examples are valid Python (a py model can copy them verbatim)",
    () => {
      const committedPy = readFileSync(OUT_PY, "utf8");
      const match = committedPy.match(/DESCRIPTORS = (\[[\s\S]*?\n\])/);
      expect(match, "comis_tools.py: could not locate the DESCRIPTORS array literal").not.toBeNull();
      const entries = JSON.parse(match![1]!) as Array<{ name: string; example?: unknown }>;
      // The distinct worked examples (one per capability group).
      const examples = [
        ...new Set(
          entries
            .map((entry) => entry.example)
            .filter((example): example is string => typeof example === "string"),
        ),
      ];
      // Non-vacuity: there IS an example per group, so an empty set means the
      // matcher broke, not that the SDK is clean.
      expect(
        examples.length,
        "comis_tools.py: no example strings parsed from DESCRIPTORS — the matcher likely broke",
      ).toBeGreaterThan(0);
      for (const example of examples) {
        try {
          // Parse-only (no execution): a SyntaxError exits non-zero → throws here.
          execFileSync("python3", ["-c", "import ast, sys; ast.parse(sys.stdin.read())"], {
            input: example,
            stdio: "pipe",
          });
        } catch (e) {
          expect.fail(
            `comis_tools.py describe() example is NOT valid Python — a py model copying it ` +
              `gets an instant SyntaxError:\n  ${example}\n  ${String(e)}`,
          );
        }
      }
    },
  );
});
