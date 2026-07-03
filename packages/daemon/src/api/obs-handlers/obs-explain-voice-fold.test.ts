// SPDX-License-Identifier: Apache-2.0
/**
 * `accumulateVoiceRecord` source-fallback regression tests.
 *
 * The seq-aware voice fold seeds `source` from the `media.*.requested` record and
 * must FALL BACK to that carried source when a terminal
 * `completed`/`failed` record omits `source` — mirroring the provider/keyless
 * fallback. The live emitter always passes `source` on the terminal, but the fold
 * is the offline oracle for partial/reordered on-disk records, so a source-less
 * terminal must not drop the provider-selection rung. These tests fail on the
 * pre-fix code (which read `source` ONLY from the terminal record's data).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { accumulateVoiceRecord, type VoiceFoldState } from "./obs-explain-voice-fold.js";

const INITIAL: VoiceFoldState = { signal: undefined, outcomeSeq: 0 };

describe("accumulateVoiceRecord — source fallback from the requested seed", () => {
  it("retains the requested-seeded source when the completed record omits source", () => {
    // Seed: media.stt.requested carries the resolved provider-selection rung.
    const seeded = accumulateVoiceRecord(
      INITIAL,
      "media.stt.requested",
      { provider: "local", source: "keyless-local" },
      1,
    );
    expect(seeded.signal?.source).toBe("keyless-local");

    // Terminal completed WITHOUT source (a partial/older on-disk record).
    const done = accumulateVoiceRecord(
      seeded,
      "media.stt.completed",
      { provider: "local", keyless: true, costUsd: 0 },
      2,
    );
    // The seeded source survives (pre-fix: dropped → undefined).
    expect(done.signal?.source).toBe("keyless-local");
    expect(done.signal?.outcome).toBe("ok");
    expect(done.signal?.costUsd).toBe(0); // keyless $0 still visible
  });

  it("retains the requested-seeded source when the failed record omits source", () => {
    const seeded = accumulateVoiceRecord(
      INITIAL,
      "media.tts.requested",
      { provider: "edge", source: "fallback" },
      1,
    );
    const failed = accumulateVoiceRecord(
      seeded,
      "media.tts.failed",
      { provider: "edge", errorKind: "network" },
      2,
    );
    expect(failed.signal?.source).toBe("fallback");
    expect(failed.signal?.outcome).toBe("failed");
    expect(failed.signal?.errorKind).toBe("network");
  });

  it("still prefers the terminal record's own source when present", () => {
    const seeded = accumulateVoiceRecord(
      INITIAL,
      "media.stt.requested",
      { provider: "openai", source: "follow-main-key" },
      1,
    );
    // A terminal that DOES carry source wins over the seed.
    const done = accumulateVoiceRecord(
      seeded,
      "media.stt.completed",
      { provider: "openai", keyless: false, source: "explicit" },
      2,
    );
    expect(done.signal?.source).toBe("explicit");
  });
});
