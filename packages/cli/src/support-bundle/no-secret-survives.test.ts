// SPDX-License-Identifier: Apache-2.0
/**
 * No-secret-survives contract test — the mandatory failure-mode gate.
 *
 * Seeds a temp `~/.comis`-shaped data dir whose config carries every known
 * secret shape, generates a real bundle offline, then enumerates EVERY written
 * file (readdir — so a newly-added output cannot silently escape the grep) and
 * asserts not one seeded secret survives verbatim in any of them.
 *
 * Two defenses are proven together. Most seeds ride in valid config string
 * fields as content-free-by-construction inputs the doctor digests never echo,
 * so they simply never leave the raw config. The lone exception is the
 * url-userinfo credential planted in the gateway host: the gateway check echoes
 * the configured URL — credential and all — into `doctor.json`, so that seed
 * genuinely reaches a written file. That makes the writer's redaction pass
 * load-bearing here — remove it and the raw `user:pass@` credential would
 * survive. The redaction-sentinel assertion pins that the pass ran; a file
 * written outside the redacting writer would surface in the readdir grep.
 *
 * The fleet assembler is injected with a hermetic empty-report fixture so the
 * sweep never loads the @comis/daemon runtime graph the offline seam dynamic-
 * imports. This does NOT narrow the contract: the seeds live in config VALUES,
 * `fleet.json` reads the observability store and never the config (so no config
 * seed could reach it, real or stubbed), and `config-posture.json` is built from
 * the REAL config resolution regardless of the fleet stub — so both new files
 * are still swept against every seed.
 *
 * The gateway host resolves to loopback, so the connectivity probe stays local
 * (fast, no external network). Temp dirs ONLY — never the real ~/.comis. All
 * seed values are neutral fakes.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { safePath } from "@comis/core";
import type { FleetHealthReport } from "@comis/core";

import { generateSupportBundle } from "./generate.js";

/**
 * Every known secret shape as a neutral fake. `URL_USERINFO` is planted in the
 * gateway host so it flows into a written file; the rest ride in a valid string
 * field where the content-free digests never surface them.
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

/** A fixed generation instant so the run is deterministic. */
const NOW_MS = Date.UTC(2026, 6, 3, 10, 15, 0);

/** Report the daemon as down so the host snapshot opens no socket. */
const daemonDown = { isDaemonRunning: async (): Promise<boolean> => false };

/**
 * A hermetic empty-window fleet report — the shape the offline assembler returns
 * against a data dir with no `memory.db`. Injected so the sweep never loads the
 * @comis/daemon graph; fleet.json is content-free by construction, so an empty
 * report suffices to prove no config seed reaches it.
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
 * Write a valid config seeded with every secret shape. The url-userinfo
 * credential rides in the gateway host (loopback after the `@`) so the gateway
 * check echoes it into a written file; the port is an unused loopback port so
 * the probe fails fast. The remaining shapes ride in the tenant id — a valid
 * string the content-free digests never echo.
 */
function writeSeededConfig(dataDir: string): string {
  const body =
    "gateway:\n" +
    `  host: "${URL_USERINFO}"\n` +
    "  port: 59237\n" +
    `tenantId: "${OPENAI_KEY} ${AWS_KEY} ${JWT} ${BEARER} ${REGISTERED}"\n`;
  const path = safePath(dataDir, "config.yaml");
  writeFileSync(path, body, "utf8");
  return path;
}

describe("no seeded secret survives any support-bundle output file", () => {
  it("masks or omits every secret shape across every written file", async () => {
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
});
