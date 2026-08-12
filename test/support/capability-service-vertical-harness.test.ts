// SPDX-License-Identifier: Apache-2.0
import { once } from "node:events";
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { waitForUnixSocket } from "./capability-service-vertical-harness.js";

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
});
