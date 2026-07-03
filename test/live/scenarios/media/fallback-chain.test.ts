// SPDX-License-Identifier: Apache-2.0
/**
 * MEDIA-02 — STT/TTS fallback-chain certification.
 *
 * `createFallbackTranscription(providers, logger)` (from @comis/skills) is the real,
 * pure fallback-selection logic. Feeding it fake TranscriptionPort adapters — primary
 * returns err, fallback returns ok — reproduces "primary disabled ⇒ next serves" and
 * lets us assert the WARN hint/errorKind the operator relies on. This is the
 * log-oracle principle applied at the function boundary: a capture logger proves the
 * fallback fired with the right hint.
 *
 * Stage-A (always runs): STT_CHAIN constants + empty-providers err.
 * Stage-B (always runs, no daemon): the REAL createFallbackTranscription routing —
 *   primary-fail→fallback-serves + "Falling back to next STT provider" WARN; all-fail
 *   "All STT providers failed" + err (NOT throw); empty-text ⇒ no fallback. Plus a
 *   config-shape guard that buildMediaConfig emits the REAL `fallbackProviders` key.
 * Stage-C (it.skip, COMIS_LIVE + keys): real daemon fallback round-trip.
 *
 * There is NO media:transcription_done event — assertions are on the capture logger,
 * never on invented events.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { createFallbackTranscription } from "@comis/skills";
import type { TranscriptionPort } from "@comis/core";
import { ok, err } from "@comis/shared";
import { buildMediaConfig } from "../../harness/media-config.js";

const isLive = !!process.env["COMIS_LIVE"];

const STT_CHAIN = { primary: "openai", fallback: ["groq", "deepgram"] } as const;

/** Fake STT provider that succeeds with the given text. */
function makeOk(text: string): TranscriptionPort {
  return { transcribe: vi.fn(async () => ok({ text })) };
}
/** Fake STT provider that fails with the given message. */
function makeFail(msg: string): TranscriptionPort {
  return { transcribe: vi.fn(async () => err(new Error(msg))) };
}

/** Capture logger matching SttFallbackLogger ({ warn, info, debug }). */
function makeLogger(): { logger: { warn: (o: Record<string, unknown>, m: string) => void; info: () => void; debug: () => void }; warns: Array<Record<string, unknown>> } {
  const warns: Array<Record<string, unknown>> = [];
  return {
    warns,
    logger: {
      warn: (o: Record<string, unknown>) => warns.push(o),
      info: () => { /* noop */ },
      debug: () => { /* noop */ },
    },
  };
}

const AUDIO = Buffer.from("fake-audio");
const OPTS = { mimeType: "audio/ogg" } as const;

// ---------------------------------------------------------------------------
// Stage-A — constants + empty-chain err (no key, no daemon)
// ---------------------------------------------------------------------------

describe("FALLBACK Stage-A — STT chain constants + empty-providers (no COMIS_LIVE)", () => {
  it("STT_CHAIN names valid providers (primary + ordered fallback)", () => {
    const valid = ["openai", "groq", "deepgram"];
    expect(valid).toContain(STT_CHAIN.primary);
    for (const f of STT_CHAIN.fallback) expect(valid).toContain(f);
  });

  it("createFallbackTranscription([]) returns err (no providers configured), never throws", async () => {
    const fb = createFallbackTranscription([]);
    const result = await fb.transcribe(AUDIO, OPTS);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stage-B — REAL createFallbackTranscription routing + config-shape guard
// ---------------------------------------------------------------------------

describe("FALLBACK Stage-B — disable primary ⇒ next serves + correct hint (no COMIS_LIVE, deterministic)", () => {
  it("primary fails ⇒ fallback serves the request + WARN 'Falling back to next STT provider' (errorKind dependency)", async () => {
    const { logger, warns } = makeLogger();
    const fb = createFallbackTranscription([makeFail("primary down"), makeOk("hello world")], logger);
    const result = await fb.transcribe(AUDIO, OPTS);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.text).toBe("hello world");

    const fallbackWarn = warns.find(
      (o) =>
        typeof o.hint === "string" &&
        o.hint.includes("Falling back to next STT provider") &&
        o.errorKind === "dependency" &&
        o.providerIndex === 0,
    );
    expect(fallbackWarn).toBeDefined();
  });

  it("all providers fail ⇒ WARN 'All STT providers failed' (errorKind dependency) + err result (no throw)", async () => {
    const { logger, warns } = makeLogger();
    const fb = createFallbackTranscription([makeFail("a"), makeFail("b")], logger);
    const result = await fb.transcribe(AUDIO, OPTS);

    expect(result.ok).toBe(false);
    const allFailedWarn = warns.find(
      (o) =>
        typeof o.hint === "string" &&
        o.hint.includes("All STT providers failed") &&
        o.errorKind === "dependency",
    );
    expect(allFailedWarn).toBeDefined();
  });

  it("empty transcription text is valid (silence) ⇒ does NOT trigger fallback", async () => {
    const { logger } = makeLogger();
    const fallbackProvider = makeOk("should-not-be-used");
    const fb = createFallbackTranscription([makeOk(""), fallbackProvider], logger);
    const result = await fb.transcribe(AUDIO, OPTS);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.text).toBe("");
    // The fallback provider must never be consulted — empty text is a valid result.
    expect(fallbackProvider.transcribe).not.toHaveBeenCalled();
  });

  it("config-shape guard: buildMediaConfig emits the REAL `fallbackProviders` key (not `fallback`)", () => {
    const p = buildMediaConfig({ sttProvider: "openai", sttFallback: true, label: "fb-shape" });
    try {
      const yaml = readFileSync(p, "utf-8");
      // The daemon's strict TranscriptionConfigSchema only accepts `fallbackProviders`.
      expect(yaml).toMatch(/fallbackProviders:/);
      expect(yaml).toMatch(/-\s*groq/);
      expect(yaml).not.toMatch(/^\s*fallback:\s*$/m);
    } finally {
      rmSync(p, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Stage-C — real fallback against live providers (COMIS_LIVE + keys, operator-run)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("FALLBACK Stage-C — real STT fallback round-trip (COMIS_LIVE)", () => {
  it.skip(
    "primary=openai (forced auth failure) + fallbackProviders=[groq]: next provider transcribes + 'Falling back' WARN in daemon log (deferred to COMIS_LIVE operator run; credential-gated, skip≠fail)",
    () => {
      // Stage-C (operator): boot daemon with buildMediaConfig({ sttProvider:"openai", sttFallback:true })
      // and a blank/invalid OPENAI_API_KEY to force the primary to fail; creds.getSkipVerdict("STT(groq)")
      // to skip-not-fail when the groq key is absent; driver.sendVoice(tinyClipBase64); flushDaemonLogs +
      // driver.capturedLogLines() should contain "Falling back to next STT provider"; runLogOracle to
      // confirm no unexpected ERROR. Cheapest-viable: 1-word clip.
    },
  );
});
