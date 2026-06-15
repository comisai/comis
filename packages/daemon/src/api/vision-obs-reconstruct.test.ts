// SPDX-License-Identifier: Apache-2.0
/**
 * VIS-04 offline reconstruction test (Phase 187, the VIS-04 binding bar).
 *
 * Drives the FROZEN `assembleIncidentReportFromSources` pipeline (the same
 * function `comis explain` runs) against an in-memory fixture trajectory
 * containing the `media.vision.*` records the daemon vision handler direct-emits
 * — proving a VISION turn is reconstructable from observability WITHOUT a live
 * daemon (CLAUDE.md: live `comis explain` = operator-UAT). Mirrors
 * `image-obs-reconstruct.test.ts` (186-03) exactly.
 *
 * The binding assertion is "comis explain shows the vision turn": the assembled
 * report surfaces the turn's provider / mainProvider / model / path / costUsd /
 * outcome reconstructed from the `media.vision.completed` trajectory record
 * (VIS-04 Route a — the cost rides the trajectory, NOT the executor `sessionEnd`
 * cost.costUsd, Pitfall 2). An additive `IncidentReport.vision` block (mirroring
 * `IncidentReport.image`).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import type { IncidentReport } from "@comis/core";
import { assembleIncidentReportFromSources } from "./obs-handlers/obs-explain.js";
import type { IncidentSourceReader } from "./obs-handlers/obs-explain-readers.js";

const SESSION_KEY = "default:u1:telegram:c1";
const DATA_DIR = "/tmp/vision-obs-reconstruct";

/** A trajectory event record as written by the recorder (the
 *  `traceSchema: "comis-trajectory"` EVENT shape `toIncidentSignals` reads,
 *  keyed on `type` with the content-free payload under `data`). */
function trajectoryRecord(
  type: string,
  data: Record<string, unknown>,
  seq: number,
): Record<string, unknown> {
  return {
    traceSchema: "comis-trajectory",
    schemaVersion: 1,
    source: "runtime",
    type,
    ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    seq,
    agentId: "default",
    sessionId: SESSION_KEY,
    sessionKey: SESSION_KEY,
    traceId: "trace-vis-1",
    entryId: `e-${seq}`,
    data,
  };
}

/** A reader whose readSessionRecords returns the supplied trajectory records.
 *  The other three sources are empty — a vision turn carries no executor
 *  `sessionEnd` rollup (Pitfall 2). */
function makeVisionFixtureReader(records: Array<Record<string, unknown>>): IncidentSourceReader {
  return {
    readSessionRecords: async () => records,
    readCacheTraceRecords: async () => [],
    readSessionMetadata: async () => null,
    readDiagnosticsRollup: async () => null,
  };
}

async function assemble(records: Array<Record<string, unknown>>): Promise<IncidentReport> {
  return (await assembleIncidentReportFromSources(makeVisionFixtureReader(records), DATA_DIR, {
    sessionKey: SESSION_KEY,
    depth: "summary",
  })) as IncidentReport;
}

