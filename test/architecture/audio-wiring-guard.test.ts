// SPDX-License-Identifier: Apache-2.0
/**
 * Built-but-not-wired SOURCE GUARD for the keyless-first audio stack (Phase 193 /
 * Plan 03). Mirrors `video-wiring-guard.test.ts` / `setup-image-provider.test.ts`'s
 * RES-01-keystone guard: a shrink-only source-grep with NO allowlist.
 *
 * "Built but not wired" has been THIS program's #1 recurring blocker (caught by
 * code review every prior phase v2.14/v2.18/v2.22/v2.23/v2.24): the resolver +
 * selector can exist, compile, and pass their own unit tests while the LIVE daemon
 * never invokes them before adapter construction — so a Codex/OAuth-only main still
 * builds the empty-bearer OpenAI STT adapter (the 401 this milestone fixes). These
 * assertions pin the LIVE wiring — daemon.ts builds the selector + threads it into
 * setupMedia, and setup-media.ts consumes resolveStt()/resolveTts() BEFORE
 * createSTTProvider/createTTSProvider — so a future refactor cannot regress the
 * steering to unwired without turning this test red. The only way to comply is to
 * keep the wiring in daemon.ts + setup-media.ts.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const DAEMON_TS = resolve(REPO_ROOT, "packages/daemon/src/daemon.ts");
const SETUP_MEDIA_TS = resolve(REPO_ROOT, "packages/daemon/src/wiring/setup-media.ts");
const SETUP_AUDIO_PROVIDER_TS = resolve(
  REPO_ROOT,
  "packages/daemon/src/wiring/setup-audio-provider.ts",
);

/** Strip line + block comments so a token inside a comment cannot satisfy a
 *  wiring assertion (a comment naming buildAudioResolverDeps is NOT the wiring). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .split(/\r?\n/)
    .map((l) => {
      const t = l.trim();
      return t.startsWith("//") || t.startsWith("*") ? "" : l;
    })
    .join("\n");
}

describe("keyless-first audio built-but-not-wired source guard", () => {
  it("daemon.ts imports the audio resolver builder from wiring/setup-audio-provider.js", () => {
    const content = readFileSync(DAEMON_TS, "utf8");
    expect(content).toMatch(
      /import\s*\{[^}]*buildAudioResolverDeps[^}]*\}\s*from\s*["']\.\/wiring\/setup-audio-provider\.js["']/,
    );
  });

  it("daemon.ts CALLS the audio resolver builder and threads it into setupMedia (the boot wiring)", () => {
    const code = stripComments(readFileSync(DAEMON_TS, "utf8"));
    // The builder must be CALLED (not just imported) — the live construction.
    expect(code).toMatch(/buildAudio(Resolver|Provider|Handler)Deps\s*\(|createAudioProviderSelector\s*\(/);
    // … and the resolved selector must be threaded into the setupMedia call so it
    // actually reaches the construction seam. The bounded {0,400} window keeps the
    // match inside the _setupMedia({...}) argument object — a far-away audioSelector
    // token cannot satisfy it, so it fails RED until the thread is added.
    expect(code).toMatch(/_setupMedia\s*\(\{[\s\S]{0,400}?audioSelector/);
  });

  it("setup-media.ts gates STT construction on the resolver result before constructing the adapter (no empty-bearer)", () => {
    const code = stripComments(readFileSync(SETUP_MEDIA_TS, "utf8"));
    // The resolver call (resolveStt / the selector) must appear BEFORE the GATED
    // primary STT construction call. CRITICAL (plan note): anchor constructIdx on
    // the gated call site `createSTTProvider(sttConfig` — NOT a bare
    // /createSTTProvider/ (which matches the import line) and NOT a bare
    // /createSTTProvider\s*\(/ (which matches the createSTTProviderFactory helper's
    // internal `createSTTProvider(config, ...)` call at the top of the file, BEFORE
    // resolveStt — a false RED). After the WR-01 review fix the gated primary construct
    // builds from the RESOLVER's chosen config, so it is uniquely `createSTTProvider(sttConfig, ...)`
    // (the helper uses `(config`, the fallback loop uses `(fbConfig` — neither matches `(sttConfig`).
    const resolveIdx = code.search(/resolveStt|createAudioProviderSelector|resolveTranscriptionProvider|audioSelector/);
    const constructIdx = code.indexOf("createSTTProvider(sttConfig");
    expect(resolveIdx).toBeGreaterThanOrEqual(0);
    expect(constructIdx).toBeGreaterThanOrEqual(0);
    expect(resolveIdx).toBeLessThan(constructIdx);
  });

  it("setup-media.ts gates TTS construction on the resolver result before constructing the adapter", () => {
    const code = stripComments(readFileSync(SETUP_MEDIA_TS, "utf8"));
    // Same resolver-before-construct ordering for TTS. After the WR-01 review fix the
    // gated primary TTS construct builds from the RESOLVER's chosen config, so it is
    // uniquely `createTTSProvider(ttsConfig, ...)` (the helper uses `(config`).
    const resolveIdx = code.search(/resolveTts|audioSelector/);
    const constructIdx = code.indexOf("createTTSProvider(ttsConfig");
    expect(resolveIdx).toBeGreaterThanOrEqual(0);
    expect(constructIdx).toBeGreaterThanOrEqual(0);
    expect(resolveIdx).toBeLessThan(constructIdx);
  });

  it("setup-audio-provider.ts threads the Plan-01 resolvers + the SecretManager-backed audioKeyAvailable predicate (no codex branch)", () => {
    const code = stripComments(readFileSync(SETUP_AUDIO_PROVIDER_TS, "utf8"));
    // The selector calls the pure resolvers …
    expect(code).toMatch(/resolveTranscriptionProvider\s*\(/);
    expect(code).toMatch(/resolveTtsProvider\s*\(/);
    // … with the AUDIO_ENV_KEY-backed key-presence closure over SecretManager
    // (NOT process.env). The map must NOT carry an openai-codex entry (Pitfall 2 —
    // codex has no audio env key; MAIN_PROVIDER_AUDIO['openai-codex'] is undefined).
    expect(code).toMatch(/AUDIO_ENV_KEY/);
    expect(code).toMatch(/secretManager\.get\(/);
    expect(code).not.toMatch(/AUDIO_ENV_KEY\s*=\s*\{[\s\S]*?["']openai-codex["']/);
  });
});
