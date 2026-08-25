// SPDX-License-Identifier: Apache-2.0
/**
 * Every literal config path the web app writes must exist in the config schema.
 *
 * A dashboard control that patches a path no schema declares is invisible until
 * someone clicks Save: the write is rejected at runtime, so the control reads as
 * configuration while enforcing nothing. A control under a runtime-immutable
 * prefix cannot succeed even when its path is real.
 *
 * `getFieldMetadata()` enumerates every declared path, so a literal target that
 * is not in it is a control that can never succeed.
 *
 * Only literal targets are checked. A view that computes its path at runtime
 * (the config editor walks the schema itself) is outside this guard.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getFieldMetadata } from "@comis/core";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const WEB_SRC = resolve(REPO_ROOT, "packages/web/src");

/** Recursively collect .ts files, excluding tests and generated clients. */
function collectTsFiles(root: string, acc: string[] = [], base = root): string[] {
  for (const entry of readdirSync(root)) {
    const full = resolve(root, entry);
    if (statSync(full).isDirectory()) {
      collectTsFiles(full, acc, base);
    } else if (
      entry.endsWith(".ts")
      && !entry.endsWith(".test.ts")
      && !entry.endsWith(".d.ts")
      && !entry.endsWith(".generated.ts")
    ) {
      acc.push(relative(base, full));
    }
  }
  return acc;
}

/** A literal config path a view writes, with the line that writes it. */
interface PatchTarget {
  readonly path: string;
  readonly line: number;
}

/**
 * Extract literal patch targets from one source file.
 *
 * Two shapes reach `config.patch`: a dotted path handed to a view's own patch
 * helper, and an inline `section` / `key` pair on the RPC parameters.
 */
function extractPatchTargets(src: string): PatchTarget[] {
  const targets: PatchTarget[] = [];
  const lineOf = (index: number): number => src.slice(0, index).split("\n").length;

  const helperCall = /_?patchConfig\(\s*"([^"]+)"/g;
  for (let m = helperCall.exec(src); m !== null; m = helperCall.exec(src)) {
    targets.push({ path: m[1]!, line: lineOf(m.index) });
  }

  const rpcCall = /"config\.patch",\s*\{([\s\S]{0,400}?)\}/g;
  for (let m = rpcCall.exec(src); m !== null; m = rpcCall.exec(src)) {
    const body = m[1]!;
    const section = /\bsection:\s*"([^"]+)"/.exec(body)?.[1];
    if (section === undefined) continue;
    const key = /\bkey:\s*"([^"]+)"/.exec(body)?.[1];
    targets.push({
      path: key === undefined ? section : `${section}.${key}`,
      line: lineOf(m.index),
    });
  }

  return targets;
}

describe("web config patch targets exist in the schema", () => {
  it("every literal path the web app patches is a declared config path", () => {
    const declared = new Set(getFieldMetadata().map((field) => field.path));
    const violations: { file: string; line: number; snippet: string }[] = [];

    for (const rel of collectTsFiles(WEB_SRC)) {
      const src = readFileSync(resolve(WEB_SRC, rel), "utf8");
      for (const target of extractPatchTargets(src)) {
        if (declared.has(target.path)) continue;
        violations.push({
          file: `packages/web/src/${rel}`,
          line: target.line,
          snippet: `patches "${target.path}", which no config schema declares — the write is rejected at runtime`,
        });
      }
    }

    expect(
      violations,
      formatViolations({
        description: "Web app patches config paths that no schema declares.",
        violations,
        suggestedFix:
          "Point the control at a declared path, or remove it. A path under a "
          + "runtime-immutable prefix cannot be written at all — render it read-only instead.",
      }),
    ).toEqual([]);
  });

  it("recognizes both the helper-path and section-key call shapes", () => {
    const src = [
      'await this._patchConfig("security.permission", updated);',
      'await this.rpc.call("config.patch", { section: "approvals", key: "rules", value: v });',
      'await this.rpc.call("config.patch", { section: "models", value: v });',
    ].join("\n");

    expect(extractPatchTargets(src).map((t) => t.path)).toEqual([
      "security.permission",
      "approvals.rules",
      "models",
    ]);
  });
});
