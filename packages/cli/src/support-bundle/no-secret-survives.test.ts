// SPDX-License-Identifier: Apache-2.0
/**
 * No-secret-survives contract test — the mandatory failure-mode gate.
 *
 * Seeds a temp `~/.comis`-shaped data dir whose config carries every known
 * secret shape IN CONFIG VALUES under real, parseable schema sections
 * (gateway, security, providers), generates a real bundle offline, then
 * enumerates EVERY written file (readdir — so a newly-added output cannot
 * silently escape the grep) and asserts not one seeded secret survives verbatim
 * in any of them, explicitly including `fleet.json` and `config-posture.json`.
 *
 * `config-posture.json` is the load-bearing subject. It rides the writer's
 * trusted-leaf path (path-token substitution only — no value-shape masking), so
 * its ONLY defense against leaking a config value is that it is built from the
 * raw top-level section NAMES, never the values. This suite is the sole proof of
 * that property: it plants a distinct secret under each section, confirms a naive
 * membership digest that dumped the config VALUES would surface every one of them
 * (the real regression it guards), then asserts the produced digest lists the
 * section NAMES while masking every value. Regress the digest to emit values and
 * this test fails loudly.
 *
 * The remaining value that ever LEAVES the config is the url-userinfo credential
 * planted in the gateway host: the gateway check echoes the configured URL —
 * credential and all — into `doctor.json`, so that seed genuinely reaches a
 * written file, where the writer's value-shape redaction pass masks it. The
 * redaction-sentinel assertion pins that the pass ran; every other seeded value
 * lives only in the raw config the digests never echo.
 *
 * The fleet assembler is injected with a hermetic empty-report fixture so the
 * sweep never loads the runtime graph the offline seam dynamic-imports. This does
 * NOT narrow the contract: the seeds live in config VALUES, `fleet.json` reads the
 * observability store and never the config (so no config seed could reach it, real
 * or stubbed), and `config-posture.json` is built from the REAL config resolution
 * regardless of the fleet stub — so both trusted-leaf files are still swept
 * against every seed.
 *
 * The gateway host resolves to loopback, so the connectivity probe stays local
 * (fast, no external network). Temp dirs ONLY — never the real ~/.comis. All
 * seed values are neutral fakes.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";

import { safePath } from "@comis/core";
import type { FleetHealthReport } from "@comis/core";

import { generateSupportBundle } from "./generate.js";

/**
 * Every known secret shape as a neutral fake, each planted in a config VALUE
 * under a real schema section so the section NAME (never the value) lands in
 * config-posture.json. `URL_USERINFO` additionally flows into doctor.json via
 * the gateway host, where the value-shape pass masks it.
 */
const OPENAI_KEY = "sk-test00000000000000000000000000000000000000abcd";
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.t0ken_signature_0123456789abcdef";
const BEARER = "Bearer aXbYcZ0123456789abcdefghij";
const URL_USERINFO = "user:pass@127.0.0.1";
const REGISTERED = "test-secret-canary-9f8e7d6c5b4a3210";

/** Every seed, for the zero-survivors sweep across the written files. */
const ALL_SEEDS = [OPENAI_KEY, AWS_KEY, JWT, BEARER, URL_USERINFO, REGISTERED];

/**
 * The top-level section names the seeded config wrote. config-posture.json must
 * report each as present (membership) while masking the values they held.
 */
const SEEDED_SECTIONS = ["gateway", "security", "providers"];

/** A fixed generation instant so the run is deterministic. */
const NOW_MS = Date.UTC(2026, 6, 3, 10, 15, 0);

/** Report the daemon as down so the host snapshot opens no socket. */
const daemonDown = { isDaemonRunning: async (): Promise<boolean> => false };

/**
 * A hermetic empty-window fleet report — the shape the offline assembler returns
 * against a data dir with no `memory.db`. Injected so the sweep never loads the
 * daemon graph; fleet.json is content-free by construction, so an empty report
 * suffices to prove no config seed reaches it.
 */
function emptyFleet(): FleetHealthReport {
  return {
    schemaVersion: 1,
    windowHours: 24,
    sessions: { total: 0, degraded: 0, degradedRate: 0 },
    topErrorKinds: [],
    degradedByCause: {},
    breakerTripTotal: 0,
    toolStats: {},
    cost: { costUsd: 0, totalTokens: 0 },
    activity: {
      activeAgents: [],
      activeChannels: [],
      exitReasons: {},
      turnTotal: 0,
      tokenTotal: 0,
    },
    findings: [],
    likelyRootCause: null,
    suggestedNextSteps: [],
    truncations: [],
    coverage: {
      sessionSummary: { found: false, rows: 0 },
      sessionIndex: { daysRead: 0, daysMissing: 0 },
      billing: { present: false },
    },
  };
}

const tmpDirs: string[] = [];

function makeDataDir(): string {
  const dir = mkdtempSync(safePath(tmpdir(), "comis-nosecret-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort teardown; a leaked temp dir must never fail the suite.
    }
  }
});

