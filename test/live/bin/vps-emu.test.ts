// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

describe("standalone Telegram emulator", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("redacts the bot token from its startup banner", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "comis-vps-emu-banner-"));
    directories.push(directory);
    const wiringPath = resolve(directory, "emulator.json");
    const botToken = "987654321:test-banner-secret";
    const child = spawn(process.execPath, ["--import", "tsx", "test/live/bin/vps-emu.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, EMU_BOT_TOKEN: botToken, EMU_JSON: wiringPath },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    const banner = await new Promise<string>((resolveBanner, rejectBanner) => {
      const timeout = setTimeout(() => rejectBanner(new Error("emulator startup banner timed out")), 10_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        const line = stdout.split("\n").find((candidate) => candidate.startsWith("EMU_UP "));
        if (line !== undefined) {
          clearTimeout(timeout);
          resolveBanner(line);
        }
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        rejectBanner(error);
      });
      child.once("exit", (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout);
          rejectBanner(new Error(`emulator exited before startup with code ${code}`));
        }
      });
    });

    child.kill("SIGTERM");
    await new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));

    expect(banner).not.toContain(botToken);
    expect(JSON.parse(banner.slice("EMU_UP ".length))).toMatchObject({ botToken: "[REDACTED]" });
    expect(JSON.parse(readFileSync(wiringPath, "utf8"))).toMatchObject({ botToken });
  });
});
