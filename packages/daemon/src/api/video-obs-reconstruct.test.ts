// SPDX-License-Identifier: Apache-2.0
/**
 * Video offline reconstruction test (THE binding reconstruction oracle).
 *
 * Drives the FROZEN `assembleIncidentReportFromSources` pipeline (the same
 * function `comis explain` runs) against an in-memory fixture trajectory
 * containing the `video.*` records the daemon handler (in-turn) + background
 * poller (off-turn) direct-emit — proving a VIDEO turn is reconstructable from
 * observability WITHOUT a live daemon (CLAUDE.md: live `comis explain` =
 * operator-UAT). Mirrors `vision-obs-reconstruct.test.ts` +
 * `image-obs-reconstruct.test.ts` — with the KEY DIFFERENCE the image/
 * vision twins lack: a BACKGROUND-COMPLETION sequence.
 *
 * THE binding assertion: the assembler reconstructs a video turn —
 * INCLUDING a job that completed in the off-turn background poller AFTER the
 * originating turn ended. The in-turn `video.requested`/`video.submitted`
 * records reach the persisted trajectory while the recorder is alive (low seq);
 * the off-turn `video.generated`/`video.delivered` arrive at a much HIGHER seq
 * (the turn ended between them). The offline assembler stitches the later
 * completion to its submit via the SAME `sessionKey`/`traceId`/`jobId` on one
 * session — reconstructing `videoGenerated.{provider, jobId, cost, outcome,
 * delivered}` from disk. This is OFFLINE (no live daemon, no live recorder); we
 * do NOT assert `recorder.recordEvent` was called (that couples to the
 * best-effort live emit, which is NOT the binding contract).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import type { IncidentReport } from "@comis/core";
import { assembleIncidentReportFromSources } from "./obs-handlers/obs-explain.js";
import type { IncidentSourceReader } from "./obs-handlers/obs-explain-readers.js";

const SESSION_KEY = "default:u1:telegram:c1";
const DATA_DIR = "/tmp/video-obs-reconstruct";

/** A trajectory event record as written by the recorder (the
 *  `traceSchema: "comis-trajectory"` EVENT shape `toIncidentSignals` reads,
 *  keyed on `type` with the content-free payload under `data`). All records
 *  carry the SAME sessionKey + traceId — the in-turn submit and the off-turn
 *  completion belong to one session (the background-completion stitch). */
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
    traceId: "trace-vid-1",
    entryId: `e-${seq}`,
    data,
  };
}

/** A reader whose readSessionRecords returns the supplied trajectory records.
 *  The other three sources are empty — a video turn carries no executor
 *  `sessionEnd` rollup (the video RPC + poller run in the daemon
 *  context, not the executor). */
function makeVideoFixtureReader(records: Array<Record<string, unknown>>): IncidentSourceReader {
  return {
    readSessionRecords: async () => records,
    readCacheTraceRecords: async () => [],
    readSessionMetadata: async () => null,
    readDiagnosticsRollup: async () => null,
  };
}

async function assemble(records: Array<Record<string, unknown>>): Promise<IncidentReport> {
  return (await assembleIncidentReportFromSources(makeVideoFixtureReader(records), DATA_DIR, {
    sessionKey: SESSION_KEY,
    depth: "summary",
  })) as IncidentReport;
}

