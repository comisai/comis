// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";

describe("daemon config-posture composition", () => {
  let handle: TestDaemonHandle;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = mkdtempSync(resolve(tmpdir(), "comis-config-posture-"));
    const baseConfigPath = resolve(
      import.meta.dirname,
      "../config/config.test-daemon-lifecycle.yaml",
    );
    const baseConfig = readFileSync(baseConfigPath, "utf8");
    const relaxedConfig = baseConfig
      .replace(
        "    rag:\n      enabled: false",
        [
          "    skills:",
          "      execSandbox:",
          '        enabled: "never"',
          "    rag:",
          "      enabled: false",
        ].join("\n"),
      )
      .replace("port: 8457", "port: 18457")
      .replace(
        'dbPath: "test-memory-daemon-lifecycle.db"',
        'dbPath: "test-memory-config-posture.db"',
      );
    expect(relaxedConfig).not.toBe(baseConfig);

    const configPath = resolve(fixtureDir, "config.yaml");
    writeFileSync(configPath, relaxedConfig);
    handle = await startTestDaemon({ configPath });
  }, 60_000);

  afterAll(async () => {
    if (handle) await handle.cleanup();
    rmSync(fixtureDir, { recursive: true, force: true });
  }, 30_000);

  it("surfaces an agent exec-sandbox relaxation through system health", async () => {
    const report = await handle.daemon.rpcCall("obs.system.health", {
      sinceHours: 1,
      _trustLevel: "admin",
    }) as {
      findings: Array<{ code: string; detail?: string }>;
    };
    const posture = report.findings.find((finding) => finding.code === "config_posture");

    expect(posture?.detail).toMatch(/skills\.execSandbox\.enabled.*never/u);
  });
});