describe("VIS-04 offline reconstruction — comis explain surfaces a vision turn", () => {
  it("reconstructs provider/mainProvider/model/path/costUsd/outcome from media.vision.completed (main-vision)", async () => {
    const report = await assemble([
      trajectoryRecord("media.vision.requested", { provider: "anthropic", mainProvider: "anthropic" }, 1),
      trajectoryRecord(
        "media.vision.completed",
        { provider: "anthropic", mainProvider: "anthropic", model: "claude-x", costUsd: 0.002, path: "main-vision", outcome: "ok" },
        2,
      ),
    ]);

    // The VIS-04 binding bar: the vision turn is reconstructable from the
    // trajectory (Route a) via a dedicated additive `vision` block (mirrors the
    // image block — NOT cost.costUsd, Pitfall 2).
    expect(report.vision).toBeDefined();
    expect(report.vision?.provider).toBe("anthropic");
    expect(report.vision?.mainProvider).toBe("anthropic");
    expect(report.vision?.model).toBe("claude-x");
    expect(report.vision?.costUsd).toBeCloseTo(0.002, 4);
    expect(report.vision?.path).toBe("main-vision");
    expect(report.vision?.outcome).toBe("ok");
  });

  it("a failed vision turn reconstructs outcome=failed + errorKind", async () => {
    const report = await assemble([
      trajectoryRecord("media.vision.requested", { provider: "anthropic", mainProvider: "anthropic" }, 1),
      trajectoryRecord("media.vision.failed", { errorKind: "empty_response", path: "main-vision", provider: "anthropic", mainProvider: "anthropic" }, 2),
    ]);

    expect(report.vision).toBeDefined();
    expect(report.vision?.outcome).toBe("failed");
    expect(report.vision?.errorKind).toBe("empty_response");
    expect(report.vision?.path).toBe("main-vision");
  });

  it("the registry tier (no cost) reconstructs outcome=ok, path=registry, NO costUsd", async () => {
    const report = await assemble([
      trajectoryRecord("media.vision.requested", { provider: "gemini", mainProvider: "anthropic" }, 1),
      trajectoryRecord(
        "media.vision.completed",
        { provider: "gemini", mainProvider: "anthropic", model: "gemini-pro-vision", path: "registry", outcome: "ok" },
        2,
      ),
    ]);

    expect(report.vision).toBeDefined();
    expect(report.vision?.outcome).toBe("ok");
    expect(report.vision?.path).toBe("registry");
    // No costUsd on the registry tier (Pitfall 4) — absent, not 0 / not a crash.
    expect(report.vision?.costUsd).toBeUndefined();
  });

  it("seq-aware: a stale lower-seq failed does NOT flip a higher-seq completed", async () => {
    // The fold must be seq-aware (mirror accumulateImageRecord IN-04): a
    // media.vision.failed appearing AFTER (in array order) a higher-seq
    // media.vision.completed must NOT overwrite the ok outcome.
    const report = await assemble([
      trajectoryRecord("media.vision.requested", { provider: "anthropic", mainProvider: "anthropic" }, 1),
      // Higher-seq terminal success first…
      trajectoryRecord(
        "media.vision.completed",
        { provider: "anthropic", mainProvider: "anthropic", model: "claude-x", costUsd: 0.002, path: "main-vision", outcome: "ok" },
        3,
      ),
      // …then a LOWER-seq failed that must NOT overwrite the seq-3 outcome.
      trajectoryRecord("media.vision.failed", { errorKind: "empty_response", path: "main-vision", provider: "anthropic", mainProvider: "anthropic" }, 2),
    ]);

    expect(report.vision).toBeDefined();
    expect(report.vision?.outcome).toBe("ok");
    expect(report.vision?.costUsd).toBeCloseTo(0.002, 4);
  });

  it("non-regression: a session WITHOUT media.vision.* records reconstructs no vision block", async () => {
    const report = await assemble([
      trajectoryRecord("tool.result", { toolName: "bash", toolCallId: "tc-1", success: true }, 1),
    ]);

    expect(report.vision).toBeUndefined();
    // The tool turn still reconstructs normally.
    expect(report.toolStats.bash).toBeDefined();
  });

  it("image + vision independence: a turn with BOTH image.* and media.vision.* reconstructs both blocks", async () => {
    // The two folds must not interfere — both report.image AND report.vision are
    // reconstructed independently from their own record classes.
    const report = await assemble([
      trajectoryRecord("image.requested", { provider: "openai", mainProvider: "openai" }, 1),
      trajectoryRecord("image.generated", { provider: "openai", model: "gpt-image-1", costUsd: 0.04, outcome: "ok" }, 2),
      trajectoryRecord("media.vision.requested", { provider: "anthropic", mainProvider: "anthropic" }, 3),
      trajectoryRecord(
        "media.vision.completed",
        { provider: "anthropic", mainProvider: "anthropic", model: "claude-x", costUsd: 0.002, path: "main-vision", outcome: "ok" },
        4,
      ),
    ]);

    expect(report.image).toBeDefined();
    expect(report.image?.provider).toBe("openai");
    expect(report.image?.costUsd).toBeCloseTo(0.04, 4);

    expect(report.vision).toBeDefined();
    expect(report.vision?.provider).toBe("anthropic");
    expect(report.vision?.costUsd).toBeCloseTo(0.002, 4);
    expect(report.vision?.path).toBe("main-vision");
  });
});
