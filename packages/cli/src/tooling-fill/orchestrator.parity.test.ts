// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { stableStringify } from "../../../../test/support/stable-stringify.js";
import {
  runToolingFill,
  type OrchestratorOpts,
  type OrchestratorResult,
  type PromptIO,
} from "./orchestrator.js";

/**
 * Phase 43 parity protection for FILE-SPLIT-10.
 *
 * Locks the byte-identical structural surface of tooling-fill/orchestrator.ts
 * BEFORE the Phase 43 split refactor lands (Plan 43-05, Task 1). Post-split
 * (Task 2) the same module surface must reproduce these snapshots byte-identical.
 *
 * Runtime behavior (state-machine ordering, rollback paths, agent-call retry
 * semantics, daemon stop+start lifecycle, idempotency refusal, --all partial
 * success, env-ref expansion, etc.) is covered by:
 *   - packages/cli/src/tooling-fill/orchestrator.test.ts (15+ it-blocks
 *     against mocked boundary helpers)
 *   - packages/cli/src/tooling-fill/orchestrator-branches.test.ts (15+
 *     branch-coverage it-blocks for error and rollback paths)
 *
 * This snapshot scope is LIMITED to structural surface (no factory invocation —
 * runToolingFill is an async pipeline that requires heavy boundary mocks to
 * run; the existing orchestrator.test.ts + orchestrator-branches.test.ts
 * already exercise every public path with full mock infrastructure):
 *   (a) public exported symbol names
 *   (b) runToolingFill's typeof signature
 *   (c) PromptIO interface method-name shape (constructed as a value via the
 *       interface's documented contract; serialized as keys for byte-identity)
 *
 * Per FILE-SPLIT-17 + Phase 42 OQ-5 (progressive deletion), this file +
 * its `__snapshots__/` neighbor are DELETED in the same commit as the
 * source-file split (Task 2) once the post-split modules reproduce the
 * structural snapshots byte-identical and the existing orchestrator.test.ts
 * + orchestrator-branches.test.ts prove out against the new barrel.
 */

describe("tooling-fill orchestrator parity (FILE-SPLIT-10)", () => {
  describe("public API surface", () => {
    it("exports the expected named symbols", () => {
      // Surface exported as VALUE symbols from orchestrator.ts.
      // PromptIO, OrchestratorOpts, OrchestratorResult are TYPE exports
      // (`export interface` / `export type`); captured as type-only in the
      // typeof matrix below; they do not appear as value-keys here.
      const exports = {
        runToolingFill,
      };
      expect(stableStringify(Object.keys(exports).sort())).toMatchSnapshot();
    });
  });

  describe("behavior matrix: representative structural inputs", () => {
    it("runToolingFill: exposes the expected async-function typeof signature", () => {
      const shape = {
        typeof: typeof runToolingFill,
        isAsyncFn:
          runToolingFill.constructor.name === "AsyncFunction" ||
          runToolingFill.toString().startsWith("async "),
        length: runToolingFill.length,
        name: runToolingFill.name,
      };
      expect(stableStringify(shape)).toMatchSnapshot();
    });

    it("PromptIO: minimal-conforming value exposes the expected method-name shape", () => {
      // Construct a minimal value that satisfies the PromptIO interface;
      // serializing the keys+typeofs proves the interface shape is locked.
      const minimalPromptIO: PromptIO = {
        confirmValues: async () => true,
        confirmRestart: async () => true,
      };
      const shape: Record<string, string> = {};
      for (const k of Object.keys(minimalPromptIO).sort()) {
        shape[k] = typeof (minimalPromptIO as unknown as Record<string, unknown>)[
          k
        ];
      }
      expect(stableStringify(shape)).toMatchSnapshot();
    });

    it("OrchestratorOpts: minimal-conforming value exposes the expected field-name shape", () => {
      // Construct a minimal value that satisfies the OrchestratorOpts
      // interface (every field present; this proves the interface shape is
      // locked even if optional fields are present-as-undefined). Sorted
      // keys + typeofs snapshot the structural surface.
      const minimalOpts: OrchestratorOpts = {
        hintName: undefined,
        all: false,
        force: false,
        forceNoValidate: false,
        dryRun: false,
        yes: false,
        restart: undefined,
        restartCmd: undefined,
        configPath: "/tmp/config.yaml",
        homeDir: "/tmp",
        kindHint: undefined,
        agentId: undefined,
        isTty: false,
        prompts: {
          confirmValues: async () => true,
          confirmRestart: async () => true,
        },
        clock: () => new Date(0),
      };
      const shape: Record<string, string> = {};
      for (const k of Object.keys(minimalOpts).sort()) {
        shape[k] = typeof (minimalOpts as unknown as Record<string, unknown>)[
          k
        ];
      }
      expect(stableStringify(shape)).toMatchSnapshot();
    });

    it("OrchestratorResult: minimal-conforming value exposes the expected field-name shape", () => {
      const minimalResult: OrchestratorResult = {
        exitCode: 0,
        summary: "ok",
      };
      const shape: Record<string, string> = {};
      for (const k of Object.keys(minimalResult).sort()) {
        shape[k] = typeof (
          minimalResult as unknown as Record<string, unknown>
        )[k];
      }
      expect(stableStringify(shape)).toMatchSnapshot();
    });
  });
});
