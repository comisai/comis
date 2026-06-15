// SPDX-License-Identifier: Apache-2.0
/**
 * OBS-03 / OBS-04 offline reconstruction test (Phase 186, the OBS-03 binding bar).
 *
 * Drives the FROZEN `assembleIncidentReportFromSources` pipeline (the same
 * function `comis explain` runs) against an in-memory fixture trajectory
 * containing the 4 image.* records the daemon handler direct-emits — proving
 * an image turn is reconstructable from observability WITHOUT a live daemon
 * (CLAUDE.md: live `comis explain` = operator-UAT).
 *
 * The binding assertion is "comis explain shows costUsd": the assembled report
 * surfaces the image turn's provider / model / costUsd / outcome reconstructed
 * from the `image.generated` trajectory record (OBS-03 Route a). This is the
 * trajectory reconstruction, NOT a hard `IncidentReport.cost.costUsd ===`
 * (that reads the executor-emitted `sessionEnd`, a DIFFERENT code path —
 * Pitfall 2 / 186-RESEARCH Open Q1).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import type { IncidentReport } from "@comis/core";
import { assembleIncidentReportFromSources } from "./obs-handlers/obs-explain.js";
import type { IncidentSourceReader } from "./obs-handlers/obs-explain-readers.js";

const SESSION_KEY = "default:u1:telegram:c1";
const DATA_DIR = "/tmp/image-obs-reconstruct";

/**
 * A trajectory event record as written by the recorder (the
 * `traceSchema: "comis-trajectory"` EVENT shape `toIncidentSignals` reads,
 * keyed on `type` with the content-free payload under `data`).
 */
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
    traceId: "trace-img-1",
    entryId: `e-${seq}`,
    data,
  };
}

/** A reader whose readSessionRecords returns the supplied trajectory records
 *  (the obs-explain.test.ts makeFixtureReader seam). The other three sources are
 *  empty — an image turn carries no executor `sessionEnd` rollup (Pitfall 2). */
function makeImageFixtureReader(records: Array<Record<string, unknown>>): IncidentSourceReader {
  return {
    readSessionRecords: async () => records,
    readCacheTraceRecords: async () => [],
    readSessionMetadata: async () => null,
    readDiagnosticsRollup: async () => null,
  };
}

/** The 4 image.* records a successful, delivered image turn writes (the content-
 *  free payloads the translator / handler emit). image.generated carries costUsd. */
function imageTurnRecords(): Array<Record<string, unknown>> {
  return [
    trajectoryRecord("image.requested", { provider: "openai", mainProvider: "openai" }, 1),
    trajectoryRecord(
      "image.generated",
      { provider: "openai", model: "gpt-image-1", costUsd: 0.04, sizeBytes: 4242, outcome: "ok" },
      2,
    ),
    trajectoryRecord("image.delivered", { channelType: "telegram", delivered: true }, 3),
  ];
}

