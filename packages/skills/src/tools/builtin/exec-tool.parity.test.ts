// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { stableStringify } from "../../../../../test/support/stable-stringify.js";
import {
  createExecTool,
  killTree,
  buildSpawnCommand,
  buildInstallDetourHint,
  type ExecToolDeps,
} from "./exec-tool.js";
import { createProcessRegistry } from "./process-registry.js";
import { createSecretManager } from "@comis/core";
import { createCapabilityPortStub } from "../../../../core/src/ports/__test-helpers/tool-capability-stub.js";
import { tmpdir } from "node:os";

/**
 * Phase 43 parity protection — FILE-SPLIT-02.
 *
 * Locks the byte-identical output of `exec-tool.ts`'s public-API
 * functions BEFORE the Phase 43 split refactor lands. Post-refactor
 * behavior MUST match these snapshots exactly. Any byte change fails
 * the per-commit gate.
 *
 * Per FILE-SPLIT-17 + OQ-5 (progressive deletion), this file is DELETED
 * in the same commit as the source-file split, once each new module has
 * ≥1 independent behavior test per leaf.
 */

describe("exec-tool parity (FILE-SPLIT-02)", () => {
  describe("public API surface", () => {
    it("exports the expected named symbols", () => {
      const exports = {
        createExecTool,
        killTree,
        buildSpawnCommand,
        buildInstallDetourHint,
      };
      expect(stableStringify(Object.keys(exports).sort())).toMatchSnapshot();
    });
  });

  describe("behavior matrix - representative inputs", () => {
    it("buildSpawnCommand: assembles argv for npm install", () => {
      const result = buildSpawnCommand(
        "npm install",
        "/workspace",
        undefined,
        "/workspace",
        "/tmp/comis",
      );
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("buildSpawnCommand: assembles argv for raw interpreter command", () => {
      const result = buildSpawnCommand(
        "bash -c 'echo hello'",
        "/workspace",
        undefined,
        "/workspace",
        "/tmp/comis",
      );
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("buildSpawnCommand: wraps with python pty when pty=true", () => {
      const result = buildSpawnCommand(
        "ls -la",
        "/workspace",
        undefined,
        "/workspace",
        "/tmp/comis",
        true,
      );
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("buildInstallDetourHint: produces hint for advise mode overlap", () => {
      const result = buildInstallDetourHint({
        packageManager: "pip",
        commandDigest: "abc123",
        packages: ["yfinance"],
        overlaps: [
          {
            packageName: "yfinance",
            sourceType: "skill",
            sourceName: "yahoo-finance-skill",
            cluster: undefined,
            reason: "name-match",
          },
        ],
      });
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("buildInstallDetourHint: produces hint for mcp overlap with cluster", () => {
      const result = buildInstallDetourHint({
        packageManager: "npm",
        commandDigest: "def456",
        packages: ["@playwright/test"],
        overlaps: [
          {
            packageName: "@playwright/test",
            sourceType: "mcp",
            sourceName: "playwright-mcp",
            cluster: "browser-automation",
            reason: "name-match",
          },
        ],
      });
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("createExecTool: factory returns object with execute method and expected keys", () => {
      const registry = createProcessRegistry();
      const deps: ExecToolDeps = {
        workspacePath: tmpdir(),
        registry,
        secretManager: createSecretManager({}),
        platformSecretNames: new Set<string>(),
        toolCapabilityPort: createCapabilityPortStub(),
      };
      const tool = createExecTool(deps);
      // Snapshot the public shape — keys only (function bodies are not byte-stable
      // under reflection). Use only top-level keys present on the AgentTool.
      const surfaceKeys = Object.keys(tool).sort();
      expect(stableStringify(surfaceKeys)).toMatchSnapshot();
      // Also snapshot static descriptor metadata that should NOT drift.
      expect(
        stableStringify({
          name: tool.name,
          label: tool.label,
          descriptionPrefix: tool.description.slice(0, 64),
        }),
      ).toMatchSnapshot();
      void registry.cleanup();
    });
  });
});
