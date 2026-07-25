// SPDX-License-Identifier: Apache-2.0
/**
 * MEDIA-01 — voice round-trip certification.
 *
 * The load-bearing Stage-B behavior is keyless and deterministic:
 * `executeVoiceResponse` (from @comis/channels) is a pure pipeline over injected
 * structural deps. Feeding it a fake ttsAdapter (returns a non-OGG mime, like
 * Edge's mp3) + `audioConverter: undefined` reproduces the sandbox's ffmpeg-absent
 * reality and asserts the exact WARN hint/errorKind an operator sees — NO daemon,
 * NO network, NO key. This is observability-as-oracle at the function boundary.
 *
 * Stage-A (always runs): shouldAutoTts decision table + STT_TTS_COMBOS constants.
 * Stage-B (always runs, no daemon): drives the REAL executeVoiceResponse with
 *   structural fakes — ffmpeg-absent ⇒ TEXT fallback (voiceSent:false, NOT a throw,
 *   NOT a skip) + the verbatim "Install ffmpeg…" WARN; TTS-failure fallback;
 *   autoMode off/inbound decisions through the pipeline.
 * Stage-C (it.skip, COMIS_LIVE + keys + ffmpeg): real audio→STT→LLM→TTS→audio per combo.
 *
 * There are NO media:* events for tts/voice (only media:file_extracted /
 * media:file_persisted exist) — assertions are on the pipeline's structured logger,
 * never on invented events.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { executeVoiceResponse } from "@comis/channels";
import type { VoiceResponsePipelineDeps, VoiceResponseContext } from "@comis/channels";
import { shouldAutoTts } from "@comis/skills";
import type { TtsAutoMode } from "@comis/core";
import { ok, err } from "@comis/shared";
import { buildCredentialRegistry } from "../../credentials.js";

const isLive = !!process.env["COMIS_LIVE"];

// Cheapest-viable STT/TTS combos (Edge TTS is keyless $0).
const STT_TTS_COMBOS = [
  { stt: "openai", tts: "edge" },
  { stt: "groq", tts: "openai" },
  { stt: "openai", tts: "elevenlabs" },
] as const;

const TAG_PATTERN = "\\[\\[tts(?::.*?)?\\]\\]";

/** Capture-logger: records the first arg of each warn/debug/info call. */
interface CapturedLogs {
  warn: Array<Record<string, unknown>>;
  debug: Array<Record<string, unknown>>;
  info: Array<Record<string, unknown>>;
}

/**
 * Build a VoiceResponsePipelineDeps from structural fakes. Returns the deps plus
 * the captured-log arrays and the synthesize spy so tests can assert on them.
 */
function makePipelineDeps(
  overrides: {
    autoMode?: TtsAutoMode;
    synthMime?: string;
    synthFails?: boolean;
    audioConverter?: VoiceResponsePipelineDeps["audioConverter"];
  } = {},
): {
  deps: VoiceResponsePipelineDeps;
  logged: CapturedLogs;
  synthesize: ReturnType<typeof vi.fn>;
} {
  const logged: CapturedLogs = { warn: [], debug: [], info: [] };
  const synthesize = vi.fn(async () =>
    overrides.synthFails
      ? err(new Error("synthesis boom"))
      : ok({ audio: Buffer.from("fake-audio"), mimeType: overrides.synthMime ?? "audio/mpeg" }),
  );

  const deps: VoiceResponsePipelineDeps = {
    ttsAdapter: { synthesize } as unknown as VoiceResponsePipelineDeps["ttsAdapter"],
    // undefined ⇒ ffmpeg absent (the sandbox default). Overridable for completeness.
    audioConverter: overrides.audioConverter,
    mediaTempManager: { getManagedDir: () => "/tmp" },
    mediaSemaphore: { run: <T>(fn: () => Promise<T>) => fn() },
    shouldAutoTts,
    resolveOutputFormat: () => ({
      openai: "opus",
      elevenlabs: "mp3_44100_128",
      edge: "audio-24khz-48kbitrate-mono-mp3",
      extension: ".mp3",
    }),
    ttsConfig: {
      autoMode: overrides.autoMode ?? "always",
      tagPattern: TAG_PATTERN,
      voice: "alloy",
      maxTextLength: 4096,
    },
    logger: {
      warn: (o: Record<string, unknown>) => logged.warn.push(o),
      debug: (o: Record<string, unknown>) => logged.debug.push(o),
      info: (o: Record<string, unknown>) => logged.info.push(o),
    },
  };
  return { deps, logged, synthesize };
}

