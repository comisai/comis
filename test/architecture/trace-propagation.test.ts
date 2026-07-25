// SPDX-License-Identifier: Apache-2.0
/**
 * Trace-propagation architecture test.
 *
 * Every adapter inbound dispatch site (the `for (const handler of …)`
 * fanout loop) must run inside a `runWithContext(…)` call, so the
 * traceId minted at ingress propagates through the entire handler
 * chain via AsyncLocalStorage. Downstream orchestration inherits that
 * scope and may create a fallback only when an adapter omitted it.
 *
 * Shrink-only: this test has NO allowlist. The only way to comply
 * is to add `runWithContext` around the dispatch loop.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

interface DispatchSite {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

/**
 * Regex patterns that match dispatch sites. ORDER MATTERS — telegram's
 * `state.handlers` is more specific than generic `handlers`.
 *
 * Comment-line filter: only physical code lines (lines not starting
 * with `//`, `*`, or `/*`) are considered.
 */
const DISPATCH_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: "telegram", re: /for\s*\(\s*const\s+handler\s+of\s+state\.handlers\s*\)/ },
  { kind: "echo", re: /for\s*\(\s*const\s+handler\s+of\s+this\.messageHandlers\s*\)/ },
  { kind: "fanout", re: /for\s*\(\s*const\s+handler\s+of\s+handlers\s*\)/ },
];

const WRAP_TOKEN = /runWithContext\s*\(/;

/** Window in lines BEFORE the dispatch line where the wrap token must appear. */
const WRAP_LOOKBEHIND = 50;

/** Excluded directory + filename patterns. */
const EXCLUDED_DIRS = new Set(["dist", "node_modules", "__tests__", "__test-helpers", "fixtures", "__snapshots__"]);
function isTestFile(name: string): boolean {
  return name.endsWith(".test.ts") || name.endsWith(".test.tsx") || name === "factories.ts";
}

/** Recursive .ts walker — same pattern as trajectory-event-types-known.test.ts. */
function walkProductionFiles(rootDir: string): string[] {
  const out: string[] = [];
  function recur(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      if (EXCLUDED_DIRS.has(name)) continue;
      if (isTestFile(name)) continue;
      const p = join(dir, name);
      let stat;
      try {
        stat = statSync(p);
      } catch {
        continue;
      }
      if (stat.isDirectory()) recur(p);
      else if (stat.isFile() && p.endsWith(".ts")) out.push(p);
    }
  }
  recur(rootDir);
  return out;
}

/** Drop comment-only lines (// , block comment markers) before matching — preserves line indices. */
function stripCommentLines(content: string): readonly string[] {
  return content.split(/\r?\n/).map((l) => {
    const trimmed = l.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      return ""; // blank out — preserves line indices
    }
    return l;
  });
}

function collectDispatchSites(files: readonly string[]): DispatchSite[] {
  const sites: DispatchSite[] = [];
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const lines = stripCommentLines(raw);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const { kind, re } of DISPATCH_PATTERNS) {
        if (re.test(line)) {
          sites.push({ file, line: i + 1, snippet: `${kind}: ${line.trim().slice(0, 100)}` });
          break;
        }
      }
    }
  }
  return sites;
}

function hasWrapWithin(content: string, dispatchLine1Indexed: number, lookbehind: number): boolean {
  const lines = stripCommentLines(content);
  const start = Math.max(0, dispatchLine1Indexed - 1 - lookbehind);
  for (let i = start; i < dispatchLine1Indexed - 1; i++) {
    if (WRAP_TOKEN.test(lines[i] ?? "")) return true;
  }
  return false;
}

function repoRelative(absPath: string): string {
  return absPath.startsWith(REPO_ROOT) ? absPath.slice(REPO_ROOT.length + 1) : absPath;
}

describe("trace-propagation -- every adapter inbound dispatch runs inside runWithContext", () => {
  const channelsRoot = resolve(REPO_ROOT, "packages/channels/src");
  const channelFiles = walkProductionFiles(channelsRoot);
  const sites = collectDispatchSites(channelFiles);

  it("walker found at least one dispatch site (sanity)", () => {
    expect(sites.length).toBeGreaterThan(0);
  });

  it("every dispatch site is wrapped in runWithContext", () => {
    const violations: DispatchSite[] = [];
    for (const s of sites) {
      const content = readFileSync(s.file, "utf8");
      if (!hasWrapWithin(content, s.line, WRAP_LOOKBEHIND)) {
        violations.push(s);
      }
    }
    expect(
      violations,
      formatViolations({
        description:
          "Trace propagation: every adapter inbound dispatch site must run inside runWithContext({ traceId, channelType }, fn) so the traceId minted at ingress propagates via AsyncLocalStorage. Adapters that bypass this lose channel→queue→agent correlation.",
        violations: violations.map((v) => ({
          file: `${repoRelative(v.file)}:${v.line}`,
          line: v.line,
          snippet: v.snippet,
        })),
        suggestedFix:
          "Wrap the dispatch loop body in runWithContext({ traceId: randomUUID(), channelType, channelId? }, () => { /* existing for-handler loop */ }). The wrap must appear within 50 lines BEFORE the dispatch loop, in the same file.",
        designRef:
          "TraceId at channel ingress",
      }),
    ).toEqual([]);
  });
});

describe("trace-propagation -- execution stages inherit the inbound context", () => {
  const businessStageFiles = [
    "packages/orchestrator/src/execution/execution-execute.ts",
    "packages/orchestrator/src/execution/execution-pipeline.ts",
    "packages/orchestrator/src/execution/execution-policy.ts",
  ];

  it("does not shadow the request context inside execution business logic", () => {
    const violations = businessStageFiles.flatMap((relativePath) => {
      const lines = stripCommentLines(readFileSync(resolve(REPO_ROOT, relativePath), "utf8"));
      return lines.flatMap((line, index) => WRAP_TOKEN.test(line)
        ? [{ file: relativePath, line: index + 1, snippet: line.trim() }]
        : []);
    });

    expect(violations).toEqual([]);
  });
});
