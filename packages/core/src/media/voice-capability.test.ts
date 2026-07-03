// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { VOICE_KEYLESS, MAIN_PROVIDER_AUDIO } from "./voice-capability.js";
import { STT_ERR_TO_LOG, type SttErrorKind } from "./voice-error.js";
import type { ErrorKind } from "../logging/log-fields.js";

/**
 * VOICE_KEYLESS + MAIN_PROVIDER_AUDIO single-source-of-truth, plus the
 * SttErrorKind → closed log ErrorKind bridge (mirror of image-capability.test /
 * image-error). THE HEADLINE assertion:
 * `MAIN_PROVIDER_AUDIO["openai-codex"] === undefined` — the EXACT OPPOSITE of
 * IMAGE_CAPABILITY (where openai-codex is image-capable). A naive copy-paste of
 * the image map that gives codex an audio entry re-introduces the empty-bearer
 * 401, so this test fails RED on that mistake.
 */
describe("MAIN_PROVIDER_AUDIO (keyless-first audio-key reuse map)", () => {
  it("maps openai-codex to undefined — an OAuth bearer cannot reach /v1/audio/* (THE headline)", () => {
    expect(MAIN_PROVIDER_AUDIO["openai-codex"]).toBe(undefined);
  });

  it("maps openai and groq to their own keyed audio providers (main-key reuse)", () => {
    expect(MAIN_PROVIDER_AUDIO["openai"]).toBe("openai");
    expect(MAIN_PROVIDER_AUDIO["groq"]).toBe("groq");
  });

  it("leaves providers with no reusable audio key undefined (anthropic, ollama)", () => {
    expect(MAIN_PROVIDER_AUDIO["anthropic"]).toBe(undefined);
    expect(MAIN_PROVIDER_AUDIO["ollama"]).toBe(undefined);
  });

  it("does NOT carry the selection-mode/keyless values as keys (the two-vocabulary rule)", () => {
    // "auto" is a selection MODE; "local"/"edge" are keyless PROVIDERS — none is a
    // resolved main-provider id, so none may be a key of MAIN_PROVIDER_AUDIO.
    expect(Object.prototype.hasOwnProperty.call(MAIN_PROVIDER_AUDIO, "auto")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(MAIN_PROVIDER_AUDIO, "local")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(MAIN_PROVIDER_AUDIO, "edge")).toBe(false);
  });
});

describe("VOICE_KEYLESS (credential-free providers)", () => {
  it("holds the keyless providers: local (STT) + edge and piper (TTS)", () => {
    expect(VOICE_KEYLESS.has("local")).toBe(true);
    expect(VOICE_KEYLESS.has("edge")).toBe(true);
    expect(VOICE_KEYLESS.has("piper")).toBe(true);
  });

  it("does not treat a keyed cloud provider as keyless", () => {
    expect(VOICE_KEYLESS.has("openai")).toBe(false);
    expect(VOICE_KEYLESS.has("groq")).toBe(false);
  });
});

describe("STT_ERR_TO_LOG (voice-error bridge)", () => {
  it("maps every SttErrorKind onto a member of the closed log ErrorKind union", () => {
    // The Record<SttErrorKind, ErrorKind> annotation enforces this at the type
    // level; this value check pins the specific mappings the AGENTS.md §2.7
    // logging matrix relies on.
    const CLOSED_LOG_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
      "config",
      "network",
      "auth",
      "validation",
      "precondition",
      "timeout",
      "resource",
      "dependency",
      "internal",
      "platform",
    ]);
    for (const k of Object.keys(STT_ERR_TO_LOG) as SttErrorKind[]) {
      expect(CLOSED_LOG_KINDS.has(STT_ERR_TO_LOG[k])).toBe(true);
    }
  });

  it("maps no_keyless_engine to precondition and auth_required to auth", () => {
    expect(STT_ERR_TO_LOG.no_keyless_engine).toBe("precondition");
    expect(STT_ERR_TO_LOG.auth_required).toBe("auth");
  });
});
