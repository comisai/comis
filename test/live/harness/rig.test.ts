// SPDX-License-Identifier: Apache-2.0
/**
 * REACT-03 — the rig CONFIG bed: buildConfigYaml must
 * ENABLE the Verified-Learning loop so a 👍 on an agent reply can persist an
 * `outcome_events` row and drive synthesis. Stage-A, no daemon required.
 *
 * The learning loop is byte-identical-OFF until THREE gotchas are turned on in
 * the throwaway config (setup-learning-reactions.ts:651-656,720) AND the reactor
 * is granted trust ≥ `known` (the 0.05 write floor):
 *
 *   GOTCHA C — `someLearningOn` requires `memory.enabled` AND each
 *     agent's `learningOutcome.enabled` (else `recordOutboundMessage` is
 *     undefined → no ReactionTrajectoryMap binding at all) + `learning.enabled`
 *     (the single gate covering learning skills and tuning).
 *   GOTCHA D — the DM reactor defaults to `external` trust
 *     (`elevatedReply.defaultTrustLevel ?? "external"`):
 *     `REACTION_BASE_CONFIDENCE 0.6 × trustWeight("external") 0.05 = 0.03 <
 *      REACTION_MIN_CONFIDENCE_TO_WRITE 0.05` → the 👍 SILENTLY does not persist.
 *     `known` → `0.6 × 0.4 = 0.24 ≥ 0.05` ✓.
 *
 * These assertions parse the produced YAML through the REAL `AppConfigSchema`
 * (any misplaced key → a loud fail) AND assert the keys are EXPLICITLY present in
 * the raw doc — NOT merely the schema-defaulted values (the learning toggles
 * DEFAULT ON in the schema [opt-out], so a defaulted-value assertion would pass
 * even on the pre-edit builder; the RAW-doc presence check is what fails RED on
 * the un-edited config). A fix must NEVER flip a product default — only the rig's
 * throwaway config turns these on (the git-porcelain guard in the scenario
 * re-asserts ZERO product source change under packages).
 *
 * Run (Stage-A, offline, deterministic):
 *   pnpm vitest run -c test/live/vitest.config.ts test/live/harness/rig.test.ts
 * (NB: a BARE `pnpm vitest run test/live/...` resolves the ROOT config whose
 *  projects exclude test/live → 0 files, exit 0 = false green. ALWAYS pass
 *  `-c test/live/vitest.config.ts`.)
 *
 * TEST-HARNESS — lives under `test/`, never the packages source-tree; ZERO
 * production code change.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { Bot } from "grammy";
import { AppConfigSchema, validateUrl, validateLocalServerUrl } from "@comis/core";
import { createTelegramResolver } from "@comis/channels";
import {
  buildConfigYaml,
  buildLoopbackMediaOverride,
  buildLoopbackSsrfFetcher,
  buildMediaOverrides,
  RIG_CHANNELS,
  type RigChannel,
} from "./rig.js";
// The Signal config writer lives in the `@comis/*`-FREE `rig-config.ts` (the
// detached-tsx constraint). Imported from its HOME module so the CHAN2-02 RED
// fails purely on the absent function (independent of the rig.ts re-export).
import { buildSignalConfigYaml } from "./rig-config.js";
import { createTgEmulator } from "../emulators/telegram/tg-emulator.js";

/** The fixed args a rig boot passes — an emulator apiRoot, a gateway port, the keyless model. */
const APP_ROOT = "http://127.0.0.1:54321";
const GATEWAY_PORT = 47660;

/** Produce the throwaway YAML the rig writes for both buildRig and `tg up`. */
function yaml(): string {
  return buildConfigYaml(APP_ROOT, GATEWAY_PORT, "keyless");
}

/** Parse the raw YAML to a plain doc (PRE schema-default — explicit keys only). */
function rawDoc(): Record<string, unknown> {
  return parseYaml(yaml()) as Record<string, unknown>;
}

/** Parse + validate through the real config schema; returns the typed config. */
function validConfig() {
  const result = AppConfigSchema.safeParse(rawDoc());
  expect(
    result.success,
    result.success
      ? ""
      : `the rig config is schema-INVALID: ${JSON.stringify(result.error.issues.slice(0, 5))}`,
  ).toBe(true);
  return result.success ? result.data : (undefined as never);
}

