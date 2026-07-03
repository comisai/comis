// SPDX-License-Identifier: Apache-2.0
/**
 * `accumulateVideoRecord` seq-aware fold unit tests.
 *
 * The pure video-turn fold (the `accumulateVisionRecord` twin) that
 * `applyMediaRecord` dispatches `video.*` records to. Mirrors the vision fold's
 * unit coverage: the terminal `video.generated` success carries provider / model
 * / costUsd / durationSecs (the cost rides the terminal record), a
 * later `video.delivered` flips the `delivered` latch without clobbering the
 * terminal success, an EARLIER (lower-seq) record never overwrites a higher-seq
 * terminal (seq-aware), `video.failed` is the terminal failure (provider +
 * errorKind, no costUsd), and `video.submitted` carries `jobId` onto the block.
 *
 * Content-free by construction (ids/labels/numbers only — no prompt, no bytes,
 * no provider message).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  accumulateVideoRecord,
  applyMediaRecord,
  type MediaFoldSlice,
  type VideoFoldState,
} from "./obs-explain-signals-fields.js";

/** The empty fold seed (no signal; outcomeSeq -1 so the first real terminal at
 *  seq ≥ 0 always sets outcome — the toIncidentSignals convention). */
function seed(): VideoFoldState {
  return { signal: undefined, outcomeSeq: -1 };
}

describe("accumulateVideoRecord — the seq-aware video-turn fold", () => {
  it("video.generated is the terminal success carrying provider/model/costUsd/durationSecs", () => {
    const folded = accumulateVideoRecord(
      seed(),
      "video.generated",
      { provider: "veo", model: "veo-3", costUsd: 1.2, sizeBytes: 9, durationSecs: 8, outcome: "ok" },
      3,
    );
    expect(folded.outcomeSeq).toBe(3);
    expect(folded.signal).toBeDefined();
    expect(folded.signal?.provider).toBe("veo");
    expect(folded.signal?.outcome).toBe("ok");
    expect(folded.signal?.model).toBe("veo-3");
    expect(folded.signal?.costUsd).toBeCloseTo(1.2, 4);
    expect(folded.signal?.durationSecs).toBe(8);
    // delivered defaults to false until a video.delivered record arrives.
    expect(folded.signal?.delivered).toBe(false);
    // sizeBytes is NOT on the report block (only durationSecs/cost/model ride it).
    expect((folded.signal as Record<string, unknown>).sizeBytes).toBeUndefined();
  });

  it("a LATER video.delivered flips delivered:true without clobbering the terminal success", () => {
    const afterGenerated = accumulateVideoRecord(
      seed(),
      "video.generated",
      { provider: "veo", model: "veo-3", costUsd: 1.2, outcome: "ok" },
      3,
    );
    const afterDelivered = accumulateVideoRecord(afterGenerated, "video.delivered", { channelType: "telegram", delivered: true }, 4);
    expect(afterDelivered.signal?.delivered).toBe(true);
    // The terminal success is preserved (outcome/cost untouched by the latch).
    expect(afterDelivered.signal?.outcome).toBe("ok");
    expect(afterDelivered.signal?.costUsd).toBeCloseTo(1.2, 4);
    // The delivered latch does not advance outcomeSeq (it is not a terminal).
    expect(afterDelivered.outcomeSeq).toBe(3);
  });

  it("an EARLIER (lower-seq) video.requested never overwrites a higher-seq terminal", () => {
    const afterGenerated = accumulateVideoRecord(
      seed(),
      "video.generated",
      { provider: "veo", model: "veo-3", costUsd: 1.2, outcome: "ok" },
      3,
    );
    // A stale, lower-seq request arriving after the seq-3 terminal must not
    // flip the delivered success back to the conservative seed.
    const afterStaleRequest = accumulateVideoRecord(afterGenerated, "video.requested", { provider: "veo", mainProvider: "google" }, 1);
    expect(afterStaleRequest.signal?.outcome).toBe("ok");
    expect(afterStaleRequest.signal?.costUsd).toBeCloseTo(1.2, 4);
    expect(afterStaleRequest.outcomeSeq).toBe(3);
  });

  it("video.failed at the terminal seq → outcome=failed + errorKind, no costUsd", () => {
    const folded = accumulateVideoRecord(
      seed(),
      "video.failed",
      { provider: "veo", errorKind: "job_timeout" },
      3,
    );
    expect(folded.signal?.provider).toBe("veo");
    expect(folded.signal?.outcome).toBe("failed");
    expect(folded.signal?.errorKind).toBe("job_timeout");
    expect(folded.signal?.costUsd).toBeUndefined();
    expect(folded.outcomeSeq).toBe(3);
  });

  it("video.submitted carries jobId onto the conservative seed block", () => {
    const folded = accumulateVideoRecord(seed(), "video.submitted", { provider: "veo", jobId: "job-x" }, 2);
    expect(folded.signal).toBeDefined();
    expect(folded.signal?.provider).toBe("veo");
    expect(folded.signal?.jobId).toBe("job-x");
    // No terminal yet — the seed is conservative (outcome:"failed" until a
    // generated/failed arrives) and does not advance outcomeSeq.
    expect(folded.signal?.outcome).toBe("failed");
    expect(folded.outcomeSeq).toBe(-1);
  });

  it("video.requested seeds a conservative block and does not advance outcomeSeq", () => {
    const folded = accumulateVideoRecord(seed(), "video.requested", { provider: "veo", mainProvider: "google" }, 1);
    expect(folded.signal?.provider).toBe("veo");
    expect(folded.signal?.outcome).toBe("failed");
    expect(folded.outcomeSeq).toBe(-1);
  });

  it("a non-video type returns the prior state unchanged", () => {
    const prev = accumulateVideoRecord(seed(), "video.submitted", { provider: "veo", jobId: "job-x" }, 2);
    const after = accumulateVideoRecord(prev, "image.generated", { provider: "openai", outcome: "ok" }, 5);
    expect(after).toBe(prev);
  });
});

describe("applyMediaRecord — dispatches video.* into the MediaFoldSlice", () => {
  function makeSlice(): MediaFoldSlice {
    return { imageOutcomeSeq: -1, visionOutcomeSeq: -1, videoOutcomeSeq: -1, seq: 0 };
  }

  it("folds a video.generated into slice.video and returns true", () => {
    const slice = makeSlice();
    const handled = applyMediaRecord(slice, "video.generated", { provider: "veo", model: "veo-3", costUsd: 1.2, outcome: "ok" }, 3);
    expect(handled).toBe(true);
    expect(slice.video).toBeDefined();
    expect(slice.video?.provider).toBe("veo");
    expect(slice.video?.outcome).toBe("ok");
    expect(slice.videoOutcomeSeq).toBe(3);
  });

  it("a non-media type returns false and leaves slice.video undefined", () => {
    const slice = makeSlice();
    const handled = applyMediaRecord(slice, "tool.result", { toolName: "bash" }, 1);
    expect(handled).toBe(false);
    expect(slice.video).toBeUndefined();
  });
});
