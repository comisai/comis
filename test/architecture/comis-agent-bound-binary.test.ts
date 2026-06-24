// SPDX-License-Identifier: Apache-2.0
/**
 * CLI-05 drift gate (§4.7 writable-path-audit arch-test entry): the committed
 * `comis-agent-manifest.json` sha256 equals `createHash("sha256")` of the
 * freshly-built `comis-agent-entry.js`. Because the manifest is the trust anchor
 * `resolveJailAgentCli` verifies the `--ro-bind`-bound binary against (Plan 06),
 * this gate makes manifest ↔ artifact drift a BUILD failure — a source change to
 * the entry (or its transitive imports) without a regen no longer compiles past
 * CI; the fix is "run `pnpm agent-cli:manifest` and commit".
 *
 * Test strategy (a verbatim adaptation of `orchestrate-sdk-drift.test.ts`):
 *   1. Read the committed manifest.
 *   2. Re-hash the freshly-built `packages/skills/dist/.../comis-agent-entry.js`
 *      (this gate runs under `test:coverage` AFTER `build:clean`, so the dist
 *      file is present).
 *   3. Assert the committed sha256 == the fresh hash. Any mismatch indicates
 *      either the entry changed without a regen, or a tampered committed manifest
 *      (the T-219-22 threat).
 *
 * Pitfall 2 — this pins the COMIS-built artifact (deterministic from source via
 * `tsc`), NOT `process.execPath` (the host node, whose hash is build-machine-
 * specific). The generator NEVER reads `process.execPath`.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runGenerate,
  buildManifest,
  serializeManifest,
  ENTRY_PATH,
  OUT_PATH,
  ENTRY_FILENAME,
  type ComisAgentManifest,
} from "../../scripts/orchestrate-sdk/generate-comis-agent-manifest.js";

describe("comis-agent bound-binary manifest drift gate (CLI-05)", () => {
  it("the committed manifest sha256 is byte-identical to a fresh hash of the built comis-agent-entry.js", () => {
    // Snapshot the committed manifest.
    const committed = JSON.parse(readFileSync(OUT_PATH, "utf8")) as ComisAgentManifest;

    // Re-hash the freshly-built dist entry directly (the gate's ground truth).
    const entryBytes = readFileSync(ENTRY_PATH);
    const freshSha = createHash("sha256").update(entryBytes).digest("hex");

    // The manifest pins the artifact basename, never a host path.
    expect(committed.file).toBe(ENTRY_FILENAME);

    // CRITICAL ASSERTION: the committed pin must equal the fresh hash. If this
    // fails, run `pnpm agent-cli:manifest` and commit the updated manifest.
    if (committed.sha256 !== freshSha) {
      expect.fail(
        `comis-agent manifest drift detected — committed sha256 (${committed.sha256}) ` +
          `differs from the freshly-built comis-agent-entry.js hash (${freshSha}). ` +
          `The manifest pins the comis-built CLI binary — run \`pnpm agent-cli:manifest\` ` +
          `and commit packages/skills/src/tools/builtin/orchestrate/comis-agent-manifest.json.`,
      );
    }
    expect(committed.sha256).toBe(freshSha);

    // The generator, run into a temp dir, reproduces the committed manifest
    // byte-for-byte from the same built entry (catches a writeFileSync / key-order
    // regression — the in-memory string equals what `runGenerate` writes to disk).
    const tmp = mkdtempSync(join(tmpdir(), "comis-agent-manifest-drift-"));
    try {
      const generated = runGenerate(ENTRY_PATH, join(tmp, "comis-agent-manifest.json"));
      const onDisk = readFileSync(join(tmp, "comis-agent-manifest.json"), "utf8");
      expect(generated, "in-memory manifest diverges from disk").toBe(onDisk);
      expect(readFileSync(OUT_PATH, "utf8")).toBe(generated);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the manifest is deterministic — only { file, sha256 }, stable key order, and idempotent over the same bytes", () => {
    const bytes = Buffer.from("deterministic-fixture-bytes");

    const first = buildManifest(bytes);
    const second = buildManifest(bytes);

    // A second generation over the same bytes is byte-identical (no clock/uuid/
    // host-path field that would vary run to run).
    expect(first).toBe(second);

    // The manifest carries EXACTLY two keys: file then sha256 (no extra field).
    const parsed = JSON.parse(first) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["file", "sha256"]);
    expect(parsed.file).toBe(ENTRY_FILENAME);
    expect(typeof parsed.sha256).toBe("string");
    // sha256 is 64 lowercase-hex chars.
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);

    // POSIX trailing newline + 2-space indent (the deterministic serialization).
    expect(first.endsWith("}\n")).toBe(true);
    expect(first).toContain('\n  "file"');

    // serializeManifest is pure over a manifest object (same input → same string).
    const manifest: ComisAgentManifest = { file: ENTRY_FILENAME, sha256: "a".repeat(64) };
    expect(serializeManifest(manifest)).toBe(serializeManifest(manifest));
  });
});
