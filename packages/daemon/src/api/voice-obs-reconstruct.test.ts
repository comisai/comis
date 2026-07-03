// SPDX-License-Identifier: Apache-2.0
/**
 * Offline reconstruction test for the voice observability path (THE binding oracle).
 *
 * Drives the FROZEN `assembleIncidentReportFromSources` pipeline (the same
 * function `comis explain` runs) against an in-memory fixture trajectory
 * containing the `media.stt.*` / `media.tts.*` records the daemon voice RPC
 * handlers (`media.transcribe` / `tts.synthesize`) direct-emit — proving a VOICE
 * turn is reconstructable from observability WITHOUT a live daemon.
 * Mirrors `video-obs-reconstruct.test.ts`
 * + `vision-obs-reconstruct.test.ts` + `image-obs-reconstruct.test.ts`
 * — voice is wholly IN-TURN (no background-completion sequence like video).
 *
 * THE binding assertion: the assembler reconstructs a voice turn into a dedicated
 * additive `voice` block — provider / keyless? / model / durationMs / costUsd /
 * the resolved `source` rung / outcome. The keyless `costUsd:0` is VISIBLE on
 * the block (not absent). This is OFFLINE (no live daemon, no live recorder); we
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
const DATA_DIR = "/tmp/voice-obs-reconstruct";

/** A trajectory event record as written by the recorder (the
 *  `traceSchema: "comis-trajectory"` EVENT shape `toIncidentSignals` reads,
 *  keyed on `type` with the content-free payload under `data`). All records
 *  carry the SAME sessionKey + traceId — one voice turn stitched together. */
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
    traceId: "trace-voice-1",
    entryId: `e-${seq}`,
    data,
  };
}

/** A reader whose readSessionRecords returns the supplied trajectory records.
 *  The other three sources are empty — a voice turn carries no executor
 *  `sessionEnd` rollup (the voice RPC handlers run in the daemon
 *  context, not the executor; the cost rides the trajectory). */
function makeVoiceFixtureReader(records: Array<Record<string, unknown>>): IncidentSourceReader {
  return {
    readSessionRecords: async () => records,
    readCacheTraceRecords: async () => [],
    readSessionMetadata: async () => null,
    readDiagnosticsRollup: async () => null,
  };
}

async function assemble(records: Array<Record<string, unknown>>): Promise<IncidentReport> {
  return (await assembleIncidentReportFromSources(makeVoiceFixtureReader(records), DATA_DIR, {
    sessionKey: SESSION_KEY,
    depth: "summary",
  })) as IncidentReport;
}

