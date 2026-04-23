// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionKey } from "@comis/core";
import { createComisSessionManager } from "./comis-session-manager.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "comis-session-mgr-test-"));
}

function makeKey(channelId = "cron:test-job"): SessionKey {
  return { tenantId: "default", userId: "bot", channelId };
}

describe("destroySession", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
    dirs.length = 0;
  });

  it("removes empty channel directory after deleting JSONL", async () => {
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);

    const mgr = createComisSessionManager({ sessionBaseDir: baseDir, lockDir, workspaceDir: baseDir });
    const key = makeKey();

    // Simulate a session file
    const channelDir = join(baseDir, "default", "cron@3atest-job");
    mkdirSync(channelDir, { recursive: true });
    writeFileSync(join(channelDir, "bot.jsonl"), "{}");

    await mgr.destroySession(key);

    expect(existsSync(join(channelDir, "bot.jsonl"))).toBe(false);
    expect(existsSync(channelDir)).toBe(false);
  });

  it("preserves channel directory when other files remain", async () => {
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);

    const mgr = createComisSessionManager({ sessionBaseDir: baseDir, lockDir, workspaceDir: baseDir });
    const key = makeKey();

    const channelDir = join(baseDir, "default", "cron@3atest-job");
    mkdirSync(channelDir, { recursive: true });
    writeFileSync(join(channelDir, "bot.jsonl"), "{}");
    writeFileSync(join(channelDir, "other-user.jsonl"), "{}");

    await mgr.destroySession(key);

    expect(existsSync(join(channelDir, "bot.jsonl"))).toBe(false);
    expect(existsSync(channelDir)).toBe(true);
    expect(existsSync(join(channelDir, "other-user.jsonl"))).toBe(true);
  });

  it("does not throw when session file does not exist", async () => {
    const baseDir = makeTmpDir();
    const lockDir = makeTmpDir();
    dirs.push(baseDir, lockDir);

    const mgr = createComisSessionManager({ sessionBaseDir: baseDir, lockDir, workspaceDir: baseDir });
    const key = makeKey();

    await expect(mgr.destroySession(key)).resolves.not.toThrow();
  });
});
