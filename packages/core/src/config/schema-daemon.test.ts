// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { DaemonConfigSchema } from "./schema-daemon.js";

describe("DaemonConfigSchema", () => {
  describe("logging sub-schema", () => {
    it("provides defaults for all logging fields when daemon is empty", () => {
      const result = DaemonConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        // Redact fields (redactSensitive / redactMinLength /
        // redactKeepStart / redactKeepEnd) join the canonical defaults
        // alongside the existing rotation knobs. `redactPatterns` is
        // optional (z.array(string).optional()) and stays absent when
        // not supplied.
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
          redactSensitive: "tools",
          redactMinLength: 18,
          redactKeepStart: 6,
          redactKeepEnd: 4,
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

  describe("redact fields", () => {
    it("redactSensitive defaults to 'tools'", () => {
      const result = DaemonConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.logging.redactSensitive).toBe("tools");
      }
    });

    it("accepts redactSensitive='off' for residency-test harness", () => {
      const result = DaemonConfigSchema.safeParse({
        logging: { redactSensitive: "off" },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.logging.redactSensitive).toBe("off");
      }
    });

    it("rejects unknown values for redactSensitive (closed enum)", () => {
      const result = DaemonConfigSchema.safeParse({
        logging: { redactSensitive: "everything" },
      });
      expect(result.success).toBe(false);
    });

    it("accepts an array of pattern strings for redactPatterns", () => {
      const result = DaemonConfigSchema.safeParse({
        logging: { redactPatterns: ["custom-token-[0-9]+"] },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.logging.redactPatterns).toEqual(["custom-token-[0-9]+"]);
      }
    });

    it("rejects non-array redactPatterns", () => {
      const result = DaemonConfigSchema.safeParse({
        logging: { redactPatterns: "single-string" },
      });
      expect(result.success).toBe(false);
    });

    it("redactMinLength defaults to 18 and rejects values below 8", () => {
      const ok = DaemonConfigSchema.safeParse({});
      expect(ok.success).toBe(true);
      if (ok.success) {
        expect(ok.data.logging.redactMinLength).toBe(18);
      }

      const tooLow = DaemonConfigSchema.safeParse({
        logging: { redactMinLength: 7 },
      });
      expect(tooLow.success).toBe(false);

      const nonInt = DaemonConfigSchema.safeParse({
        logging: { redactMinLength: 18.5 },
      });
      expect(nonInt.success).toBe(false);
    });

    it("redactKeepStart defaults to 6 with bounds [0, 12]", () => {
      const ok = DaemonConfigSchema.safeParse({});
      expect(ok.success).toBe(true);
      if (ok.success) {
        expect(ok.data.logging.redactKeepStart).toBe(6);
      }

      const negative = DaemonConfigSchema.safeParse({
        logging: { redactKeepStart: -1 },
      });
      expect(negative.success).toBe(false);

      const tooHigh = DaemonConfigSchema.safeParse({
        logging: { redactKeepStart: 13 },
      });
      expect(tooHigh.success).toBe(false);

      const upperBound = DaemonConfigSchema.safeParse({
        logging: { redactKeepStart: 12 },
      });
      expect(upperBound.success).toBe(true);
    });

    it("redactKeepEnd defaults to 4 with bounds [0, 12]", () => {
      const ok = DaemonConfigSchema.safeParse({});
      expect(ok.success).toBe(true);
      if (ok.success) {
        expect(ok.data.logging.redactKeepEnd).toBe(4);
      }

      const zero = DaemonConfigSchema.safeParse({
        logging: { redactKeepEnd: 0 },
      });
      expect(zero.success).toBe(true);

      const tooHigh = DaemonConfigSchema.safeParse({
        logging: { redactKeepEnd: 13 },
      });
      expect(tooHigh.success).toBe(false);
    });
  });

  describe("active daemon runtime fields", () => {
    it("keeps runtime defaults without unused systemd watchdog controls", () => {
      const result = DaemonConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.shutdownTimeoutMs).toBe(30_000);
        expect(result.data.metricsIntervalMs).toBe(30_000);
        expect(result.data.logLevels).toEqual({});
        expect(result.data.logging).toBeDefined();
        expect(result.data).not.toHaveProperty("watchdogIntervalMs");
        expect(result.data).not.toHaveProperty("eventLoopDelayThresholdMs");
      }

      expect(
        DaemonConfigSchema.safeParse({ watchdogIntervalMs: 30_000 }).success,
      ).toBe(false);
      expect(
        DaemonConfigSchema.safeParse({ eventLoopDelayThresholdMs: 500 }).success,
      ).toBe(false);
    });
  });
});
