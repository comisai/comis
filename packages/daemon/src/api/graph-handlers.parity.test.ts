// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { stableStringify } from "../../../../test/support/stable-stringify.js";
import {
  createGraphHandlers,
  transformNodes,
  validateGraphWarnings,
  schemaToExample,
  type GraphHandlerDeps,
} from "./graph-handlers.js";
import { z } from "zod";

/**
 * Phase 43 parity protection (FILE-SPLIT-05).
 *
 * These snapshots lock the byte-identical output of graph-handlers.ts's
 * public-API functions BEFORE the Phase 43 split refactor lands.
 *
 * The post-refactor behavior MUST match these snapshots exactly. Any byte
 * change FAILS this test, which fails `pnpm test`, which fails the
 * per-commit gate.
 *
 * Captured: in Phase 43 Wave 7 sub-plan 43-07a Task 1. Subsequent split
 * commits in 43-07b must keep this test green. Per FILE-SPLIT-17 + OQ-5
 * (progressive deletion), this file is DELETED at the end of 43-07b's
 * graph-handlers split commit once each new structure has at least one
 * independent behavior test per extracted module.
 *
 * Source-symbol surface as of capture (graph-handlers.ts at the merge
 * base):
 *   value:  createGraphHandlers, transformNodes, validateGraphWarnings,
 *           schemaToExample
 *   type:   GraphHandlerDeps, ValidationIssue
 */

// ---------------------------------------------------------------------------
// Minimal deps factory: vi.fn() stubs only; no IO and no `vi.useFakeTimers()`
// ---------------------------------------------------------------------------

function makeCoordinator() {
  return {
    run: vi.fn(),
    getStatus: vi.fn(),
    cancel: vi.fn(),
    listGraphs: vi.fn().mockReturnValue([]),
    getConcurrencyStats: vi.fn().mockReturnValue({
      activeGraphs: 0,
      queuedNodes: 0,
      runningNodes: 0,
      maxConcurrentNodes: 4,
    }),
    shutdown: vi.fn(),
  };
}

function makeDeps(overrides?: Partial<GraphHandlerDeps>): GraphHandlerDeps {
  return {
    graphCoordinator: makeCoordinator(),
    defaultAgentId: "default-agent",
    tenantId: "default",
    agents: {},
    securityConfig: { agentToAgent: { enabled: true, waitTimeoutMs: 5000 } },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  } as GraphHandlerDeps;
}

// ---------------------------------------------------------------------------
// Parity describe: sorted by (a) public-API surface (b) behavior matrix
// ---------------------------------------------------------------------------

describe("graph-handlers parity (FILE-SPLIT-05)", () => {
  describe("public API surface", () => {
    it("createGraphHandlers: returned handler map has expected method names", () => {
      const deps = makeDeps();
      const handlers = createGraphHandlers(deps);
      expect(stableStringify(Object.keys(handlers).sort())).toMatchSnapshot();
    });
  });

  describe("behavior matrix: representative inputs", () => {
    it("transformNodes: transforms a known snake_case input graph", () => {
      const result = transformNodes([
        {
          node_id: "fetch",
          task: "Fetch data for ${TICKER}",
          agent: "fetcher",
          depends_on: [],
          timeout_ms: 5000,
          max_steps: 10,
          model: "claude-sonnet-4-20250514",
        },
        {
          node_id: "aggregate",
          task: "Aggregate results",
          depends_on: ["fetch"],
          barrier_mode: "majority",
          retries: 2,
          context_mode: "summary",
        },
        {
          node_id: "typed",
          task: "Run debate",
          type_id: "debate",
          type_config: { agents: ["a", "b"] },
          depends_on: ["aggregate"],
        },
      ]);
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("validateGraphWarnings: emits expected warnings for problematic graph", () => {
      const graph = {
        nodes: [
          {
            nodeId: "orphan",
            task: "Disconnected node",
            agentId: "a1",
            dependsOn: [],
            timeoutMs: 1000,
            maxSteps: 5,
            barrierMode: "all" as const,
            retries: 0,
            contextMode: "full" as const,
          },
          {
            nodeId: "root",
            task: "Start with bad ref {{missing.result}}",
            agentId: "a1",
            dependsOn: [],
            timeoutMs: 1000,
            maxSteps: 5,
            barrierMode: "majority" as const,
            retries: 0,
            contextMode: "full" as const,
          },
          {
            nodeId: "typed",
            task: "Typed with conflicting agentId",
            agentId: "a1",
            typeId: "approval-gate",
            typeConfig: {},
            dependsOn: ["root"],
            timeoutMs: 1000,
            maxSteps: 5,
            barrierMode: "all" as const,
            retries: 3,
            contextMode: "full" as const,
          },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      const result = validateGraphWarnings(graph);
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("schemaToExample: produces expected example for known schema", () => {
      const schema = z.object({
        name: z.string(),
        count: z.number(),
        enabled: z.boolean(),
        tags: z.array(z.string()),
        nested: z.object({ inner: z.string() }),
        optionalField: z.string().optional(),
        withDefault: z.string().default("d"),
        described: z.string().describe("a description"),
      });
      expect(stableStringify(schemaToExample(schema))).toMatchSnapshot();
    });

    it("graph.list: throws expected error when namedGraphStore is absent", async () => {
      const handlers = createGraphHandlers(makeDeps());
      let captured: unknown;
      try {
        await handlers["graph.list"]!({});
      } catch (e) {
        captured = (e as Error).message;
      }
      expect(stableStringify({ error: captured })).toMatchSnapshot();
    });

    it("graph.define: returns expected envelope for a minimal valid graph", async () => {
      const handlers = createGraphHandlers(makeDeps());
      const result = await handlers["graph.define"]!({
        nodes: [
          { node_id: "a", task: "Do A", agent: "default-agent" },
          { node_id: "b", task: "Do B", agent: "default-agent", depends_on: ["a"] },
        ],
        label: "parity-fixture",
      });
      expect(stableStringify(result)).toMatchSnapshot();
    });
  });
});
