// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for sync-tooling/generate.ts — AST mutators (skeleton + adds + prunes).
 *
 * Snapshots use `doc.toString()` (AST stringification) per CONTEXT
 * Discretion item 3 — handles trailing-whitespace flakiness portably.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import {
  buildSkeleton,
  computeMutationPlan,
  applyToDocument,
} from "./generate.js";
import type { DiscoveredArtifacts } from "./discover.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, "__tests__", "fixtures");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIX, name), "utf-8");
}

function emptyArtifacts(): DiscoveredArtifacts {
  return { mcps: [], skills: [] };
}

function mcp(name: string): DiscoveredArtifacts["mcps"][number] {
  return { name, description: undefined };
}

function skill(
  name: string,
  description: string | undefined = undefined,
  cluster: string | undefined = undefined,
): DiscoveredArtifacts["skills"][number] {
  return { name, description, cluster, sourceDir: `/tmp/skills/${name}` };
}

describe("buildSkeleton", () => {
  it("Test 1: initializes empty doc.contents and writes the four-section skeleton", () => {
    const doc = parseDocument("");
    const artifacts: DiscoveredArtifacts = {
      mcps: [mcp("yfinance")],
      skills: [skill("alpha", "Alpha skill")],
    };
    buildSkeleton(doc, artifacts);
    const out = doc.toString();
    expect(out).toContain("tooling:");
    expect(out).toContain("capabilityClusters:");
    expect(out).toContain("clusters: {}");
    expect(out).toContain("mcp:");
    expect(out).toContain("skills:");
    expect(out).toContain("installDetours:");
    expect(out).toContain("mode: advise");
    expect(out).toContain("capabilityIndex:");
    expect(out).toContain("enabled: true");
    expect(out).toContain("yfinance:");
    expect(out).toContain("alpha:");
  });

  it("Test 2: empty mcps + empty skills emits empty maps, not missing keys", () => {
    const doc = parseDocument("");
    buildSkeleton(doc, emptyArtifacts());
    const out = doc.toString();
    // Both capabilityHints maps must be present (D-18) — even though empty.
    expect(out).toMatch(/mcp:\s*\n\s*capabilityHints:\s*\{\}/);
    expect(out).toMatch(/skills:\s*\n\s*capabilityHints:\s*\{\}/);
  });

  it("Test 3: each generated MCP hint has cluster=external-integrations, description='TODO', replacesPackages=[] with TODO commentBefore", () => {
    const doc = parseDocument("");
    buildSkeleton(doc, { mcps: [mcp("yfinance")], skills: [] });
    const out = doc.toString();
    expect(out).toContain("cluster: external-integrations");
    expect(out).toContain("description: TODO");
    expect(out).toContain("# TODO: list npm/pip packages this MCP replaces");
    expect(out).toContain("replacesPackages: []");
  });

  it("Test 4: skill hints default to cluster=prompt-skills with description fallback to TODO; explicit cluster + description preserved", () => {
    const doc = parseDocument("");
    buildSkeleton(doc, {
      mcps: [],
      skills: [
        skill("alpha", undefined, undefined),
        skill("beta", "Beta description", "custom-cluster"),
      ],
    });
    const out = doc.toString();
    // alpha: cluster=prompt-skills, description=TODO
    expect(out).toMatch(/alpha:\s*\n\s*cluster: prompt-skills\s*\n\s*description: TODO/);
    // beta: cluster=custom-cluster, description="Beta description"
    expect(out).toContain("cluster: custom-cluster");
    expect(out).toMatch(/beta:[\s\S]*description: Beta description/);
  });
});

describe("computeMutationPlan", () => {
  it("Test 5: against config-with-tooling.yaml + a NEW MCP `slack-mcp` returns mcpAdds=[slack-mcp], no removes", () => {
    const doc = parseDocument(readFixture("config-with-tooling.yaml"));
    const artifacts: DiscoveredArtifacts = {
      mcps: [mcp("yfinance"), mcp("slack-mcp")],
      skills: [],
    };
    const plan = computeMutationPlan(doc, artifacts);
    expect(plan.needsSkeleton).toBe(false);
    expect(plan.mcpAdds).toEqual(["slack-mcp"]);
    expect(plan.mcpRemoves).toEqual([]);
    expect(plan.skillAdds).toEqual([]);
    expect(plan.skillRemoves).toEqual([]);
  });
});

