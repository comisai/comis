import { describe, it, expect } from "vitest";
import { DaemonConfigSchema } from "./schema-daemon.js";

describe("DaemonConfigSchema", () => {
  describe("logging sub-schema", () => {
    it("provides defaults for all logging fields when daemon is empty", () => {
      const result = DaemonConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.logging).toEqual({
          filePath: "~/.comis/logs/daemon.log",
          maxSize: "10m",
          maxFiles: 5,
          compress: false,
          tracing: {
            outputDir: "~/.comis/traces",
            maxSize: "5m",
            maxFiles: 3,
          },
        });
      }
    });

    it("accepts valid logging overrides", () => {
      const result = DaemonConfigSchema.safeParse({
        logging: {
          filePath: "/var/log/comis/daemon.log",
          maxSize: "50m",
          maxFiles: 10,
          compress: true,
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.logging.filePath).toBe("/var/log/comis/daemon.log");
        expect(result.data.logging.maxSize).toBe("50m");
        expect(result.data.logging.maxFiles).toBe(10);
        expect(result.data.logging.compress).toBe(true);
      }
    });

    it("accepts maxSize with various valid suffixes", () => {
      for (const size of ["100", "10k", "10K", "50m", "50M", "1g", "1G"]) {
        const result = DaemonConfigSchema.safeParse({ logging: { maxSize: size } });
        expect(result.success).toBe(true);
      }
    });

    it("rejects negative maxFiles", () => {
      const result = DaemonConfigSchema.safeParse({ logging: { maxFiles: -1 } });
      expect(result.success).toBe(false);
    });

    it("rejects maxFiles exceeding 100", () => {
      const result = DaemonConfigSchema.safeParse({ logging: { maxFiles: 101 } });
      expect(result.success).toBe(false);
    });

    it("rejects non-integer maxFiles", () => {
      const result = DaemonConfigSchema.safeParse({ logging: { maxFiles: 2.5 } });
      expect(result.success).toBe(false);
    });

    it("rejects non-string filePath", () => {
      const result = DaemonConfigSchema.safeParse({ logging: { filePath: 123 } });
      expect(result.success).toBe(false);
    });

    it("rejects invalid maxSize format", () => {
      for (const bad of ["banana", "10mb", "1.5g", "m10", ""]) {
        const result = DaemonConfigSchema.safeParse({ logging: { maxSize: bad } });
        expect(result.success).toBe(false);
      }
    });

    it("rejects non-boolean compress", () => {
      const result = DaemonConfigSchema.safeParse({ logging: { compress: "yes" } });
      expect(result.success).toBe(false);
    });

    it("rejects unknown keys in logging (strictObject)", () => {
      const result = DaemonConfigSchema.safeParse({ logging: { unknownKey: "value" } });
      expect(result.success).toBe(false);
    });

    it("allows partial logging overrides with defaults for rest", () => {
      const result = DaemonConfigSchema.safeParse({ logging: { maxFiles: 20 } });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.logging.maxFiles).toBe(20);
        expect(result.data.logging.filePath).toBe("~/.comis/logs/daemon.log");
        expect(result.data.logging.maxSize).toBe("10m");
        expect(result.data.logging.compress).toBe(false);
      }
    });

    it("allows maxFiles of 0 (disable retention)", () => {
      const result = DaemonConfigSchema.safeParse({ logging: { maxFiles: 0 } });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.logging.maxFiles).toBe(0);
      }
    });
  });

  describe("existing daemon fields preserved", () => {
    it("preserves existing defaults alongside logging", () => {
      const result = DaemonConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.watchdogIntervalMs).toBe(30_000);
        expect(result.data.shutdownTimeoutMs).toBe(30_000);
        expect(result.data.metricsIntervalMs).toBe(30_000);
        expect(result.data.eventLoopDelayThresholdMs).toBe(500);
        expect(result.data.logLevels).toEqual({});
        expect(result.data.logging).toBeDefined();
      }
    });
  });
});