/** Narrow `agents.default` from the RAW doc (explicit keys, pre-default). */
function rawAgentDefault(): Record<string, unknown> {
  const agents = rawDoc()["agents"] as Record<string, Record<string, unknown>> | undefined;
  const def = agents?.["default"];
  expect(def, "agents.default block present in the rig config").toBeDefined();
  return def as Record<string, unknown>;
}

describe("REACT-03 rig config — the produced YAML stays schema-VALID", () => {
  it("parses through the real AppConfigSchema (a misplaced learning key → loud fail)", () => {
    // The loud guard: if learningOutcome/learning or
    // elevatedReply land at a wrong path (e.g. under memory, or a typo'd key on
    // a strictObject), AppConfigSchema rejects it — a typo can't silently no-op.
    validConfig();
  });
});

describe("REACT-03 rig config — GOTCHA C: learning is ENABLED (else the loop is byte-identical-OFF)", () => {
  it("memory.enabled is EXPLICITLY true (someLearningOn requires it; else recordOutboundMessage is undefined)", () => {
    // RAW-doc presence: the key must be WRITTEN, not just schema-defaulted —
    // this is the assertion that fails RED on the pre-edit builder.
    const memory = rawDoc()["memory"] as Record<string, unknown> | undefined;
    expect(memory, "memory block present").toBeDefined();
    expect(memory!["enabled"], "memory.enabled EXPLICITLY present in the rig config").toBe(true);
    // And it validates to true through the real schema.
    expect(validConfig().memory.enabled).toBe(true);
  });

  it("agents.default.learningOutcome.enabled is EXPLICITLY true (gates the reaction observe)", () => {
    const learningOutcome = rawAgentDefault()["learningOutcome"] as Record<string, unknown> | undefined;
    expect(learningOutcome, "agents.default.learningOutcome EXPLICITLY present").toBeDefined();
    expect(learningOutcome!["enabled"]).toBe(true);
    expect(validConfig().agents["default"]!.learningOutcome.enabled).toBe(true);
  });

  it("agents.default.learning.enabled is EXPLICITLY true (else the reflection cron never runs)", () => {
    const learning = rawAgentDefault()["learning"] as Record<string, unknown> | undefined;
    expect(learning, "agents.default.learning EXPLICITLY present").toBeDefined();
    expect(learning!["enabled"]).toBe(true);
    expect(validConfig().agents["default"]!.learning.enabled).toBe(true);
  });
});

describe("REACT-03 rig config — GOTCHA D: the reactor trust floor (the #1 REACT-03 trap)", () => {
  it("agents.default.elevatedReply.defaultTrustLevel is 'known' (clears the 0.05 write floor: 0.6×0.4=0.24)", () => {
    const elevatedReply = rawAgentDefault()["elevatedReply"] as Record<string, unknown> | undefined;
    expect(elevatedReply, "agents.default.elevatedReply EXPLICITLY present").toBeDefined();
    // 'known' (or higher) — NOT the default 'external' (0.6×0.05=0.03 < 0.05 → silent no-row).
    expect(elevatedReply!["defaultTrustLevel"]).toBe("known");
    expect(validConfig().agents["default"]!.elevatedReply.defaultTrustLevel).toBe("known");
  });
});

// ---------------------------------------------------------------------------
// MEDIA-02 / SEC-01 — the test-scoped SSRF-loopback
// allowance: a THIN `DaemonOverrides.setupMedia` wrapper that swaps ONLY
// `result.ssrfFetcher` for a loopback fetcher addressing BOTH SSRF blocks:
// (1) the resolver's HARDCODED `api.telegram.org` download URL
// (telegram-resolver.ts:95) is host-rewritten to the emulator host; (2)
// production `validateUrl` BLOCKS loopback — the override uses the inverse
// primitive `validateLocalServerUrl([host])` (ALLOWS loopback, KEEPS the
// cloud-metadata DENY). OPT-IN, OFF by default. Production `validateUrl`,
// `setupMedia`, and `telegram-resolver.ts:95` are NOT edited.
//
// Run (Stage-A/B, offline, deterministic — the tiny loopback emulator boots but
// NO daemon and NO real model):
//   pnpm vitest run -c test/live/vitest.config.ts test/live/harness/rig.test.ts -t "loopback"
// ---------------------------------------------------------------------------

