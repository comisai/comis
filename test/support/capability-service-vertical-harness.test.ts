// SPDX-License-Identifier: Apache-2.0
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGoFixtureBinary,
  waitForUnixSocket,
} from "./capability-service-vertical-harness.js";

describe("capability-service vertical harness", () => {
  it("rejects a stale Unix socket instead of reporting service readiness", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "comis-stale-socket-"));
    const socketPath = join(scratch, "service.sock");
    const movedSocketPath = join(scratch, "moved.sock");
    const server = createServer();

    try {
      server.listen(socketPath);
      await once(server, "listening");
      renameSync(socketPath, movedSocketPath);
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error !== undefined) rejectClose(error);
          else resolveClose();
        });
      });
      renameSync(movedSocketPath, socketPath);
      expect(existsSync(socketPath)).toBe(true);

      await expect(waitForUnixSocket(socketPath, 100)).rejects.toThrow(`Unix socket ${socketPath}`);
    } finally {
      if (server.listening) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("names the missing Companion checkout and configuration knob", () => {
    const scratch = mkdtempSync(join(tmpdir(), "capability-fixture-builder-"));
    const outputDirectory = join(scratch, "bin");
    mkdirSync(outputDirectory, { mode: 0o700 });
    const missingRepository = join(scratch, "missing-companion-checkout");

    try {
      expect(() => buildGoFixtureBinary(
        missingRepository,
        outputDirectory,
        "devcrew-service",
      )).toThrow(
        `capability-service Go repository not found at ${missingRepository}; set COMIS_DEV_CREW_SOURCE to the absolute comis-dev-crew checkout path`,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
