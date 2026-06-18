// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for graph-mutate.ts — the daemon-side `pipeline:authored` emit
 * (Phase 173-02 / TELEM-01).
 *
 * The emit lives in the `graph.define` and `graph.execute` handlers, where the
 * `buildGraphInput` parse+validate verdict (schemaValid) and the resolved
 * capabilityClass tier both converge (the skills pipeline tool has neither —
 * emitting there would record `schemaValid:true` always; research decision
 * D-EMITSITE). These tests pin:
 *
 *   - define + execute each emit exactly ONE pipeline:authored per invocation
 *   - schemaValid reflects the REAL buildGraphInput verdict (true on success,
 *     false on a parse/validate throw — the emit fires on BOTH branches and the
 *     handler still re-throws the user-facing error: the existing error contract
 *     is unchanged)
 *   - capabilityClass comes from the injected `resolveCapabilityClass(_agentId)`
 *     resolver (small/nano preserved; "unknown" when unresolvable — Pitfall 2,
 *     never silently dropped, never defaulted to "frontier")
 *   - repaired is the literal `false` (the P2/174 repair throw is NOT wired)
 *   - the payload is counts/ids/enums ONLY — no node task / type_config / label /
 *     body leaks into the event (§2.7 / D-EVENT no-leak control)
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { ok } from "@comis/shared";
import type { CapabilityClass } from "@comis/agent";

import { bindGraphMutateHandlers } from "./graph-mutate.js";
import type { GraphHandlerDeps } from "./graph-helpers.js";

// ---------------------------------------------------------------------------
// Fixtures — payloads proven valid / invalid against buildGraphInput
// (mirror graph-helpers.test.ts VALID_GRAPH_PARAMS / CYCLIC_GRAPH_PARAMS).
// ---------------------------------------------------------------------------

/** A valid two-node DAG (parse + validate succeed → schemaValid:true). */
const VALID_NODES = [
  { node_id: "a", task: "Research topic A" },
  { node_id: "b", task: "Research topic B", depends_on: ["a"] },
];

/** A cyclic DAG: a→b and b→a — parses but FAILS validateAndSortGraph, so the
 *  capable path throws "Graph validation failed: …" (schemaValid:false case). */
const CYCLIC_NODES = [
  { node_id: "a", task: "Secret task A text", depends_on: ["b"] },
  { node_id: "b", task: "Secret task B text", depends_on: ["a"] },
];

// ---------------------------------------------------------------------------
// Fake deps factory — only the fields the mutate handlers touch.
// ---------------------------------------------------------------------------

interface FakeDepsOverrides {
  emit?: ReturnType<typeof vi.fn>;
  resolveCapabilityClass?: (agentId: string | undefined) => CapabilityClass | undefined;
  a2aEnabled?: boolean;
}

function makeDeps(overrides: FakeDepsOverrides = {}): GraphHandlerDeps {
  const emit = overrides.emit ?? vi.fn();
  return {
    // graphCoordinator.run is awaited by graph.execute; return ok(graphId).
    graphCoordinator: {
      run: vi.fn(async () => ok("graph-123")),
      cancel: vi.fn(() => true),
    },
    securityConfig: {
      agentToAgent: { enabled: overrides.a2aEnabled ?? true, waitTimeoutMs: 1000 },
    },
    // nodeTypeRegistry undefined → validateTypeConfigs is a no-op.
    nodeTypeRegistry: undefined,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    eventBus: { emit, on: vi.fn() },
    resolveCapabilityClass: overrides.resolveCapabilityClass,
  } as unknown as GraphHandlerDeps;
}

/** Pull the single pipeline:authored payload off a captured emit mock. */
function authoredPayloads(emit: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return emit.mock.calls
    .filter((c) => c[0] === "pipeline:authored")
    .map((c) => c[1] as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// graph.define emit
// ---------------------------------------------------------------------------

describe("graph.define — pipeline:authored emit (TELEM-01)", () => {
  it("emits exactly one pipeline:authored with action=define, schemaValid=true, repaired=false on a valid payload", async () => {
    const emit = vi.fn();
    const handlers = bindGraphMutateHandlers(makeDeps({ emit }));

    await handlers["graph.define"]!({ nodes: VALID_NODES });

    const payloads = authoredPayloads(emit);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ action: "define", schemaValid: true, repaired: false });
  });

  it("STILL emits one pipeline:authored with schemaValid=false on an invalid (cyclic) payload AND re-throws the user-facing error", async () => {
    const emit = vi.fn();
    const handlers = bindGraphMutateHandlers(makeDeps({ emit }));

    // The existing error contract is unchanged — the handler still throws.
    await expect(handlers["graph.define"]!({ nodes: CYCLIC_NODES })).rejects.toThrow(
      /Graph validation failed/,
    );

    const payloads = authoredPayloads(emit);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ action: "define", schemaValid: false, repaired: false });
  });
});

// ---------------------------------------------------------------------------
// graph.execute emit
// ---------------------------------------------------------------------------

