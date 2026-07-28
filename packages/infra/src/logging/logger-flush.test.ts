// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ComisLogger } from "@comis/core";
import type { Result } from "@comis/shared";
import { createLogger } from "./logger.js";
import * as loggerModule from "./logger.js";

type FlushLoggerSync = (logger: ComisLogger) => Result<void, Error>;

describe("flushLoggerSync", () => {
  it("drains a production multi-target transport before returning", async () => {
    const flushLoggerSync = (
      loggerModule as unknown as { flushLoggerSync?: FlushLoggerSync }
    ).flushLoggerSync;
    expect(typeof flushLoggerSync).toBe("function");
    if (!flushLoggerSync) return;

    const tempDir = await mkdtemp(join(tmpdir(), "comis-logger-flush-"));
    const logFile = join(tempDir, "daemon.log");
    try {
      const logger = createLogger({
        name: "logger-flush-test",
        transport: {
          targets: [{
            target: "pino/file",
            options: { destination: logFile },
          }],
        },
      });
      logger.info({ boundary: "shutdown" }, "Final daemon log");

      const result = flushLoggerSync(logger);

      expect(result.ok).toBe(true);
      expect(await readFile(logFile, "utf8")).toContain("Final daemon log");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
