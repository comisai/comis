// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { stableStringify } from "../../../../../test/support/stable-stringify.js";
import {
  createMcpClientManager,
  qualifyToolName,
  parseQualifiedName,
  type McpClientManager,
  type McpClientManagerDeps,
  type McpServerConfig,
} from "./mcp-client.js";

/**
 * Phase 43 parity protection (FILE-SPLIT-11).
 *
 * Locks the byte-identical output of `mcp-client.ts`'s public-API
 * functions BEFORE the Phase 43 split refactor lands. Post-refactor
 * behavior MUST match these snapshots exactly. Any byte change fails
 * the per-commit gate.
 *
 * mcp-client.ts is the HIGHEST-RISK file in Wave 2: the
 * createMcpClientManager factory closure (~830L) captures connection
 * state across helpers. The split applies the state-first protocol
 * from Phase 42 pi-executor; this parity snapshot is the safety net.
 *
 * Per FILE-SPLIT-17 + OQ-5 (progressive deletion), this file is DELETED
 * in the same commit as the source-file split, once each new module has
 * >=1 independent behavior test per leaf.
 */

// Silence the `<reference>` shape check on inert exported types - they're
// already imported (above) for type-only purposes; this ensures TS/ESLint
// don't drop them.
type _ManagerShapeOnly = McpClientManager;
type _ManagerDepsShapeOnly = McpClientManagerDeps;
type _ServerConfigShapeOnly = McpServerConfig;

function makeMinimalDeps(): McpClientManagerDeps {
  return {
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  };
}

describe("mcp-client parity (FILE-SPLIT-11)", () => {
  describe("public API surface", () => {
    it("exports the expected named symbols", () => {
      const exports = {
        createMcpClientManager,
        qualifyToolName,
        parseQualifiedName,
      };
      expect(stableStringify(Object.keys(exports).sort())).toMatchSnapshot();
    });
  });

  describe("behavior matrix: representative inputs", () => {
    it("qualifyToolName: produces mcp__server--tool from (server, tool)", () => {
      const result = qualifyToolName("github", "list_repos");
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("parseQualifiedName: extracts (server, tool) from qualified name", () => {
      const result = parseQualifiedName("mcp:github/list_repos");
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("parseQualifiedName: returns null for non-qualified name", () => {
      const result = parseQualifiedName("plain_tool");
      expect(stableStringify(result ?? null)).toMatchSnapshot();
    });

    it("createMcpClientManager: factory returns expected handle shape", () => {
      const deps = makeMinimalDeps();
      const handle = createMcpClientManager(deps);
      expect(stableStringify(Object.keys(handle).sort())).toMatchSnapshot();
    });

    it("qualifyToolName: handles server names with dashes", () => {
      const result = qualifyToolName("a-b-c", "tool");
      expect(stableStringify(result)).toMatchSnapshot();
    });
  });
});