/** A throwaway bot token the loopback rewrite + resolver download URL carry. */
const OVERRIDE_TOKEN = "1234567:override-fake-token";

describe("MEDIA-02 loopback override — buildLoopbackMediaOverride is a thin setupMedia wrapper (opt-in)", () => {
  it("returns a `typeof setupMedia` FUNCTION (the DaemonOverrides.setupMedia shape)", () => {
    const override = buildLoopbackMediaOverride({ emulatorHost: "127.0.0.1:54321", maxBytes: 1_000_000 });
    // It is a function the daemon's `_setupMedia = overrides.setupMedia ?? setupMedia`
    // can await (daemon.ts:1742,2004) — NOT a MediaResult object.
    expect(typeof override).toBe("function");
  });

  it("buildMediaOverrides is OFF by default — no `setupMedia` key when the flag is falsy", () => {
    // The opt-in threading: `startRig`/`buildRig` spread this into
    // `startTestDaemon({ overrides })`. Falsy flag → an EMPTY overrides bag, so a
    // standard rig boot is byte-identical (zero media-wiring change).
    const off = buildMediaOverrides({ mediaLoopbackOverride: false, emulatorHost: "127.0.0.1:54321", maxBytes: 1_000_000 });
    expect("setupMedia" in off).toBe(false);

    const offDefault = buildMediaOverrides({ emulatorHost: "127.0.0.1:54321", maxBytes: 1_000_000 });
    expect("setupMedia" in offDefault).toBe(false);
  });

  it("buildMediaOverrides ON → a `setupMedia` override function is threaded", () => {
    const on = buildMediaOverrides({ mediaLoopbackOverride: true, emulatorHost: "127.0.0.1:54321", maxBytes: 1_000_000 });
    expect("setupMedia" in on).toBe(true);
    expect(typeof on.setupMedia).toBe("function");
  });
});