function makeCtx(
  overrides: Partial<VoiceResponseContext> = {},
): VoiceResponseContext {
  return {
    responseText: "hello there",
    originalMessage: { attachments: [] },
    adapter: {
      sendAttachment: vi.fn(async () => ok({ kind: "delivered_untracked" as const })),
    } as unknown as VoiceResponseContext["adapter"],
    channelType: "echo",
    channelId: "echo-live",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stage-A — shouldAutoTts decision table + combos constants (no key, no daemon)
// ---------------------------------------------------------------------------

describe("VOICE-RT Stage-A — shouldAutoTts decisions + combos (no COMIS_LIVE)", () => {
  it("STT_TTS_COMBOS includes the keyless edge tts and an openai stt", () => {
    expect(STT_TTS_COMBOS.map((c) => c.tts)).toContain("edge");
    expect(STT_TTS_COMBOS.map((c) => c.stt)).toContain("openai");
  });

  it("autoMode off never synthesizes; always synthesizes when no media present", () => {
    expect(
      shouldAutoTts(
        { autoMode: "off", tagPattern: TAG_PATTERN },
        { responseText: "hi", hasInboundAudio: true, hasMediaUrl: false },
      ).shouldSynthesize,
    ).toBe(false);
    expect(
      shouldAutoTts(
        { autoMode: "always", tagPattern: TAG_PATTERN },
        { responseText: "hi", hasInboundAudio: false, hasMediaUrl: false },
      ).shouldSynthesize,
    ).toBe(true);
  });

  it("autoMode inbound synthesizes only when the inbound message had audio", () => {
    expect(
      shouldAutoTts(
        { autoMode: "inbound", tagPattern: TAG_PATTERN },
        { responseText: "hi", hasInboundAudio: false, hasMediaUrl: false },
      ).shouldSynthesize,
    ).toBe(false);
    expect(
      shouldAutoTts(
        { autoMode: "inbound", tagPattern: TAG_PATTERN },
        { responseText: "hi", hasInboundAudio: true, hasMediaUrl: false },
      ).shouldSynthesize,
    ).toBe(true);
  });

  it("autoMode tagged synthesizes only when the [[tts]] directive is present, stripping the tag", () => {
    const tagged = shouldAutoTts(
      { autoMode: "tagged", tagPattern: TAG_PATTERN },
      { responseText: "say this [[tts]]", hasInboundAudio: false, hasMediaUrl: false },
    );
    expect(tagged.shouldSynthesize).toBe(true);
    expect(tagged.strippedText).toBe("say this");
    expect(
      shouldAutoTts(
        { autoMode: "tagged", tagPattern: TAG_PATTERN },
        { responseText: "no directive here", hasInboundAudio: false, hasMediaUrl: false },
      ).shouldSynthesize,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stage-B — REAL executeVoiceResponse pipeline with structural fakes (no daemon)
// ---------------------------------------------------------------------------

describe("VOICE-RT Stage-B — ffmpeg-absent text fallback + pipeline autoMode (no COMIS_LIVE, deterministic)", () => {
  it("ffmpeg absent + non-OGG TTS output ⇒ voiceSent:false (TEXT fallback) + 'Install ffmpeg' WARN, NOT a throw/skip", async () => {
    const { deps, logged } = makePipelineDeps({ autoMode: "always", synthMime: "audio/mpeg" });
    const result = await executeVoiceResponse(deps, makeCtx());

    // Never throws; returns ok with voiceSent:false so text delivery proceeds.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.voiceSent).toBe(false);

    // The verbatim ffmpeg-absent WARN, with errorKind "dependency".
    const ffmpegWarn = logged.warn.find(
      (o) =>
        typeof o.hint === "string" &&
        o.hint.includes("Install ffmpeg for voice response support") &&
        o.errorKind === "dependency",
    );
    expect(ffmpegWarn).toBeDefined();
  });

  it("TTS synthesis failure ⇒ voiceSent:false + 'TTS synthesis failed; falling back to text-only response' WARN", async () => {
    const { deps, logged } = makePipelineDeps({ autoMode: "always", synthFails: true });
    const result = await executeVoiceResponse(deps, makeCtx());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.voiceSent).toBe(false);

    const synthWarn = logged.warn.find(
      (o) =>
        typeof o.hint === "string" &&
        o.hint.includes("TTS synthesis failed; falling back to text-only response") &&
        o.errorKind === "dependency",
    );
    expect(synthWarn).toBeDefined();
  });

  it("autoMode off ⇒ voiceSent:false, synthesize NEVER called, 'auto-tts-skip' reason logged", async () => {
    const { deps, logged, synthesize } = makePipelineDeps({ autoMode: "off" });
    const result = await executeVoiceResponse(deps, makeCtx());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.voiceSent).toBe(false);
    expect(synthesize).not.toHaveBeenCalled();
    expect(logged.debug.some((o) => o.reason === "auto-tts-skip")).toBe(true);
  });

  it("autoMode inbound without inbound audio ⇒ skip (synthesize not called)", async () => {
    const { deps, synthesize } = makePipelineDeps({ autoMode: "inbound" });
    const result = await executeVoiceResponse(deps, makeCtx({ originalMessage: { attachments: [] } }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.voiceSent).toBe(false);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("autoMode inbound WITH an inbound voice note ⇒ proceeds past the decision and hits the ffmpeg-absent WARN", async () => {
    const { deps, logged, synthesize } = makePipelineDeps({ autoMode: "inbound", synthMime: "audio/mpeg" });
    const result = await executeVoiceResponse(
      deps,
      makeCtx({ originalMessage: { attachments: [{ type: "audio", isVoiceNote: true }] } }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.voiceSent).toBe(false);
    // Decision allowed synthesis (inbound audio present) → synth ran → ffmpeg-absent WARN fired.
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(
      logged.warn.some(
        (o) => typeof o.hint === "string" && o.hint.includes("Install ffmpeg"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stage-C — real STT→LLM→TTS round-trips (COMIS_LIVE + keys + ffmpeg, operator-run)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("VOICE-RT Stage-C — real STT+TTS combos (COMIS_LIVE)", () => {
  it("credential registry resolves the keyless TTS(edge) category to null (no key required)", () => {
    const creds = buildCredentialRegistry();
    // Edge TTS is keyless ($0) — getSkipVerdict returns null so a 1-word synth can run keyless.
    expect(creds.getSkipVerdict("TTS(edge)")).toBeNull();
  });

  for (const combo of STT_TTS_COMBOS) {
    it.skip(
      `${combo.stt}→LLM→${combo.tts}: real audio→STT→LLM→TTS→audio round-trip (deferred to COMIS_LIVE operator run) — credential-gated via STT(${combo.stt})/TTS(${combo.tts}); requires ffmpeg for format conversion`,
      () => {
        // Stage-C (operator): boot daemon with buildMediaConfig({ sttProvider, ttsProvider }),
        // creds.getSkipVerdict("STT("+combo.stt+")") + getSkipVerdict("TTS("+combo.tts+")") to
        // skip-not-fail when keys are absent; driver.sendVoice(tinyClipBase64); assert
        // driver.getEcho().getSentMessages() has an audio attachment OR the "Voice response sent"
        // INFO line (with durationMs) appears in the daemon log. Cheapest-viable: 1-word clip.
      },
    );
  }
});
