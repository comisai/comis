// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { stableStringify } from "../../../../test/support/stable-stringify.js";
import {
  setupCrossSession,
  resolveGraphCacheRetention,
  SUB_AGENT_TOOL_DENYLIST,
  MIN_SUB_AGENT_STEPS,
  type CrossSessionResult,
} from "./setup-cross-session.js";

/**
 * Phase 43 parity protection: FILE-SPLIT-08 / FILE-SPLIT-17.
 *
 * Snapshots lock the pre-split public surface of setup-cross-session.ts
 * (the 937L wiring monolith) BEFORE the 43-08b subdirectory split lands.
 *
 * Scope is structural plus pure-helper invocations: wiring is a
 * composition root, so running setupCrossSession() requires a real
 * AppContainer plus session store, channel adapters, and executor
 * pipeline. The snapshots cover:
 *   1. Symbol export shape (Object.keys of the import bag).
 *   2. Pure constant exports (SUB_AGENT_TOOL_DENYLIST, MIN_SUB_AGENT_STEPS).
 *   3. Pure helper behavior (resolveGraphCacheRetention).
 *   4. Type-level witnesses (CrossSessionResult interface key set).
 *
 * The post-split behavior MUST match these snapshots exactly. Any byte
 * change to the public surface FAILS this test (which runs in CI via
 * `pnpm test`).
 *
 * Captured: Phase 43 Wave 8 sub-plan 43-08a. The 4 atomic wiring splits
 * (43-08b) run this test against byte-identical replay, then delete it per
 * OQ-5 (progressive deletion at end-of-wave).
 */

function typeKeys<T extends Record<string, unknown>>(witness: T): string[] {
  return Object.keys(witness).sort();
}

describe("setup-cross-session parity (FILE-SPLIT-08)", () => {
  describe("public API surface", () => {
    it("exports the expected named symbols", () => {
      const exports = {
        setupCrossSession,
        resolveGraphCacheRetention,
        SUB_AGENT_TOOL_DENYLIST,
        MIN_SUB_AGENT_STEPS,
      };
      expect(stableStringify(Object.keys(exports).sort())).toMatchSnapshot();
    });
  });

  describe("constant exports", () => {
    it("SUB_AGENT_TOOL_DENYLIST: stable membership list", () => {
      // Snapshot the sorted denylist contents. The set is a SIGUSR2
      // safety boundary; adding or removing entries is a behavior
      // change that the post-split commit MUST preserve byte-identical.
      expect(stableStringify(Array.from(SUB_AGENT_TOOL_DENYLIST).sort())).toMatchSnapshot();
    });

    it("MIN_SUB_AGENT_STEPS: stable floor value", () => {
      expect(stableStringify(MIN_SUB_AGENT_STEPS)).toMatchSnapshot();
    });
  });

  describe("resolveGraphCacheRetention behavior matrix", () => {
    it("resolveGraphCacheRetention: returns short when isLeafNode is true", () => {
      expect(stableStringify(resolveGraphCacheRetention(0, true))).toMatchSnapshot();
    });

    it("resolveGraphCacheRetention: returns long when isLeafNode is false", () => {
      expect(stableStringify(resolveGraphCacheRetention(0, false))).toMatchSnapshot();
    });

    it("resolveGraphCacheRetention: returns long when isLeafNode is undefined", () => {
      expect(stableStringify(resolveGraphCacheRetention(0, undefined))).toMatchSnapshot();
    });

    it("resolveGraphCacheRetention: returns long when depth is undefined and isLeafNode is undefined", () => {
      expect(stableStringify(resolveGraphCacheRetention(undefined, undefined))).toMatchSnapshot();
    });

    it("resolveGraphCacheRetention: returns short when isLeafNode is true regardless of depth", () => {
      // Depth-independence is the documented contract: leaf-node short
      // retention wins over any depth value.
      expect(stableStringify({
        depthZero: resolveGraphCacheRetention(0, true),
        depthOne: resolveGraphCacheRetention(1, true),
        depthDeep: resolveGraphCacheRetention(99, true),
      })).toMatchSnapshot();
    });
  });

  describe("type-level interface witnesses", () => {
    it("CrossSessionResult: interface key set is stable", () => {
      const witness: Record<keyof CrossSessionResult, true> = {
        crossSessionSender: true,
        subAgentRunner: true,
        sendToChannel: true,
        announceToParent: true,
        deadLetterQueue: true,
        announcementBatcher: true,
      };
      expect(stableStringify(typeKeys(witness))).toMatchSnapshot();
    });

    it("setupCrossSession: returns a function value (factory contract)", () => {
      // Functional sanity check: the export is callable. We cannot run
      // the factory without a real container, but this locks the
      // value-vs-type shape pre-split.
      expect(stableStringify({
        kind: typeof setupCrossSession,
        nameLen: setupCrossSession.name.length > 0,
      })).toMatchSnapshot();
    });
  });
});
