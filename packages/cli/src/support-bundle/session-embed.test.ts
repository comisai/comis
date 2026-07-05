// SPDX-License-Identifier: Apache-2.0
/**
 * Hermetic tests for the `--session` / `--deep` embed engine.
 *
 * Every case INJECTS the assembler + resolver seams, so a unit run never loads
 * the @comis/daemon runtime graph the real offline seams lazy-import (the
 * injectable-seam discipline the rest of the bundle follows). The tests pin two
 * contracts: `classifySessionRef` routes a ref exactly the way `comis explain`
 * does, and `embedSession` assembles the report and (on `--deep`) resolves the
 * real session file, folding read/resolve failures into warnings without ever
 * throwing to the caller.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import type { IncidentReport } from "@comis/core";
import { classifySessionRef, embedSession } from "./session-embed.js";

/**
 * A minimal IncidentReport stand-in — `embedSession` only reads `sessionKey`
 * (on the deep path), so the object carries just enough to type-check via the
 * sanctioned `as unknown as T` test cast.
 */
function makeReport(overrides: Record<string, unknown> = {}): IncidentReport {
  return {
    schemaVersion: 1,
    sessionKey: "default:u1:c1:peer:p1",
    traceId: "ea72ef66-9497-46c2-a7bb-46f5ba92732e",
    agentId: "default",
    ...overrides,
  } as unknown as IncidentReport;
}

describe("classifySessionRef — mirrors comis explain's ref routing", () => {
  it("routes a root- prefixed ref to rootRunId (the autonomy-run disambiguator)", () => {
    expect(classifySessionRef("root-abc")).toEqual({ rootRunId: "root-abc" });
  });

  it("routes a colon-bearing ref to sessionKey", () => {
    expect(classifySessionRef("default:u1:c1:peer:p1")).toEqual({
      sessionKey: "default:u1:c1:peer:p1",
    });
  });

  it("routes a bare UUID ref (no colon) to traceId", () => {
    expect(classifySessionRef("ea72ef66-9497-46c2-a7bb-46f5ba92732e")).toEqual({
      traceId: "ea72ef66-9497-46c2-a7bb-46f5ba92732e",
    });
  });

  it("checks the root- prefix BEFORE the colon rule (a synthetic root with a colon is not a sessionKey)", () => {
    expect(classifySessionRef("root-session-default:u1:c1:peer:p1")).toEqual({
      rootRunId: "root-session-default:u1:c1:peer:p1",
    });
  });
});

describe("embedSession — assemble the report and (on deep) resolve the session file, hermetically", () => {
  it("returns the assembled report with no deepSessionFile when deep is false", async () => {
    const report = makeReport();
    const result = await embedSession({
      ref: "default:u1:c1:peer:p1",
      deep: false,
      dataDir: "/tmp/data",
      assembleIncident: async () => report,
      resolveSessionFile: async () => {
        throw new Error("resolveSessionFile must not be called when deep is false");
      },
    });

    expect(result.explain).toBe(report);
    expect(result.deepSessionFile).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("passes the classified ref plus depth to the assembler seam", async () => {
    let captured: unknown;
    const report = makeReport();
    await embedSession({
      ref: "root-abc",
      deep: false,
      dataDir: "/tmp/data",
      depth: "full",
      assembleIncident: async (_dataDir, params) => {
        captured = params;
        return report;
      },
    });

    expect(captured).toEqual({ rootRunId: "root-abc", depth: "full" });
  });

  it("resolves the deep session file via the seam, reusing the report's resolved sessionKey", async () => {
    const report = makeReport(); // sessionKey "default:u1:c1:peer:p1"
    let resolveArgs: [string, string] | undefined;
    const result = await embedSession({
      ref: "ea72ef66-9497-46c2-a7bb-46f5ba92732e", // a traceId ref, NOT the sessionKey
      deep: true,
      dataDir: "/tmp/data",
      assembleIncident: async () => report,
      resolveSessionFile: async (dataDir, sessionKey) => {
        resolveArgs = [dataDir, sessionKey];
        return "/real/x.jsonl";
      },
    });

    expect(result.explain).toBe(report);
    expect(result.deepSessionFile).toBe("/real/x.jsonl");
    expect(result.warnings).toEqual([]);
    // The seam is fed the report's RESOLVED sessionKey, not the raw traceId ref.
    expect(resolveArgs).toEqual(["/tmp/data", "default:u1:c1:peer:p1"]);
  });

  it("folds an assembler throw into an explain warning and never throws", async () => {
    const result = await embedSession({
      ref: "default:u1:c1:peer:p1",
      deep: true,
      dataDir: "/tmp/data",
      assembleIncident: async () => {
        throw new Error("reader boom");
      },
      resolveSessionFile: async () => {
        throw new Error("resolve must not run after an explain failure");
      },
    });

    expect(result.explain).toBeUndefined();
    expect(result.deepSessionFile).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.source).toBe("explain");
    expect(result.warnings[0]!.message).toContain("reader boom");
  });

  it("folds an unresolved deep session file into a trace-export warning, keeping the explain", async () => {
    const report = makeReport();
    const result = await embedSession({
      ref: "default:u1:c1:peer:p1",
      deep: true,
      dataDir: "/tmp/data",
      assembleIncident: async () => report,
      resolveSessionFile: async () => undefined,
    });

    expect(result.explain).toBe(report);
    expect(result.deepSessionFile).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.source).toBe("trace-export");
  });
});
