// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { inspect } from "node:util";
import { stableStringify } from "../../../test/support/stable-stringify.js";
import {
  hardenDataDirPermissions,
  applyInspectDefaultsForLogging,
  DEFAULT_CONFIG_PATHS,
  type DaemonInstance,
  type DaemonOverrides,
} from "./daemon.js";
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 43 parity protection: FILE-SPLIT-06 (daemon.ts composition-root split).
 *
 * These snapshots lock the byte-identical output of daemon.ts's public API
 * BEFORE the Phase 43 split refactor lands.
 *
 * The post-refactor behavior MUST match these snapshots exactly. Any byte
 * change FAILS this test, fails `pnpm test`, fails the per-commit gate.
 *
 * Captured: in the Phase 43 Wave 8c parity scaffold (Task 1 of 43-08c).
 * Subsequent split commit (Task 2 of 43-08c) must keep this test green.
 * Per FILE-SPLIT-17 + OQ-5 (progressive deletion), this file is DELETED in
 * the same atomic commit as the split (Task 2) once new structure is
 * verified byte-identical.
 *
 * @module
 */

describe("daemon parity (FILE-SPLIT-06)", () => {
  describe("public API surface", () => {
    it("daemon: exports the expected named symbols", () => {
      const importBag = {
        hardenDataDirPermissions,
        applyInspectDefaultsForLogging,
        DEFAULT_CONFIG_PATHS,
      };
      expect(stableStringify(Object.keys(importBag).sort())).toMatchSnapshot();
    });

    it("DaemonOverrides: interface key set is stable", () => {
      const witness: Record<keyof DaemonOverrides, true> = {
        bootstrap: true,
        setupSecrets: true,
        createTracingLogger: true,
        createLogLevelManager: true,
        createTokenTracker: true,
        createLatencyRecorder: true,
        createProcessMonitor: true,
        registerGracefulShutdown: true,
        startWatchdog: true,
        createGatewayServer: true,
        setupMedia: true,
        exit: true,
        preflightDoctor: true,
        timers: true,
      };
      expect(stableStringify(Object.keys(witness).sort())).toMatchSnapshot();
    });

    it("DaemonInstance: interface key set is stable", () => {
      // Construct a const witness whose keys mirror DaemonInstance. The
      // value `true` is a structural marker only; TypeScript enforces
      // that the keyof set matches exactly.
      const witness: Record<keyof DaemonInstance, true> = {
        container: true,
        logger: true,
        logLevelManager: true,
        tokenTracker: true,
        latencyRecorder: true,
        processMonitor: true,
        shutdownHandle: true,
        watchdogHandle: true,
        cronSchedulers: true,
        resetSchedulers: true,
        browserServices: true,
        heartbeatRunner: true,
        gatewayHandle: true,
        adapterRegistry: true,
        deliveryAdapters: true,
        deliveryQueue: true,
        backgroundTaskManager: true,
        rpcCall: true,
        deviceIdentity: true,
        diagnosticCollector: true,
        billingEstimator: true,
        channelActivityTracker: true,
        deliveryTracer: true,
        approvalGate: true,
        channelHealthMonitor: true,
        sessionStoreBridge: true,
      };
      expect(stableStringify(Object.keys(witness).sort())).toMatchSnapshot();
    });
  });

  describe("behavior matrix: pure helpers", () => {
    it("hardenDataDirPermissions: applies 0o700 to data dir when permissions are too open", () => {
      // Arrange: create a temp dir with 0o755 permissions.
      const dir = mkdtempSync(join(tmpdir(), "daemon-parity-"));
      try {
        chmodSync(dir, 0o755);
        // Act
        const corrections = hardenDataDirPermissions(dir);
        // Read post-correction mode for snapshot stability.
        const postMode = statSync(dir).mode & 0o777;
        const correctedFiles = corrections.map((c) => ({
          relPath: c.file === dir ? "<dir>" : c.file.replace(dir, "<dir>"),
          oldMode: `0o${c.oldMode.toString(8)}`,
          newMode: `0o${c.newMode.toString(8)}`,
        }));
        // Assert
        expect(
          stableStringify({
            correctedCount: corrections.length,
            corrected: correctedFiles,
            postMode: `0o${postMode.toString(8)}`,
          }),
        ).toMatchSnapshot();
      } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    it("hardenDataDirPermissions: applies 0o600 to known sensitive files when modes are too open", () => {
      const dir = mkdtempSync(join(tmpdir(), "daemon-parity-"));
      try {
        chmodSync(dir, 0o700);
        const sensitive = join(dir, "config.yaml");
        writeFileSync(sensitive, "noop: true\n");
        chmodSync(sensitive, 0o644);
        const corrections = hardenDataDirPermissions(dir);
        const correctedFiles = corrections.map((c) => ({
          relPath: c.file === dir ? "<dir>" : c.file.replace(dir, "<dir>"),
          oldMode: `0o${c.oldMode.toString(8)}`,
          newMode: `0o${c.newMode.toString(8)}`,
        }));
        expect(
          stableStringify({
            correctedCount: corrections.length,
            corrected: correctedFiles,
          }),
        ).toMatchSnapshot();
      } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    it("applyInspectDefaultsForLogging: returns false flags when ANTHROPIC_LOG is unset", () => {
      // Snapshot known stable inputs only. Save and restore inspect defaults
      // so this test is hermetic with respect to other tests in the file.
      const savedDepth = inspect.defaultOptions.depth;
      const savedBreak = inspect.defaultOptions.breakLength;
      try {
        const result = applyInspectDefaultsForLogging({});
        expect(stableStringify(result)).toMatchSnapshot();
      } finally {
        inspect.defaultOptions.depth = savedDepth;
        inspect.defaultOptions.breakLength = savedBreak;
      }
    });

    it("applyInspectDefaultsForLogging: returns true flags when ANTHROPIC_LOG=debug and prior defaults differ", () => {
      const savedDepth = inspect.defaultOptions.depth;
      const savedBreak = inspect.defaultOptions.breakLength;
      try {
        inspect.defaultOptions.depth = 2;
        inspect.defaultOptions.breakLength = 80;
        const result = applyInspectDefaultsForLogging({ ANTHROPIC_LOG: "debug" });
        expect(stableStringify(result)).toMatchSnapshot();
      } finally {
        inspect.defaultOptions.depth = savedDepth;
        inspect.defaultOptions.breakLength = savedBreak;
      }
    });

    it("applyInspectDefaultsForLogging: returns false flags when ANTHROPIC_LOG=warn (does not trigger)", () => {
      const savedDepth = inspect.defaultOptions.depth;
      const savedBreak = inspect.defaultOptions.breakLength;
      try {
        inspect.defaultOptions.depth = 2;
        inspect.defaultOptions.breakLength = 80;
        const result = applyInspectDefaultsForLogging({ ANTHROPIC_LOG: "warn" });
        expect(stableStringify(result)).toMatchSnapshot();
      } finally {
        inspect.defaultOptions.depth = savedDepth;
        inspect.defaultOptions.breakLength = savedBreak;
      }
    });

    it("DEFAULT_CONFIG_PATHS: structural shape", () => {
      // Snapshot only the structural shape (count + suffixes), not the
      // absolute home-directory paths (which differ across machines).
      const shape = {
        count: DEFAULT_CONFIG_PATHS.length,
        suffixes: DEFAULT_CONFIG_PATHS.map((p) => {
          const lastSlash = p.lastIndexOf("/");
          return lastSlash >= 0 ? p.slice(lastSlash + 1) : p;
        }),
      };
      expect(stableStringify(shape)).toMatchSnapshot();
    });
  });
});