describe("OBS-03 offline reconstruction — comis explain surfaces an image turn's costUsd", () => {
  it("assembleIncidentReportFromSources reconstructs provider/model/costUsd/outcome from image.generated", async () => {
    const reader = makeImageFixtureReader(imageTurnRecords());

    const report = (await assembleIncidentReportFromSources(reader, DATA_DIR, {
      sessionKey: SESSION_KEY,
      depth: "summary",
    })) as IncidentReport;

    // The OBS-03 binding bar: the image turn's cost is reconstructable from the
    // trajectory (Route a). The report surfaces a dedicated `image` block built
    // from the image.generated record (mirrors the RECALL-01 `recall` block —
    // NOT the executor-only cost.costUsd, Pitfall 2).
    expect(report.image).toBeDefined();
    expect(report.image?.provider).toBe("openai");
    expect(report.image?.model).toBe("gpt-image-1");
    expect(report.image?.costUsd).toBeCloseTo(0.04, 4);
    expect(report.image?.outcome).toBe("ok");
  });

  it("a failed image turn reconstructs outcome=failed + errorKind (no costUsd)", async () => {
    const reader = makeImageFixtureReader([
      trajectoryRecord("image.requested", { provider: "openai", mainProvider: "openai" }, 1),
      trajectoryRecord("image.failed", { errorKind: "content_blocked", provider: "openai" }, 2),
    ]);

    const report = (await assembleIncidentReportFromSources(reader, DATA_DIR, {
      sessionKey: SESSION_KEY,
      depth: "summary",
    })) as IncidentReport;

    expect(report.image).toBeDefined();
    expect(report.image?.outcome).toBe("failed");
    expect(report.image?.errorKind).toBe("content_blocked");
    expect(report.image?.costUsd).toBeUndefined();
  });

  it("WR-02: a persist-failure-but-delivered turn reconstructs outcome=ok with costUsd (not failed)", async () => {
    // The handler emits image.generated{outcome:ok, persisted:false, costUsd} on
    // the persist-failure-but-base64-delivered path (WR-02). `comis explain` must
    // reconstruct that turn as a charged, delivered success — NOT outcome:failed
    // (the accounting-truth bar: cost-limiter charged, billing billed, obs ok).
    const reader = makeImageFixtureReader([
      trajectoryRecord("image.requested", { provider: "openai", mainProvider: "openai" }, 1),
      trajectoryRecord(
        "image.generated",
        { provider: "openai", model: "gpt-image-1", costUsd: 0.04, sizeBytes: 4242, outcome: "ok", persisted: false },
        2,
      ),
    ]);

    const report = (await assembleIncidentReportFromSources(reader, DATA_DIR, {
      sessionKey: SESSION_KEY,
      depth: "summary",
    })) as IncidentReport;

    expect(report.image).toBeDefined();
    expect(report.image?.outcome).toBe("ok");
    expect(report.image?.costUsd).toBeCloseTo(0.04, 4);
    expect(report.image?.errorKind).toBeUndefined();
  });

  it("IN-04: out-of-order image records fold by seq — a lower-seq failed does not flip a higher-seq generated", async () => {
    // The fold previously relied on ARRAY (file) order: an image.failed appearing
    // AFTER image.generated in the array unconditionally flipped outcome to
    // "failed". IN-04 makes the fold seq-aware so only a record with a HIGHER seq
    // can overwrite the terminal outcome. Here the array order is reversed vs the
    // lifecycle seq: the terminal image.generated (seq 3, the real outcome)
    // precedes an earlier transient image.failed (seq 2) in the record array.
    const reader = makeImageFixtureReader([
      trajectoryRecord("image.requested", { provider: "openai", mainProvider: "openai" }, 1),
      // Deliberately out of array order: the higher-seq terminal success first…
      trajectoryRecord(
        "image.generated",
        { provider: "openai", model: "gpt-image-1", costUsd: 0.04, sizeBytes: 4242, outcome: "ok", persisted: true },
        3,
      ),
      // …then a LOWER-seq failed that must NOT overwrite the seq-3 outcome.
      trajectoryRecord("image.failed", { errorKind: "content_blocked", provider: "openai" }, 2),
    ]);

    const report = (await assembleIncidentReportFromSources(reader, DATA_DIR, {
      sessionKey: SESSION_KEY,
      depth: "summary",
    })) as IncidentReport;

    expect(report.image).toBeDefined();
    // The seq-3 terminal success wins over the seq-2 failed (seq-aware fold).
    expect(report.image?.outcome).toBe("ok");
    expect(report.image?.costUsd).toBeCloseTo(0.04, 4);
  });

  it("non-regression: a session WITHOUT image records reconstructs no image block", async () => {
    // A plain tool turn — no image.* records. The report must NOT invent an
    // image block (additive, presence-conditional like recall).
    const reader = makeImageFixtureReader([
      trajectoryRecord("tool.result", { toolName: "bash", toolCallId: "tc-1", success: true }, 1),
    ]);

    const report = (await assembleIncidentReportFromSources(reader, DATA_DIR, {
      sessionKey: SESSION_KEY,
      depth: "summary",
    })) as IncidentReport;

    expect(report.image).toBeUndefined();
    // The tool turn still reconstructs normally.
    expect(report.toolStats.bash).toBeDefined();
  });
});