describe("MEDIA-02 loopback override — the loopback fetcher addresses BOTH SSRF blocks", () => {
  it("rewrites the HARDCODED api.telegram.org download URL to the emulator host AND validates+downloads OK against loopback", async () => {
    // A real (tiny) emulator on loopback — NO daemon. Store bytes, then drive the
    // loopback fetcher with the EXACT hardcoded URL the resolver builds.
    const emulator = createTgEmulator({ botToken: OVERRIDE_TOKEN });
    const { apiRoot } = await emulator.start();
    try {
      const emulatorHost = new URL(apiRoot).host; // 127.0.0.1:<port>
      const bytes = Buffer.from("loopback-voice-bytes-deterministic", "utf-8");
      const handle = emulator.storeFile("voice", bytes, { mimeType: "audio/ogg" });

      const fetcher = buildLoopbackSsrfFetcher({ emulatorHost, maxBytes: 1_000_000 });
      // The hardcoded URL shape (telegram-resolver.ts:95) — points at the PUBLIC
      // api.telegram.org host; the override fetcher must rewrite it to loopback.
      const downloadUrl = `https://api.telegram.org/file/bot${OVERRIDE_TOKEN}/${handle.filePath}`;
      const result = await fetcher.fetch(downloadUrl);

      expect(result.ok, result.ok ? "" : `loopback fetch failed: ${String(result.ok === false && result.error.message)}`).toBe(true);
      if (result.ok) {
        // The emulator file route served the EXACT stored bytes — block #1 (host
        // rewrite) AND block #2 (validateLocalServerUrl-allows-loopback) both passed.
        expect(Buffer.from(result.value.buffer).equals(bytes)).toBe(true);
        expect(result.value.sizeBytes).toBe(bytes.length);
      }
    } finally {
      await emulator.stop();
    }
  });

  it("STILL BLOCKS a non-loopback / non-emulator host (the override is loopback-ONLY, not an arbitrary-URL hole)", async () => {
    // A download URL whose host is NOT api.telegram.org (so no rewrite fires) and
    // resolves to a non-loopback range → the override's validateLocalServerUrl DENIES.
    const fetcher = buildLoopbackSsrfFetcher({ emulatorHost: "127.0.0.1:54321", maxBytes: 1_000_000 });
    const result = await fetcher.fetch("http://example.com/file/whatever.bin");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MEDIA-02 byte-proof — DETERMINISTIC, OFFLINE, no real
// model. The resolver-level proof: the
// daemon's keyless capability short-circuit (`media-handler-audio.ts:44 if
// (!deps.transcriber)`) means a plain keyless run NEVER downloads bytes — so the
// SSRF-guarded download is unreachable end-to-end without a model. We force it by
// driving the REAL `createTelegramResolver` (@comis/channels) DIRECTLY with the
// override's loopback `ssrfFetcher`, against a `tg-file://{file_id}` the emulator
// stored, and assert the resolver returns the EXACT bytes. The resolver's `resolve`
// IS the resolve+download leg the daemon would invoke (resolveMediaAttachment →
// compositeResolver.resolve); calling it directly is the stub-forced equivalent of
// wiring a stub transcriber, with no real STT adapter needed. A real grammy `Bot`
// pointed at the emulator `apiRoot` exercises the REAL `getFile` route too, so the
// full store → getFile → file-route → SSRF-guarded download chain is proven.
//
// PLUS the no-widening assertion: production `validateUrl(loopbackUrl)` STILL `!ok`
// (the SEC-01 load-bearing proof the override did NOT widen production posture).
// ---------------------------------------------------------------------------

/** A no-op logger satisfying the resolver's `{ debug, warn }` contract. */
const NOOP_RESOLVER_LOGGER = {
  debug(_obj: Record<string, unknown>, _msg: string): void {},
  warn(_obj: Record<string, unknown>, _msg: string): void {},
};

describe("MEDIA-02 byte-proof — a loopback SSRF-guarded download SUCCEEDS through the override (deterministic, no model)", () => {
  it("the REAL telegram resolver, driven with the loopback ssrfFetcher, returns the EXACT bytes the emulator stored", async () => {
    const emulator = createTgEmulator({ botToken: OVERRIDE_TOKEN });
    const { apiRoot } = await emulator.start();
    try {
      const emulatorHost = new URL(apiRoot).host;
      const bytes = Buffer.from("media-02-deterministic-voice-payload-🎙️", "utf-8");
      const handle = emulator.storeFile("voice", bytes, { mimeType: "audio/ogg" });

      // A real grammy Bot pointed at the emulator — resolver.resolve() calls
      // bot.api.getFile() which hits the REAL emulator getFile route (the store
      // descriptor with the real file_path + file_size), then downloads.
      const bot = new Bot(OVERRIDE_TOKEN, { client: { apiRoot } });
      const ssrfFetcher = buildLoopbackSsrfFetcher({ emulatorHost, maxBytes: 50 * 1024 * 1024 });
      const resolver = createTelegramResolver({
        bot,
        botToken: OVERRIDE_TOKEN,
        maxBytes: 50 * 1024 * 1024,
        ssrfFetcher,
        logger: NOOP_RESOLVER_LOGGER,
      });

      // The stub-forced resolve+download leg: resolve a tg-file://{file_id}.
      const resolved = await resolver.resolve({ type: "audio", url: `tg-file://${handle.fileId}` });

      expect(
        resolved.ok,
        resolved.ok ? "" : `resolve failed (loopback download blocked or getFile 404): ${String(resolved.ok === false && resolved.error.message)}`,
      ).toBe(true);
      if (resolved.ok) {
        // No "Blocked: resolved IP 127.0.0.1 is in loopback range" (block #2 would
        // fire on production validateUrl) and no api.telegram.org 404 (block #1) —
        // the loopback download SUCCEEDED and served the exact stored bytes.
        expect(Buffer.from(resolved.value.buffer).equals(bytes)).toBe(true);
        expect(resolved.value.sizeBytes).toBe(bytes.length);
      }
    } finally {
      await emulator.stop();
    }
  });
});

describe("MEDIA-02 / SEC-01 no-widening — production SSRF posture is provably UNTOUCHED by the override", () => {
  it("production validateUrl STILL blocks loopback, while validateLocalServerUrl([host]) allows it (the test-scoped allowance)", async () => {
    const emulator = createTgEmulator({ botToken: OVERRIDE_TOKEN });
    const { apiRoot } = await emulator.start();
    try {
      const emulatorHost = new URL(apiRoot).host;
      const loopbackUrl = `${apiRoot}/file/bot${OVERRIDE_TOKEN}/voice/anything.ogg`;

      // Production guard — UNCHANGED: loopback is in BLOCKED_RANGES → still denied.
      const prod = await validateUrl(loopbackUrl);
      expect(prod.ok, "production validateUrl must STILL block loopback (no-widening)").toBe(false);

      // The override's primitive — ALLOWS loopback (the scoped allowance).
      const scoped = await validateLocalServerUrl(loopbackUrl, [emulatorHost.split(":")[0] ?? emulatorHost]);
      expect(scoped.ok, "validateLocalServerUrl must ALLOW the loopback emulator URL").toBe(true);
    } finally {
      await emulator.stop();
    }
  });

  it("the SSRF allowance is the override only — production validateUrl blocks loopback regardless of any allowlist arg it does not accept", async () => {
    // A direct, daemon-free reaffirmation: validateUrl takes ONE arg and blocks
    // loopback unconditionally; there is no allowlist knob that widens it. The
    // allowance lives EXCLUSIVELY in the override's validateLocalServerUrl path.
    const blocked = await validateUrl("http://127.0.0.1:65530/file/x.bin");
    expect(blocked.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CHAN2-02 — the `@comis/*`-FREE Signal config writer (the
// `channels.signal.baseUrl` REDIRECT SEAM). `buildSignalConfigYaml` mirrors the
// telegram `buildConfigYaml` but writes `channels.signal = { enabled:true,
// baseUrl:<baseUrl> }` (the verified seam — setup-channels-adapters.ts:216-227
// reads `signal.baseUrl` → validateSignalConnection → createSignalPlugin with
// ZERO product change; schema-channel.ts already has `signal.baseUrl`). NO
// `account` → the daemon boot is the GET /api/v1/check health-check only
// (credential-validator.ts:56 skips listAccounts). The same keyless ollama
// provider + the ≥32-char LITERAL gateway token block as the telegram writer.
//
// The telegram writer stays BYTE-IDENTICAL (the Signal writer is ADDITIVE) — the
// foundation-fix regression guard. And `rig-config.ts` stays
// `@comis/*`-import-free (the detached `rig-daemon.ts` imports it under bare
// `tsx` — a `@comis/*` edge would break that AND is a published-graph concern).
//
// Run (Stage-A, offline, deterministic):
//   pnpm vitest run -c test/live/vitest.config.ts test/live/harness/rig.test.ts -t "Signal config"
// ---------------------------------------------------------------------------

/** The loopback baseUrl a Signal rig writes (the started SignalEmulator's apiRoot). */
const SIGNAL_BASE_URL = "http://127.0.0.1:54399";

/** Produce the Signal throwaway YAML the rig writes for a `{channel:"signal"}` boot. */
function signalYaml(): string {
  return buildSignalConfigYaml(SIGNAL_BASE_URL, GATEWAY_PORT, "keyless");
}

/** Parse the raw Signal YAML to a plain doc (PRE schema-default — explicit keys only). */
function signalRawDoc(): Record<string, unknown> {
  return parseYaml(signalYaml()) as Record<string, unknown>;
}

/** Parse + validate the Signal YAML through the real config schema; returns the typed config. */
function signalValidConfig() {
  const result = AppConfigSchema.safeParse(signalRawDoc());
  expect(
    result.success,
    result.success
      ? ""
      : `the Signal rig config is schema-INVALID: ${JSON.stringify(result.error.issues.slice(0, 5))}`,
  ).toBe(true);
  return result.success ? result.data : (undefined as never);
}

describe("CHAN2-02 Signal config writer — channels.signal.baseUrl is the redirect seam", () => {
  it("writes channels.signal = { enabled:true, baseUrl:<baseUrl> } (the seam setup-channels-adapters reads)", () => {
    const channels = signalRawDoc()["channels"] as Record<string, unknown> | undefined;
    expect(channels, "channels block present in the Signal rig config").toBeDefined();
    const signal = channels!["signal"] as Record<string, unknown> | undefined;
    expect(signal, "channels.signal EXPLICITLY present (the seam block)").toBeDefined();
    expect(signal!["enabled"]).toBe(true);
    // The redirect seam: baseUrl == the loopback emulator apiRoot (config-only,
    // ZERO product change — the daemon's createSignalPlugin targets it).
    expect(signal!["baseUrl"]).toBe(SIGNAL_BASE_URL);
    // And it validates to the same baseUrl through the real schema.
    expect(signalValidConfig().channels.signal.baseUrl).toBe(SIGNAL_BASE_URL);
    expect(signalValidConfig().channels.signal.enabled).toBe(true);
  });

  it("sets NO `account` (the boot is the GET /api/v1/check health-check only — credential-validator.ts:56)", () => {
    const channels = signalRawDoc()["channels"] as Record<string, Record<string, unknown>>;
    const signal = channels["signal"]!;
    // Absent in the RAW doc — no account key written at all.
    expect("account" in signal).toBe(false);
    // The schema default leaves it undefined (optional) — no spoofed account.
    expect(signalValidConfig().channels.signal.account).toBeUndefined();
  });

  it("does NOT write a channels.telegram block (the Signal writer is a distinct seam, not the telegram one)", () => {
    const channels = signalRawDoc()["channels"] as Record<string, unknown>;
    expect("telegram" in channels).toBe(false);
  });

  it("carries the SAME keyless ollama provider + the ≥32-char LITERAL gateway token block as the telegram writer", () => {
    const doc = signalRawDoc();
    // Keyless provider ($0/offline) — the same models.defaultProvider: ollama.
    const models = doc["models"] as Record<string, unknown> | undefined;
    expect(models?.["defaultProvider"]).toBe("ollama");
    // The ≥32-char LITERAL gateway token (env-refs do NOT resolve for the test
    // gateway — schema-gateway.ts:45 z.string().min(32)).
    const cfg = signalValidConfig();
    const token = cfg.gateway.tokens[0]!.secret;
    expect(typeof token).toBe("string");
    expect((token as string).length).toBeGreaterThanOrEqual(32);
    // The agent runs on the keyless local provider (the same shape as telegram).
    expect(cfg.agents["default"]!.provider).toBe("keyless-local");
  });

  it("the produced Signal YAML stays schema-VALID through the real AppConfigSchema (a misplaced key → loud fail)", () => {
    signalValidConfig();
  });
});

describe("CHAN2-02 Signal config writer — rig-config.ts stays @comis/*-free (the detached-tsx + published-graph constraint)", () => {
  it("rig-config.ts has NO `from \"@comis/...\"` import (the detached rig-daemon imports it under bare tsx)", () => {
    // A `@comis/*` edge would break the detached rig (bare tsx cannot
    // resolve the alias) AND is a published-graph concern. Assert the SOURCE has
    // no such import (the Signal writer is plain-string only).
    const rigConfigPath = fileURLToPath(new URL("./rig-config.ts", import.meta.url));
    const source = readFileSync(rigConfigPath, "utf-8");
    expect(source.includes('from "@comis/')).toBe(false);
  });
});

describe("CHAN2-02 Signal config writer — the telegram writer is BYTE-IDENTICAL (the regression guard)", () => {
  it("buildConfigYaml still writes channels.telegram with the apiRoot seam (the Signal writer is additive)", () => {
    // The telegram path is INVIOLATE. The existing telegram config-shape
    // assertions above already pin its content; this re-asserts the seam survives
    // alongside the new Signal writer.
    const tgYaml = buildConfigYaml(APP_ROOT, GATEWAY_PORT, "keyless");
    expect(tgYaml.includes("channels:\n  telegram:")).toBe(true);
    expect(tgYaml.includes(`apiRoot: "${APP_ROOT}"`)).toBe(true);
    // And the telegram writer does NOT emit a channels.signal block.
    expect(tgYaml.includes("channels.signal")).toBe(false);
    expect(tgYaml.includes("\n  signal:")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CHAN2-01 + CHAN2-02 — the channel→{emulator-factory,
// config-writer} dispatch MAP + the ONE-LINE signal registration.
//
// The foundation-fix: `rig.ts` was telegram-hard-coded (a `channel:"telegram"`
// literal type, a `buildRig` THROW on non-telegram, a hard-constructed
// `createTgEmulator`, a hard-coded `buildConfigYaml`). This earns the
// generalization: `RIG_CHANNELS[opts.channel] = { make, writeConfig }`. The
// `signal:` entry IS the one-line registration (createSignalEmulator +
// buildSignalConfigYaml). `buildRig`/`startStandaloneRig` look up by channel; the
// daemon-boot/isolation/cleanup machinery is channel-agnostic + reused unchanged.
//
// These tests drive the MAP directly (deterministic, NO daemon): the factory
// produces the right emulator, the config-writer wires the right seam, and the
// telegram entry is byte-identical (the regression guard). The real
// `buildRig({channel:"signal"})` daemon boot is the COMIS_LIVE Stage-C leg
// (skip≠fail offline) — these tests prove the DISPATCH.
//
// Run (Stage-A, offline, deterministic):
//   pnpm vitest run -c test/live/vitest.config.ts test/live/harness/rig.test.ts -t "dispatch map"
// ---------------------------------------------------------------------------

describe("CHAN2-01/02 channel dispatch map — the factory + config-writer registry", () => {
  it("has a `telegram` AND a `signal` entry (the one-line signal registration)", () => {
    // The channel literal is generalized to the union — both channels register.
    const channels = Object.keys(RIG_CHANNELS).sort();
    expect(channels).toContain("telegram");
    expect(channels).toContain("signal");
    // Each entry carries the factory + the config-writer (the dispatch shape).
    expect(typeof RIG_CHANNELS.telegram.make).toBe("function");
    expect(typeof RIG_CHANNELS.telegram.writeConfig).toBe("function");
    expect(typeof RIG_CHANNELS.signal.make).toBe("function");
    expect(typeof RIG_CHANNELS.signal.writeConfig).toBe("function");
    // A compile-time witness that RigChannel is the union (not the bare literal).
    const sig: RigChannel = "signal";
    const tg: RigChannel = "telegram";
    expect([tg, sig]).toEqual(["telegram", "signal"]);
  });

  it("the signal factory makes a SignalEmulator (caps.channel === 'signal'), NOT a TgEmulator", async () => {
    const emulator = RIG_CHANNELS.signal.make({ channel: "signal", model: "keyless" });
    try {
      // The Signal emulator self-describes via its flat caps (signalCaps).
      expect(emulator.caps.channel).toBe("signal");
      // It boots a loopback wire surface (the GET /api/v1/check the adapter awaits).
      const { apiRoot } = await emulator.start();
      expect(apiRoot).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await emulator.stop();
    }
  });

  it("the telegram factory still makes a TgEmulator (caps.channel === 'telegram') — the regression guard", async () => {
    const emulator = RIG_CHANNELS.telegram.make({ channel: "telegram", model: "keyless" });
    try {
      expect(emulator.caps.channel).toBe("telegram");
      const { apiRoot } = await emulator.start();
      expect(apiRoot).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await emulator.stop();
    }
  });

  it("the signal config-writer wires channels.signal.baseUrl == the started emulator's apiRoot (the seam)", async () => {
    // The BOOT PROOF (deterministic, no daemon): start the Signal emulator via the
    // map factory, write its config via the map writer, and assert the seam wires
    // the emulator's loopback apiRoot — exactly what buildRig({channel:'signal'})
    // does before startTestDaemon.
    const emulator = RIG_CHANNELS.signal.make({ channel: "signal", model: "keyless" });
    try {
      const { apiRoot } = await emulator.start();
      const cfg = RIG_CHANNELS.signal.writeConfig(apiRoot, GATEWAY_PORT, "keyless");
      const doc = parseYaml(cfg) as Record<string, unknown>;
      const channels = doc["channels"] as Record<string, Record<string, unknown>>;
      expect(channels["signal"]).toBeDefined();
      expect(channels["signal"]!["baseUrl"]).toBe(apiRoot);
      expect(channels["signal"]!["enabled"]).toBe(true);
      // The Signal writer never emits a telegram block.
      expect("telegram" in channels).toBe(false);
    } finally {
      await emulator.stop();
    }
  });

  it("the telegram config-writer is byte-identical to buildConfigYaml (the regression guard)", () => {
    // The telegram entry MUST produce the SAME apiRoot YAML the public surface
    // depends on — the map dispatch is additive, telegram is one entry.
    const viaMap = RIG_CHANNELS.telegram.writeConfig(APP_ROOT, GATEWAY_PORT, "keyless");
    const direct = buildConfigYaml(APP_ROOT, GATEWAY_PORT, "keyless");
    expect(viaMap).toBe(direct);
  });
});