/**
 * Write a valid config that plants a distinct secret shape in a VALUE under each
 * of three real schema sections:
 *  - `gateway.host` carries the url-userinfo credential (loopback after the `@`,
 *    on an unused port so the probe fails fast) — the one seed that leaves the
 *    config, echoed into doctor.json and masked there.
 *  - `security.permission.{allowedNetHosts,allowedFsPaths}` carry the AWS key,
 *    JWT, and registered canary — free-form string arrays no check echoes.
 *  - `providers.entries.<id>.{apiKeyName,headers}` carry the OpenAI key and the
 *    bearer token — provider values no check echoes.
 * The config PARSES, so config-posture.json is written and its section list
 * includes gateway/security/providers by name.
 */
function writeSeededConfig(dataDir: string): string {
  const body =
    "gateway:\n" +
    `  host: "${URL_USERINFO}"\n` +
    "  port: 59237\n" +
    "security:\n" +
    "  permission:\n" +
    "    allowedNetHosts:\n" +
    `      - "${AWS_KEY}"\n` +
    `      - "${JWT}"\n` +
    "    allowedFsPaths:\n" +
    `      - "${REGISTERED}"\n` +
    "providers:\n" +
    "  entries:\n" +
    "    openai-main:\n" +
    '      type: "openai"\n' +
    `      apiKeyName: "${OPENAI_KEY}"\n` +
    "      headers:\n" +
    `        authorization: "${BEARER}"\n`;
  const path = safePath(dataDir, "config.yaml");
  writeFileSync(path, body, "utf8");
  return path;
}

describe("no seeded secret survives any support-bundle output file", () => {
  it("sweeps every written bundle file — including fleet.json and config-posture.json — for surviving seeds", async () => {
    const dataDir = makeDataDir();
    const configPath = writeSeededConfig(dataDir);

    const result = await generateSupportBundle({
      dataDir,
      configPaths: [configPath],
      sinceHours: 24,
      nowMs: NOW_MS,
      isDaemonRunning: daemonDown.isDaemonRunning,
      assembleFleet: async () => emptyFleet(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Enumerate every file the writer produced — a new output file cannot escape.
    const files = readdirSync(result.value.bundleDir);
    expect(files.length).toBeGreaterThan(0);

    // The two trusted-leaf files (no value-shape backstop) are explicitly in the
    // sweep set, so neither can silently drop out of coverage.
    expect(files, "fleet.json must be present in the sweep").toContain("fleet.json");
    expect(files, "config-posture.json must be present in the sweep").toContain(
      "config-posture.json",
    );

    for (const file of files) {
      const content = readFileSync(safePath(result.value.bundleDir, file), "utf8");
      for (const seed of ALL_SEEDS) {
        expect(content, `${seed} survived in ${file}`).not.toContain(seed);
      }
    }
  });

  it("masks the url-userinfo credential that reaches doctor.json with the value-shape sentinel", async () => {
    const dataDir = makeDataDir();
    const configPath = writeSeededConfig(dataDir);

    const result = await generateSupportBundle({
      dataDir,
      configPaths: [configPath],
      sinceHours: 24,
      nowMs: NOW_MS,
      isDaemonRunning: daemonDown.isDaemonRunning,
      assembleFleet: async () => emptyFleet(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The gateway check echoed the configured URL — credential and all — into
    // doctor.json; the sentinel proves the redaction pass ran (the raw
    // credential would be here without it).
    const doctorJson = readFileSync(safePath(result.value.bundleDir, "doctor.json"), "utf8");
    expect(doctorJson).toContain("<REDACTED:url-userinfo>");
    expect(doctorJson).not.toContain(URL_USERINFO);
    expect(doctorJson).not.toContain("user:pass");
  });

  it("lists the seeded config section names in config-posture.json while masking every secret value", async () => {
    const dataDir = makeDataDir();
    const configPath = writeSeededConfig(dataDir);

    // A naive membership digest that dumped config VALUES (not just section
    // names) would surface every seed — the exact regression this file guards.
    // Serializing the parsed raw config is that naive dump; it proves each seed
    // genuinely rides a config VALUE a value-emitting implementation would leak.
    const naiveValueDump = JSON.stringify(parseYaml(readFileSync(configPath, "utf8")));
    for (const seed of ALL_SEEDS) {
      expect(naiveValueDump, `${seed} must ride a config value a naive dump would leak`).toContain(
        seed,
      );
    }

    const result = await generateSupportBundle({
      dataDir,
      configPaths: [configPath],
      sinceHours: 24,
      nowMs: NOW_MS,
      isDaemonRunning: daemonDown.isDaemonRunning,
      assembleFleet: async () => emptyFleet(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const configPostureJson = readFileSync(
      safePath(result.value.bundleDir, "config-posture.json"),
      "utf8",
    );

    // Membership present: the section NAMES whose values held secrets appear.
    for (const section of SEEDED_SECTIONS) {
      expect(configPostureJson, `section name ${section} must be present`).toContain(section);
    }

    // Values absent: not one seeded value survives in the trusted-leaf digest —
    // its sole guarantee, since the writer applies no value-shape mask here.
    for (const seed of ALL_SEEDS) {
      expect(configPostureJson, `${seed} survived in config-posture.json`).not.toContain(seed);
    }
  });
});