describe("video offline reconstruction — comis explain surfaces a video turn", () => {
  it("in-turn-only success: reconstructs provider/jobId/costUsd/outcome/delivered from a fully in-turn sequence", async () => {
    const report = await assemble([
      trajectoryRecord("video.requested", { provider: "veo", mainProvider: "google" }, 1),
      trajectoryRecord("video.submitted", { provider: "veo", jobId: "job-fast" }, 2),
      trajectoryRecord(
        "video.generated",
        { provider: "veo", model: "veo-3", costUsd: 1.2, sizeBytes: 9, durationSecs: 8, outcome: "ok" },
        3,
      ),
      trajectoryRecord("video.delivered", { channelType: "telegram", delivered: true }, 4),
    ]);

    // The binding bar: the video turn is reconstructable from the
    // trajectory alone via a dedicated additive `videoGenerated` block.
    expect(report.videoGenerated).toBeDefined();
    expect(report.videoGenerated?.provider).toBe("veo");
    expect(report.videoGenerated?.jobId).toBe("job-fast");
    expect(report.videoGenerated?.costUsd).toBeCloseTo(1.2, 4);
    expect(report.videoGenerated?.durationSecs).toBe(8);
    expect(report.videoGenerated?.outcome).toBe("ok");
    expect(report.videoGenerated?.delivered).toBe(true);
  });

  it("BACKGROUND-COMPLETION: submit on-turn (low seq) + completion off-turn (high seq) stitched by jobId/traceId on one sessionKey", async () => {
    // The submit records are written IN-TURN (recorder alive) at seq 1-2; the
    // turn then ENDS; the background poller completes the render OFF-TURN and the
    // generated/delivered records arrive at a much HIGHER seq range (10-11). The
    // offline assembler reads them all under ONE sessionKey + traceId and ties
    // the later completion to the submit via the carried jobId — proving the
    // reconstruction works even though the completion happened after the turn.
    const report = await assemble([
      // ---- IN-TURN (recorder alive) ----
      trajectoryRecord("video.requested", { provider: "veo", mainProvider: "google" }, 1),
      trajectoryRecord("video.submitted", { provider: "veo", jobId: "job-x" }, 2),
      // ===== TURN ENDS HERE (the recorder may close); seq jumps =====
      // ---- OFF-TURN (background poller, fresh context, NO ALS frame) ----
      trajectoryRecord(
        "video.generated",
        { provider: "veo", model: "veo-3", estimatedCostUsd: 0.9, durationSecs: 8, outcome: "ok" },
        10,
      ),
      trajectoryRecord("video.delivered", { channelType: "telegram", delivered: true }, 11),
    ]);

    expect(report.videoGenerated).toBeDefined();
    expect(report.videoGenerated?.provider).toBe("veo");
    // The jobId carried in-turn (seq 2) survives onto the terminal off-turn
    // record (seq 10) — this is the stitch that ties the later completion back.
    expect(report.videoGenerated?.jobId).toBe("job-x");
    // FAL/Veo carry the estimate (no per-call actual) — estimatedCostUsd rides
    // the block (the fold falls back to the estimate). The block has a cost either way.
    expect(report.videoGenerated?.estimatedCostUsd).toBeCloseTo(0.9, 4);
    expect(report.videoGenerated?.outcome).toBe("ok");
    expect(report.videoGenerated?.delivered).toBe(true);
  });

  it("failed off-turn: a video.failed at a high seq reconstructs outcome=failed + errorKind, no costUsd", async () => {
    const report = await assemble([
      trajectoryRecord("video.requested", { provider: "veo", mainProvider: "google" }, 1),
      trajectoryRecord("video.submitted", { provider: "veo", jobId: "job-slow" }, 2),
      // ===== TURN ENDS; the poller times the job out off-turn =====
      trajectoryRecord("video.failed", { provider: "veo", errorKind: "job_timeout" }, 10),
    ]);

    expect(report.videoGenerated).toBeDefined();
    expect(report.videoGenerated?.outcome).toBe("failed");
    expect(report.videoGenerated?.errorKind).toBe("job_timeout");
    expect(report.videoGenerated?.costUsd).toBeUndefined();
    // The jobId still stitches the off-turn failure back to its submit.
    expect(report.videoGenerated?.jobId).toBe("job-slow");
  });

  it("non-regression: a session WITHOUT video.* records reconstructs no videoGenerated block", async () => {
    const report = await assemble([
      trajectoryRecord("tool.result", { toolName: "bash", toolCallId: "tc-1", success: true }, 1),
    ]);

    expect(report.videoGenerated).toBeUndefined();
    // The tool turn still reconstructs normally (the video fold is additive +
    // presence-conditional — it never invents a block).
    expect(report.toolStats.bash).toBeDefined();
  });

  it("media independence: a turn with image.*, media.vision.*, AND video.* reconstructs all three blocks", async () => {
    // The three folds must not interfere — each block is reconstructed
    // independently from its own record class.
    const report = await assemble([
      trajectoryRecord("image.requested", { provider: "openai", mainProvider: "openai" }, 1),
      trajectoryRecord("image.generated", { provider: "openai", model: "gpt-image-1", costUsd: 0.04, outcome: "ok" }, 2),
      trajectoryRecord("media.vision.requested", { provider: "anthropic", mainProvider: "anthropic" }, 3),
      trajectoryRecord(
        "media.vision.completed",
        { provider: "anthropic", mainProvider: "anthropic", model: "claude-x", costUsd: 0.002, path: "main-vision", outcome: "ok" },
        4,
      ),
      trajectoryRecord("video.requested", { provider: "veo", mainProvider: "google" }, 5),
      trajectoryRecord("video.submitted", { provider: "veo", jobId: "job-both" }, 6),
      trajectoryRecord("video.generated", { provider: "veo", model: "veo-3", costUsd: 1.2, outcome: "ok" }, 7),
    ]);

    expect(report.image?.provider).toBe("openai");
    expect(report.image?.costUsd).toBeCloseTo(0.04, 4);
    expect(report.vision?.provider).toBe("anthropic");
    expect(report.vision?.costUsd).toBeCloseTo(0.002, 4);
    expect(report.videoGenerated?.provider).toBe("veo");
    expect(report.videoGenerated?.jobId).toBe("job-both");
    expect(report.videoGenerated?.costUsd).toBeCloseTo(1.2, 4);
  });
});