describe("graph.execute — pipeline:authored emit (TELEM-01)", () => {
  it("emits exactly one pipeline:authored with action=execute, schemaValid=true, repaired=false on a valid payload", async () => {
    const emit = vi.fn();
    const handlers = bindGraphMutateHandlers(makeDeps({ emit }));

    await handlers["graph.execute"]!({ nodes: VALID_NODES });

    const payloads = authoredPayloads(emit);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ action: "execute", schemaValid: true, repaired: false });
  });

  it("STILL emits one pipeline:authored with schemaValid=false on an invalid (cyclic) payload AND re-throws", async () => {
    const emit = vi.fn();
    const handlers = bindGraphMutateHandlers(makeDeps({ emit }));

    await expect(handlers["graph.execute"]!({ nodes: CYCLIC_NODES })).rejects.toThrow(
      /Graph validation failed/,
    );

    const payloads = authoredPayloads(emit);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ action: "execute", schemaValid: false, repaired: false });
  });
});

// ---------------------------------------------------------------------------
// Tier resolution — capabilityClass from the injected resolver (Task 2)
// ---------------------------------------------------------------------------

describe("pipeline:authored — capabilityClass resolved daemon-side from _agentId", () => {
  it('records the resolver verdict "small" (read off RAW params, surviving stripInternalFields)', async () => {
    const emit = vi.fn();
    const resolveCapabilityClass = vi.fn(() => "small" as CapabilityClass);
    const handlers = bindGraphMutateHandlers(makeDeps({ emit, resolveCapabilityClass }));

    await handlers["graph.define"]!({ nodes: VALID_NODES, _agentId: "weakbot" });

    // resolver invoked with the RAW _agentId (not stripped to undefined)
    expect(resolveCapabilityClass).toHaveBeenCalledWith("weakbot");
    expect(authoredPayloads(emit)[0]).toMatchObject({ capabilityClass: "small" });
  });

  it('preserves the raw "nano" enum (small AND nano are the small/local tier downstream — not collapsed)', async () => {
    const emit = vi.fn();
    const handlers = bindGraphMutateHandlers(
      makeDeps({ emit, resolveCapabilityClass: () => "nano" as CapabilityClass }),
    );

    await handlers["graph.define"]!({ nodes: VALID_NODES, _agentId: "nanobot" });

    expect(authoredPayloads(emit)[0]).toMatchObject({ capabilityClass: "nano" });
  });

  it('records "unknown" when _agentId is absent (Pitfall 2 — never default to frontier)', async () => {
    const emit = vi.fn();
    const resolveCapabilityClass = vi.fn(() => undefined);
    const handlers = bindGraphMutateHandlers(makeDeps({ emit, resolveCapabilityClass }));

    await handlers["graph.define"]!({ nodes: VALID_NODES });

    expect(authoredPayloads(emit)[0]).toMatchObject({ capabilityClass: "unknown" });
  });

  it('records "unknown" when the resolver itself returns undefined for a known agent', async () => {
    const emit = vi.fn();
    const handlers = bindGraphMutateHandlers(
      makeDeps({ emit, resolveCapabilityClass: () => undefined }),
    );

    await handlers["graph.define"]!({ nodes: VALID_NODES, _agentId: "unmapped" });

    expect(authoredPayloads(emit)[0]).toMatchObject({ capabilityClass: "unknown" });
  });

  it('records "unknown" when no resolver is injected at all (optional dep absent)', async () => {
    const emit = vi.fn();
    const handlers = bindGraphMutateHandlers(makeDeps({ emit })); // no resolveCapabilityClass

    await handlers["graph.define"]!({ nodes: VALID_NODES, _agentId: "anybot" });

    expect(authoredPayloads(emit)[0]).toMatchObject({ capabilityClass: "unknown" });
  });
});

// ---------------------------------------------------------------------------
// NO-LEAK structural control (§2.7 / D-EVENT)
// ---------------------------------------------------------------------------

describe("pipeline:authored — counts/ids/enums-only (no body leak)", () => {
  const FORBIDDEN_KEYS = ["nodes", "graph", "type_config", "typeConfig", "task", "label"];

  it("the emitted payload carries no pipeline-body key and no node task text", async () => {
    const emit = vi.fn();
    const handlers = bindGraphMutateHandlers(
      makeDeps({ emit, resolveCapabilityClass: () => "small" as CapabilityClass }),
    );

    await handlers["graph.execute"]!({
      nodes: [{ node_id: "n1", task: "TOP-SECRET node task body", label: "secret-label" }],
      label: "secret graph label",
      _agentId: "weakbot",
    });

    const payload = authoredPayloads(emit)[0]!;
    for (const k of FORBIDDEN_KEYS) {
      expect(k in payload).toBe(false);
    }
    expect(JSON.stringify(payload)).not.toContain("TOP-SECRET");
    expect(JSON.stringify(payload)).not.toContain("secret-label");
    expect(JSON.stringify(payload)).not.toContain("secret graph label");
    // Positive: the allowed counts/ids/enums key set ONLY (agentId/sessionKey
    // are envelope ids per the EventMap["pipeline:authored"] contract, present
    // even when undefined — never a body field).
    expect(Object.keys(payload).sort()).toEqual(
      ["action", "agentId", "capabilityClass", "repaired", "schemaValid", "sessionKey", "timestamp"].sort(),
    );
  });
});