describe("offline reconstruction — comis explain surfaces a voice turn", () => {
  it("keyless STT: reconstructs provider/keyless/model/durationMs/costUsd:0/source/outcome (keyless $0 visible)", async () => {
    const report = await assemble([
      trajectoryRecord(
        "media.stt.requested",
        { provider: "local", mainProvider: "openai-codex", source: "keyless-local" },
        1,
      ),
      trajectoryRecord(
        "media.stt.completed",
        { provider: "local", keyless: true, model: "base", durationMs: 1200, costUsd: 0, outcome: "ok", source: "keyless-local" },
        2,
      ),
    ]);

    // The binding bar: the voice turn is reconstructable from the
    // trajectory via a dedicated additive `voice` block.
    expect(report.voice).toBeDefined();
    expect(report.voice?.provider).toBe("local");
    expect(report.voice?.keyless).toBe(true);
    expect(report.voice?.model).toBe("base");
    expect(report.voice?.durationMs).toBe(1200);
    // Keyless records costUsd:0 EXPLICITLY — "free" is VISIBLE, not absent.
    expect(report.voice?.costUsd).toBe(0);
    // The resolved selection rung reconstructs onto the block.
    expect(report.voice?.source).toBe("keyless-local");
    expect(report.voice?.outcome).toBe("ok");
  });

  it("keyed TTS: reconstructs provider/keyless:false/outcome with NO costUsd (keyed cost omitted, no per-call source)", async () => {
    const report = await assemble([
      trajectoryRecord(
        "media.tts.requested",
        { provider: "openai", mainProvider: "openai", source: "follow-main-key" },
        1,
      ),
      trajectoryRecord(
        "media.tts.completed",
        { provider: "openai", keyless: false, model: "tts-1", durationMs: 800, outcome: "ok", source: "follow-main-key" },
        2,
      ),
    ]);

    expect(report.voice).toBeDefined();
    expect(report.voice?.provider).toBe("openai");
    expect(report.voice?.keyless).toBe(false);
    expect(report.voice?.source).toBe("follow-main-key");
    expect(report.voice?.outcome).toBe("ok");
    // A keyed path has no per-call cost source today → costUsd omitted
    // (NOT a fabricated number). The block exists; the cost is simply absent.
    expect(report.voice?.costUsd).toBeUndefined();
  });

  it("failed-turn fold: a media.tts.failed at a higher seq reconstructs outcome=failed + errorKind verbatim, no costUsd", async () => {
    const report = await assemble([
      trajectoryRecord(
        "media.tts.requested",
        { provider: "edge", mainProvider: "anthropic", source: "fallback" },
        1,
      ),
      trajectoryRecord(
        "media.tts.failed",
        { provider: "edge", errorKind: "network", outcome: "failed", source: "fallback" },
        2,
      ),
    ]);

    expect(report.voice).toBeDefined();
    expect(report.voice?.outcome).toBe("failed");
    // The domain SttErrorKind string rides the failed record verbatim.
    expect(report.voice?.errorKind).toBe("network");
    expect(report.voice?.source).toBe("fallback");
    expect(report.voice?.costUsd).toBeUndefined();
  });

  it("seq-aware fold: a STALE lower-seq requested arriving AFTER a completed does NOT overwrite the ok outcome", async () => {
    // The terminal completed lands at seq 2 (outcomeSeq=2). A stale `requested`
    // re-arrives at seq 1 (< 2). The seq-aware fold must NOT downgrade the ok
    // outcome back to the conservative requested seed (the video seq precedent).
    const report = await assemble([
      trajectoryRecord(
        "media.stt.completed",
        { provider: "local", keyless: true, model: "base", durationMs: 900, costUsd: 0, outcome: "ok", source: "keyless-local" },
        2,
      ),
      trajectoryRecord(
        "media.stt.requested",
        { provider: "local", mainProvider: "openai-codex", source: "keyless-local" },
        1,
      ),
    ]);

    expect(report.voice).toBeDefined();
    // The ok outcome survives the stale lower-seq requested (seed never wins).
    expect(report.voice?.outcome).toBe("ok");
    expect(report.voice?.costUsd).toBe(0);
  });

  it("non-regression: a session WITHOUT media.stt.*/media.tts.* records reconstructs no voice block", async () => {
    const report = await assemble([
      trajectoryRecord("tool.result", { toolName: "bash", toolCallId: "tc-1", success: true }, 1),
    ]);

    expect(report.voice).toBeUndefined();
    // The tool turn still reconstructs normally (the voice fold is additive +
    // presence-conditional — it never invents a block).
    expect(report.toolStats.bash).toBeDefined();
  });

  it("media independence: a turn with image.*, media.vision.*, video.*, AND media.stt.* reconstructs all four blocks independently", async () => {
    // The four folds must not interfere — each block is reconstructed
    // independently from its own record class (the video twin's independence test).
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
      trajectoryRecord("video.generated", { provider: "veo", model: "veo-3", costUsd: 1.2, outcome: "ok" }, 6),
      trajectoryRecord("media.stt.requested", { provider: "local", mainProvider: "openai-codex", source: "keyless-local" }, 7),
      trajectoryRecord(
        "media.stt.completed",
        { provider: "local", keyless: true, model: "base", durationMs: 1100, costUsd: 0, outcome: "ok", source: "keyless-local" },
        8,
      ),
    ]);

    expect(report.image?.provider).toBe("openai");
    expect(report.image?.costUsd).toBeCloseTo(0.04, 4);
    expect(report.vision?.provider).toBe("anthropic");
    expect(report.vision?.costUsd).toBeCloseTo(0.002, 4);
    expect(report.videoGenerated?.provider).toBe("veo");
    expect(report.videoGenerated?.costUsd).toBeCloseTo(1.2, 4);
    expect(report.voice?.provider).toBe("local");
    expect(report.voice?.keyless).toBe(true);
    expect(report.voice?.costUsd).toBe(0);
  });
});