describe("applyToDocument — append-only preservation", () => {
  it("Test 6: adding slack-mcp leaves the yfinance entry byte-identical (description, replacesPackages, # operator note)", () => {
    const raw = readFixture("config-with-tooling.yaml");
    const doc = parseDocument(raw);
    applyToDocument(
      doc,
      { mcps: [mcp("yfinance"), mcp("slack-mcp")], skills: [] },
      { overwrite: false },
    );
    const out = doc.toString();
    // Verify the operator-customized yfinance block is intact.
    expect(out).toContain("# operator note: curated package list below");
    expect(out).toContain('description: "Yahoo Finance market prices, history, fundamentals"');
    expect(out).toContain("- yfinance");
    expect(out).toContain("- yahoo-finance2");
    // And slack-mcp was added.
    expect(out).toContain("slack-mcp:");
    expect(out).toContain("description: TODO");
  });
});

describe("applyToDocument — pruning", () => {
  it("Test 7: applyToDocument with no yfinance in discovered set prunes tooling.mcp.capabilityHints.yfinance entirely", () => {
    const doc = parseDocument(readFixture("config-with-tooling.yaml"));
    applyToDocument(doc, emptyArtifacts(), { overwrite: false });
    const out = doc.toString();
    expect(out).not.toContain("yfinance:");
    // commentBefore on the pruned key dies with the Pair (Pitfall 4).
    expect(out).not.toContain("# operator note");
  });
});

describe("applyToDocument — preservation of unrecognized keys", () => {
  it("Test 8: unrecognized operator-authored key tooling.foo is preserved verbatim (D-17)", () => {
    const raw = `tooling:\n  foo: bar\n  capabilityIndex:\n    enabled: true\n`;
    const doc = parseDocument(raw);
    applyToDocument(doc, { mcps: [mcp("zzz")], skills: [] }, { overwrite: false });
    const out = doc.toString();
    expect(out).toContain("foo: bar");
    expect(out).toContain("zzz:");
  });
});

describe("applyToDocument — overwrite mode", () => {
  it("Test 9: overwrite=true rebuilds managed sections but preserves capabilityClusters.clusters byte-for-byte (D-19)", () => {
    const raw = readFixture("config-with-tooling.yaml");
    const doc = parseDocument(raw);
    applyToDocument(
      doc,
      { mcps: [mcp("slack-mcp")], skills: [] },
      { overwrite: true },
    );
    const out = doc.toString();
    // Operator-only territory — must survive the overwrite.
    expect(out).toContain("data-fetching-financial:");
    expect(out).toContain("preferOverInstalls: true");
    // Old yfinance hint is GONE (we did not include it in the discovered set).
    expect(out).not.toContain("yfinance:");
    // New slack-mcp hint is THERE with the regenerated stub.
    expect(out).toContain("slack-mcp:");
    expect(out).toContain("description: TODO");
  });
});

describe("applyToDocument — operator-customized fields are never overwritten on existing entries", () => {
  it("Test 10: pre-mutation yfinance.description/replacesPackages stay intact when yfinance is in discovered set (D-22)", () => {
    const raw = readFixture("config-with-tooling.yaml");
    const doc = parseDocument(raw);
    // yfinance IS in the discovered set — the entry already exists and is operator-edited.
    applyToDocument(
      doc,
      { mcps: [mcp("yfinance")], skills: [] },
      { overwrite: false },
    );
    const out = doc.toString();
    // Description must NOT be reset to "TODO".
    expect(out).toContain('description: "Yahoo Finance market prices, history, fundamentals"');
    expect(out).not.toContain('description: "TODO"');
    expect(out).not.toContain("description: TODO");
    // The custom replacesPackages list survives.
    expect(out).toContain("- yahoo-finance2");
  });
});

describe("applyToDocument — comment + key-order preservation", () => {
  it("Test 11: an unchanged config (no adds, no removes) roundtrips byte-identical", () => {
    const raw = readFixture("config-with-tooling.yaml");
    const doc = parseDocument(raw);
    applyToDocument(
      doc,
      { mcps: [mcp("yfinance")], skills: [] },
      { overwrite: false },
    );
    const out = doc.toString();
    expect(out).toBe(raw);
  });
});
