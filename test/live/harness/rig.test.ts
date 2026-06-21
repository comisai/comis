// SPDX-License-Identifier: Apache-2.0
/**
 * REACT-03 (Plan 206-03, Task 1) — the rig CONFIG bed: buildConfigYaml must
 * ENABLE the Verified-Learning loop so a 👍 on an agent reply can persist an
 * `outcome_events` row and drive synthesis. Stage-A, no daemon required.
 *
 * The learning loop is byte-identical-OFF until THREE gotchas are turned on in
 * the throwaway config (setup-learning-reactions.ts:651-656,720) AND the reactor
 * is granted trust ≥ `known` (the 0.05 write floor):
 *
 *   GOTCHA C — `someLearningOn` requires `memory.costFeatures.enabled` AND each
 *     agent's `learningOutcome.enabled` (else `recordOutboundMessage` is
 *     undefined → no ReactionTrajectoryMap binding at all) + `learningSkills`
 *     (else synthesis never runs) + `learningTuning` (the positive reward).
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

import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { AppConfigSchema, validateUrl, validateLocalServerUrl } from "@comis/core";
import {
  buildConfigYaml,
  buildLoopbackMediaOverride,
  buildLoopbackSsrfFetcher,
  buildMediaOverrides,
} from "./rig.js";
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
    // The loud guard: if learningOutcome/learningSkills/learningTuning or
    // elevatedReply land at a wrong path (e.g. under memory, or a typo'd key on
    // a strictObject), AppConfigSchema rejects it — a typo can't silently no-op.
    validConfig();
  });
});

describe("REACT-03 rig config — GOTCHA C: learning is ENABLED (else the loop is byte-identical-OFF)", () => {
  it("memory.costFeatures.enabled is EXPLICITLY true (someLearningOn requires it; else recordOutboundMessage is undefined)", () => {
    // RAW-doc presence: the key must be WRITTEN, not just schema-defaulted —
    // this is the assertion that fails RED on the pre-edit builder.
    const memory = rawDoc()["memory"] as Record<string, unknown> | undefined;
    expect(memory, "memory block present").toBeDefined();
    const costFeatures = memory!["costFeatures"] as Record<string, unknown> | undefined;
    expect(costFeatures, "memory.costFeatures EXPLICITLY present in the rig config").toBeDefined();
    expect(costFeatures!["enabled"]).toBe(true);
    // And it validates to true through the real schema.
    expect(validConfig().memory.costFeatures.enabled).toBe(true);
  });

  it("agents.default.learningOutcome.enabled is EXPLICITLY true (gates the reaction observe)", () => {
    const learningOutcome = rawAgentDefault()["learningOutcome"] as Record<string, unknown> | undefined;
    expect(learningOutcome, "agents.default.learningOutcome EXPLICITLY present").toBeDefined();
    expect(learningOutcome!["enabled"]).toBe(true);
    expect(validConfig().agents["default"]!.learningOutcome.enabled).toBe(true);
  });

  it("agents.default.learningSkills.enabled is EXPLICITLY true (else synthesis never runs)", () => {
    const learningSkills = rawAgentDefault()["learningSkills"] as Record<string, unknown> | undefined;
    expect(learningSkills, "agents.default.learningSkills EXPLICITLY present").toBeDefined();
    expect(learningSkills!["enabled"]).toBe(true);
    expect(validConfig().agents["default"]!.learningSkills.enabled).toBe(true);
  });

  it("agents.default.learningTuning.enabled is EXPLICITLY true (the positive reward on resolve)", () => {
    const learningTuning = rawAgentDefault()["learningTuning"] as Record<string, unknown> | undefined;
    expect(learningTuning, "agents.default.learningTuning EXPLICITLY present").toBeDefined();
    expect(learningTuning!["enabled"]).toBe(true);
    expect(validConfig().agents["default"]!.learningTuning.enabled).toBe(true);
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
// MEDIA-02 / SEC-01 (Plan 207-05, Task 1) — the test-scoped SSRF-loopback
// allowance: a THIN `DaemonOverrides.setupMedia` wrapper that swaps ONLY
// `result.ssrfFetcher` for a loopback fetcher addressing BOTH SSRF blocks
// (Pitfall 1): (1) the resolver's HARDCODED `api.telegram.org` download URL
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

  it("STILL BLOCKS a non-loopback / non-emulator host (the override is loopback-ONLY, not an arbitrary-URL hole — T-207-12)", async () => {
    // A download URL whose host is NOT api.telegram.org (so no rewrite fires) and
    // resolves to a non-loopback range → the override's validateLocalServerUrl DENIES.
    const fetcher = buildLoopbackSsrfFetcher({ emulatorHost: "127.0.0.1:54321", maxBytes: 1_000_000 });
    const result = await fetcher.fetch("http://example.com/file/whatever.bin");
    expect(result.ok).toBe(false);
  });
});
