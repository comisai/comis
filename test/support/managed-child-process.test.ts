// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { stopManagedChild } from "./managed-child-process.js";

describe("managed child process shutdown", () => {
  it("waits for forced child exit before resolving shutdown", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
    ], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await once(child.stdout!, "data");
      await stopManagedChild(child, { gracefulTimeoutMs: 20, forcedTimeoutMs: 2_000 });
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(child.signalCode).toBe("SIGKILL");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});
