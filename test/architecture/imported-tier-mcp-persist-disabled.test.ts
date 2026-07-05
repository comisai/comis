// SPDX-License-Identifier: Apache-2.0
/**
 * Pins the imported trust tier's MCP posture: a bundled MCP entry that arrives
 * via an imported skill persists DISABLED and is NEVER auto-connected at
 * install. The operator opts in per server later, and each later connect re-runs
 * the malware/secret checks at the connect site.
 *
 * Why a dedicated architecture gate: the disabled-by-default posture is
 * inseparable from the imported tier — it is the difference between "a remote
 * author's manifest can declare a code-exec MCP server that the daemon quietly
 * connects at install" and "the operator must consciously enable each server".
 * A refactor that flipped an imported entry to `enabled: true`, added an
 * auto-connect loop to the import path, or introduced an `autoConnectBundledMcp`
 * config toggle would silently erode that boundary. This gate fails the build
 * with a line number if any of those regress.
 *
 * Two source anchors carry the invariant:
 *   - the injected imported-tier persist seam (`applyImportedBundleInstall` in
 *     `bundle-install-helper.ts`): forces `enabled: false` + never `.connect(`.
 *   - the serialized commit (`import-commit.ts`): disables bundle entries before
 *     the persist hand-off + never reaches for an MCP client manager.
 *
 * The gate is source-scanning (mirrors `mcp-no-module-globals.test.ts`) and
 * SELF-VALIDATING: an inline fixture proves the function-body slicer isolates
 * the right function before the real-file assertions are trusted.
 *
 * Auto-discovered by the `test/architecture` vitest project.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

const HELPER = resolve(REPO_ROOT, "packages/daemon/src/skills/bundle-install-helper.ts");
const COMMIT = resolve(REPO_ROOT, "packages/daemon/src/skills/import-commit.ts");
const PACKAGES = resolve(REPO_ROOT, "packages");

/**
 * Slice `src` to the text of the named `export [async] function <name>` up to
 * the next TOP-LEVEL `export ` (or end of file). Returns "" when the function is
 * absent — the caller asserts non-empty so a rename fails loudly rather than
 * silently passing on an empty body.
 */
function sliceExportedFunction(src: string, name: string): string {
  const startRe = new RegExp(`export (?:async )?function ${name}\\b`);
  const m = startRe.exec(src);
  if (!m) return "";
  const start = m.index;
  const nextExport = src.indexOf("\nexport ", start + m[0].length);
  return nextExport === -1 ? src.slice(start) : src.slice(start, nextExport);
}

/** Recursively collect every `.ts` source file under `packages/`, skipping `dist` + `node_modules`. */
function collectTsSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectTsSources(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("imported-tier MCP persist-disabled + no auto-connect", () => {
  it("self-validates: the function-body slicer isolates the named function", () => {
    const fixture = [
      "export function before() { return 1; }",
      "export async function target(a: number) {",
      "  const x = { enabled: false };",
      "  return x.enabled ? a : 0;",
      "}",
      "export function after() { return 2; }",
    ].join("\n");
    const body = sliceExportedFunction(fixture, "target");
    expect(body).toContain("enabled: false");
    expect(body).not.toContain("before()");
    expect(body).not.toContain("after()");
    expect(sliceExportedFunction(fixture, "missing")).toBe("");
  });

  it("applyImportedBundleInstall persists enabled:false and never auto-connects", () => {
    const src = readFileSync(HELPER, "utf8");
    const body = sliceExportedFunction(src, "applyImportedBundleInstall");
    expect(body, "applyImportedBundleInstall must exist in bundle-install-helper.ts").not.toBe("");
    // The imported persist path forces the disabled posture.
    expect(body, "imported-tier entries must persist enabled:false").toMatch(/enabled:\s*false/);
    // The imported persist path must NOT auto-connect any MCP entry.
    expect(body, "the imported install path must not call .connect()").not.toMatch(/\.connect\s*\(/);
  });

  it("the serialized commit disables imported bundle entries and never reaches an MCP client manager", () => {
    const src = readFileSync(COMMIT, "utf8");
    expect(src, "the commit must persist imported bundle entries disabled").toMatch(/enabled:\s*false/);
    // The commit hands off to the persist seam — it never connects or touches a
    // client manager directly (an imported bundle stays offline until opt-in).
    expect(src, "the commit must not auto-connect imported bundle entries").not.toMatch(
      /mcpClientManager|\.connect\s*\(/,
    );
  });

  it("has no autoConnectBundledMcp config knob anywhere in packages/", () => {
    const offenders = collectTsSources(PACKAGES)
      .filter((f) => readFileSync(f, "utf8").includes("autoConnectBundledMcp"))
      .map((f) => f.slice(REPO_ROOT.length + 1));
    expect(
      offenders,
      `A per-server opt-in is the only sanctioned path; there must be no auto-connect toggle:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
