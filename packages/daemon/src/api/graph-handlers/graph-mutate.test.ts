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
import type { CapabilityClass, TemplateMatch } from "@comis/agent";

// AUTHOR-02 (Phase 174-04): a DELEGATING spy over graph-helpers so the M-1
// marker-no-leak test can capture the EXACT params object reaching
// buildGraphInput (the marker is not in INTERNAL_FIELD_NAMES, so only the
// handler's explicit delete removes it before this call). The spy delegates to
// the real implementations, so every other test in this file exercises the
// real buildGraphInput / validateTypeConfigs behavior unchanged.
vi.mock("./graph-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./graph-helpers.js")>();
  return {
    ...actual,
    buildGraphInput: vi.fn(actual.buildGraphInput),
    validateTypeConfigs: vi.fn(actual.validateTypeConfigs),
  };
});

import { bindGraphMutateHandlers as bindGraphMutateHandlersRaw } from "./graph-mutate.js";
import * as graphHelpers from "./graph-helpers.js";
import type { GraphHandlerDeps } from "./graph-helpers.js";
import type { RpcHandler } from "../types.js";
import { withHeldCapabilities } from "../../../../../test/support/held-capabilities.js";

// CAP-03: the gated graph.define/execute/save/load/delete/cancel/deleteRun
// handlers now require an injected _capabilities (production supplies it via
// createAgentRpcCall). Wrap the bound record so these body-tests reach the
// handler BODY, not the gate (proven RED-first in the CAP-05 tests). Read-only
// graph methods pass through unchanged.
function bindGraphMutateHandlers(deps: GraphHandlerDeps): Record<string, RpcHandler> {
  return withHeldCapabilities(bindGraphMutateHandlersRaw(deps));
}

/** The delegating spies (typed as Mock) for argument capture. */
const buildGraphInputSpy = graphHelpers.buildGraphInput as unknown as ReturnType<typeof vi.fn>;
const validateTypeConfigsSpy = graphHelpers.validateTypeConfigs as unknown as ReturnType<typeof vi.fn>;

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
  /** Override the logger (WR-01: assert the best-effort emit logs at WARN). */
  logger?: Partial<Record<"info" | "warn" | "debug" | "error", ReturnType<typeof vi.fn>>>;
  /** Override graphCoordinator.run (WR-01: assert run still dispatches). */
  run?: ReturnType<typeof vi.fn>;
  /** AUTHOR-01 (174-03): the orchestration.authoring gate. */
  authoringConfig?: { repairProducer: boolean; intentAction: boolean; gbnfConstrain: boolean };
  /** AUTHOR-01 (174-03): the injected conservative repair matcher. */
  repairMatch?: (rawGraph: unknown) => TemplateMatch;
}

function makeDeps(overrides: FakeDepsOverrides = {}): GraphHandlerDeps {
  const emit = overrides.emit ?? vi.fn();
  return {
    // graphCoordinator.run is awaited by graph.execute; return ok(graphId).
    graphCoordinator: {
      run: overrides.run ?? vi.fn(async () => ok("graph-123")),
      cancel: vi.fn(() => true),
    },
    securityConfig: {
      agentToAgent: { enabled: overrides.a2aEnabled ?? true, waitTimeoutMs: 1000 },
    },
    // nodeTypeRegistry undefined → validateTypeConfigs is a no-op.
    nodeTypeRegistry: undefined,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), ...overrides.logger },
    eventBus: { emit, on: vi.fn() },
    resolveCapabilityClass: overrides.resolveCapabilityClass,
    authoringConfig: overrides.authoringConfig,
    repairMatch: overrides.repairMatch,
  } as unknown as GraphHandlerDeps;
}

/** Pull the single pipeline:authored payload off a captured emit mock. */
function authoredPayloads(emit: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return emit.mock.calls
    .filter((c) => c[0] === "pipeline:authored")
    .map((c) => c[1] as Record<string, unknown>);
}

/** Pull graph:repaired payloads off a captured emit mock (AUTHOR-01). */
function repairedPayloads(emit: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return emit.mock.calls
    .filter((c) => c[0] === "graph:repaired")
    .map((c) => c[1] as Record<string, unknown>);
}

/** A repairMatch stub that always returns a valid filled `debate` (2+1). */
const MATCH_DEBATE: (rawGraph: unknown) => TemplateMatch = () => ({
  kind: "matched",
  pattern: "debate",
  filledNodes: [
    { nodeId: "pro", task: "Argue FOR", dependsOn: [] },
    { nodeId: "con", task: "Argue AGAINST", dependsOn: [] },
    { nodeId: "judge", task: "Verdict", dependsOn: ["pro", "con"] },
  ],
});

const FLAGS_ON = { repairProducer: true, intentAction: false, gbnfConstrain: false };

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

// ---------------------------------------------------------------------------
// WR-02: contract-parse-level schema rejections of a present-but-malformed
// authoring call ALSO count as schemaValid:false (so the gate denominator
// includes the crudest small-model authoring failures — an HONEST metric).
// graph.define has a STRICT z.object contract, so a present-nodes call with a
// malformed contract field throws at GraphDefineContract.request.parse BEFORE
// buildGraphInput — that throw must now emit schemaValid:false then re-throw.
// (graph.execute's contract is a loose z.record that accepts any object, so
// there is no contract-parse gap there — malformed-but-present input reaches
// buildGraphInput, which already emits via its own try/catch.)
// ---------------------------------------------------------------------------

describe("graph.define — contract-parse rejection emits schemaValid:false (WR-02)", () => {
  /** nodes present + non-empty (passes the bespoke "Missing nodes" check) but a
   *  contract-level field is malformed (timeoutMs must be a number) → the call
   *  throws at GraphDefineContract.request.parse, BEFORE buildGraphInput. */
  const CONTRACT_INVALID_PARAMS = {
    nodes: VALID_NODES,
    timeoutMs: "not-a-number",
    _agentId: "weakbot",
  };

  it("emits one pipeline:authored{schemaValid:false} with the resolved tier on a contract-parse throw, then re-throws", async () => {
    const emit = vi.fn();
    const resolveCapabilityClass = vi.fn(() => "small" as CapabilityClass);
    const handlers = bindGraphMutateHandlers(makeDeps({ emit, resolveCapabilityClass }));

    // The user-facing contract is unchanged — the handler still throws.
    await expect(handlers["graph.define"]!(CONTRACT_INVALID_PARAMS)).rejects.toThrow();

    const payloads = authoredPayloads(emit);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      action: "define",
      schemaValid: false,
      repaired: false,
      capabilityClass: "small",
    });
  });
});

// ---------------------------------------------------------------------------
// WR-01: the emit is BEST-EFFORT — a throwing bus listener (the diagnostic
// buffer's synchronous SQLite flush on its 50th item can throw SQLITE_BUSY/FULL;
// TypedEventBus.emit has NO listener error isolation) must NEVER break the
// measured graph.define/execute. The telemetry throw is swallowed (logged WARN),
// never surfaced as the operation's result.
// ---------------------------------------------------------------------------

describe("pipeline:authored — emit is best-effort (telemetry never breaks the measured op, WR-01)", () => {
  /** An eventBus whose emit throws (simulates the diagnosticBuffer→SQLite flush
   *  throwing SQLITE_BUSY out of EventEmitter.emit — no listener isolation). */
  const throwingEmit = () =>
    vi.fn(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });

  it("graph.define SUCCESS path still resolves when the bus emit throws (telemetry failure swallowed)", async () => {
    const emit = throwingEmit();
    const warn = vi.fn();
    const handlers = bindGraphMutateHandlers(makeDeps({ emit, logger: { warn } }));

    // The valid define must succeed despite the telemetry throw.
    const result = await handlers["graph.define"]!({ nodes: VALID_NODES });
    expect(result).toMatchObject({ valid: true, nodeCount: 2 });
    // The emit was attempted (and threw)…
    expect(emit).toHaveBeenCalledTimes(1);
    // …and was logged at WARN with an errorKind + hint, not surfaced.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ errorKind: expect.any(String) });
  });

  it("graph.execute SUCCESS path still resolves when the bus emit throws (emit is BEFORE coordinator.run)", async () => {
    const emit = throwingEmit();
    const run = vi.fn(async () => ok("graph-xyz"));
    const handlers = bindGraphMutateHandlers(makeDeps({ emit, run, logger: { warn: vi.fn() } }));

    const result = await handlers["graph.execute"]!({ nodes: VALID_NODES });
    expect(result).toMatchObject({ graphId: "graph-xyz", async: true });
    // The pipeline STILL dispatched (the emit throw did not short-circuit run).
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("graph.define INVALID path re-throws the ORIGINAL graph-validation error, NOT the telemetry throw", async () => {
    const emit = throwingEmit();
    const handlers = bindGraphMutateHandlers(makeDeps({ emit, logger: { warn: vi.fn() } }));

    // The user-facing contract is the GRAPH error, never "SQLITE_BUSY".
    await expect(handlers["graph.define"]!({ nodes: CYCLIC_NODES })).rejects.toThrow(
      /Graph validation failed/,
    );
    await expect(handlers["graph.define"]!({ nodes: CYCLIC_NODES })).rejects.not.toThrow(
      /SQLITE_BUSY/,
    );
  });

  it("graph.execute INVALID path re-throws the ORIGINAL graph-validation error, NOT the telemetry throw", async () => {
    const emit = throwingEmit();
    const handlers = bindGraphMutateHandlers(makeDeps({ emit, logger: { warn: vi.fn() } }));

    await expect(handlers["graph.execute"]!({ nodes: CYCLIC_NODES })).rejects.toThrow(
      /Graph validation failed/,
    );
    await expect(handlers["graph.execute"]!({ nodes: CYCLIC_NODES })).rejects.not.toThrow(
      /SQLITE_BUSY/,
    );
  });
});

// ---------------------------------------------------------------------------
// AUTHOR-01 (174-03): the gated SERVER-SIDE capabilityClass feed.
//
// The tier the handler passes into buildGraphInput is observable through the
// repair branch: a weak (small/nano) tier + an invalid graph + repairProducer
// ON + an injected repairMatch → the invalid graph is REPAIRED (resolves +
// emits graph:repaired) instead of throwing the Phase-157 fail-close. So:
//   - FLAGS-OFF → tier fed undefined → capable path → the SAME Phase-157 throw
//     on a weak agent's invalid graph (byte-identical to today).
//   - FLAGS-ON  → tier fed the SERVER-RESOLVED value (resolveCapabilityClass),
//     NOT userParams.capabilityClass (the spoofing surface T-174-SPOOF/T-173-03).
// ---------------------------------------------------------------------------

describe("graph mutate — gated server-side capabilityClass feed (AUTHOR-01)", () => {
  it("Test 1 (FLAGS-OFF byte-identical): repairProducer absent → a weak agent's invalid graph still throws Phase-157 (tier fed undefined)", async () => {
    const emit = vi.fn();
    // The agent is weak, but the gate is OFF — the tier must NOT be resolved.
    const resolveCapabilityClass = vi.fn(() => "small" as CapabilityClass);
    const handlers = bindGraphMutateHandlers(
      makeDeps({ emit, resolveCapabilityClass, repairMatch: MATCH_DEBATE /* no authoringConfig */ }),
    );

    // FLAGS-OFF: the invalid graph hits the capable direct path → throws.
    await expect(
      handlers["graph.define"]!({ nodes: CYCLIC_NODES, _agentId: "weakbot" }),
    ).rejects.toThrow(/Graph validation failed/);
    // The tier resolver was NEVER consulted for the buildGraphInput feed
    // (the only call would be the pipeline:authored emit, which reads it
    // separately — but with the gate off buildGraphInput got undefined, proven
    // by the Phase-157 throw above and the absence of any repair).
    expect(repairedPayloads(emit)).toHaveLength(0);
  });

  it("Test 2 (server-side resolution): repairProducer ON + weak agent + invalid graph → REPAIRED via the server-resolved tier (not userParams)", async () => {
    const emit = vi.fn();
    const resolveCapabilityClass = vi.fn(() => "small" as CapabilityClass);
    const handlers = bindGraphMutateHandlers(
      makeDeps({ emit, resolveCapabilityClass, authoringConfig: FLAGS_ON, repairMatch: MATCH_DEBATE }),
    );

    // The invalid graph is repaired (resolves, does NOT throw).
    const result = await handlers["graph.define"]!({ nodes: CYCLIC_NODES, _agentId: "weakbot" });
    expect(result).toMatchObject({ valid: true });
    // The tier was resolved SERVER-SIDE from the raw _agentId.
    expect(resolveCapabilityClass).toHaveBeenCalledWith("weakbot");
    // graph:repaired fired (the weak tier reached the repair branch).
    expect(repairedPayloads(emit)).toHaveLength(1);
  });

  it("Test 3 (spoofing ignored): a tool-supplied capabilityClass='frontier' on a weak agent is IGNORED — the real (weak) tier still routes to repair", async () => {
    const emit = vi.fn();
    // The SERVER resolves the agent as weak; the TOOL claims frontier.
    const resolveCapabilityClass = vi.fn(() => "small" as CapabilityClass);
    const handlers = bindGraphMutateHandlers(
      makeDeps({ emit, resolveCapabilityClass, authoringConfig: FLAGS_ON, repairMatch: MATCH_DEBATE }),
    );

    // Tool-supplied capabilityClass:"frontier" must NOT skip repair.
    const result = await handlers["graph.execute"]!({
      nodes: CYCLIC_NODES,
      capabilityClass: "frontier", // the spoof
      _agentId: "weakbot",
    });
    expect(result).toMatchObject({ async: true });
    // Repair STILL fired → the tool param was ignored, the server tier (weak) won.
    expect(repairedPayloads(emit)).toHaveLength(1);
  });

  it("Test 4 (FLAGS-ON, capable agent unaffected): a frontier agent's invalid graph still throws (no repair) — repair is weak-only", async () => {
    const emit = vi.fn();
    const resolveCapabilityClass = vi.fn(() => "frontier" as CapabilityClass);
    const handlers = bindGraphMutateHandlers(
      makeDeps({ emit, resolveCapabilityClass, authoringConfig: FLAGS_ON, repairMatch: MATCH_DEBATE }),
    );

    // A capable tier never routes to repair, even flag-on → the capable throw.
    await expect(
      handlers["graph.define"]!({ nodes: CYCLIC_NODES, _agentId: "strongbot" }),
    ).rejects.toThrow(/Graph validation failed/);
    expect(repairedPayloads(emit)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AUTHOR-02 (Phase 174-04): the daemon-side from_intent gate + marker handling
// + synthesis audit emit + governance-not-bypassed.
//
// from_intent synthesizes a graph in the skills tool and dispatches it through
// graph.execute with an in-band `_synthesizedFromIntent` marker. The daemon
// execute handler:
//   - reads the marker BEFORE stripInternalFields,
//   - REFUSES when the marker is set AND orchestration.authoring.intentAction is
//     off (the FLAGS-OFF chokepoint — before any graph runs),
//   - explicit-deletes the marker after the strip (it is NOT in
//     INTERNAL_FIELD_NAMES, and GraphExecuteContract.request is a loose z.record,
//     so the strip alone leaves it — M-1 marker-no-leak),
//   - emits graph:synthesized_from_intent best-effort on a GOVERNED synthesis,
//   - and a synthesized graph traverses the IDENTICAL define-time governance
//     (buildGraphInput parse/sort + validateTypeConfigs) a hand-authored graph
//     hits — governance is on the shared path, NOT re-implemented or skipped.
// ---------------------------------------------------------------------------

/** Pull graph:synthesized_from_intent payloads off a captured emit mock. */
function synthesizedPayloads(emit: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return emit.mock.calls
    .filter((c) => c[0] === "graph:synthesized_from_intent")
    .map((c) => c[1] as Record<string, unknown>);
}

const FLAGS_INTENT_ON = { repairProducer: false, intentAction: true, gbnfConstrain: false };
const FLAGS_INTENT_OFF = { repairProducer: false, intentAction: false, gbnfConstrain: false };

/** Capture the graph passed to graphCoordinator.run (the post-governance graph). */
function makeRunCapture() {
  const seen: Array<Record<string, unknown>> = [];
  const run = vi.fn(async (input: Record<string, unknown>) => {
    seen.push(input);
    return ok("graph-synth-1");
  });
  return { run, seen };
}

describe("graph.execute — from_intent gate + marker + synthesis emit (AUTHOR-02)", () => {
  it("Test 1 (FLAGS-OFF refusal): _synthesizedFromIntent set + intentAction OFF → policy refusal, NO graph runs", async () => {
    const emit = vi.fn();
    const { run, seen } = makeRunCapture();
    const handlers = bindGraphMutateHandlers(
      makeDeps({ emit, run, authoringConfig: FLAGS_INTENT_OFF }),
    );

    await expect(
      handlers["graph.execute"]!({
        nodes: VALID_NODES,
        _synthesizedFromIntent: "debate",
        _agentId: "bot",
      }),
    ).rejects.toThrow(/intentAction|from_intent .*disabled|disabled by policy/i);
    // The gate fires BEFORE the coordinator — no graph ran.
    expect(seen).toHaveLength(0);
    expect(synthesizedPayloads(emit)).toHaveLength(0);
  });

  it("Test 2 (flag-on emit): intentAction ON → the synthesized execute proceeds AND emits graph:synthesized_from_intent once (pattern + nodeCount, counts-only)", async () => {
    const emit = vi.fn();
    const { run } = makeRunCapture();
    const handlers = bindGraphMutateHandlers(
      makeDeps({ emit, run, authoringConfig: FLAGS_INTENT_ON }),
    );

    const result = await handlers["graph.execute"]!({
      nodes: VALID_NODES,
      _synthesizedFromIntent: "debate",
      _agentId: "bot",
      _callerSessionKey: "sess-1",
    });
    expect(result).toMatchObject({ async: true });

    const payloads = synthesizedPayloads(emit);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.pattern).toBe("debate");
    expect(payloads[0]!.nodeCount).toBe(VALID_NODES.length);
    // Correlation ids ride envelope-only; no graph body leaks (§2.7).
    expect(payloads[0]!.agentId).toBe("bot");
    expect(payloads[0]!.sessionKey).toBe("sess-1");
    expect(payloads[0]).not.toHaveProperty("nodes");
    expect(payloads[0]).not.toHaveProperty("label");
    expect(JSON.stringify(payloads[0])).not.toContain("Research topic");
  });

  it("Test 3 (governance NOT bypassed — PRIMARY path assertion): a synthesized graph traverses the IDENTICAL define-time governance (buildGraphInput + validateTypeConfigs) a hand-authored graph.execute hits", async () => {
    const emit = vi.fn();
    const { run, seen } = makeRunCapture();
    const handlers = bindGraphMutateHandlers(
      makeDeps({ emit, run, authoringConfig: FLAGS_INTENT_ON }),
    );

    // A from_intent-marked but structurally INVALID (cyclic) graph must hit the
    // SAME parse/validateAndSortGraph governance a hand-authored execute hits —
    // i.e. it is rejected, not waved through because it is "synthesized".
    await expect(
      handlers["graph.execute"]!({
        nodes: CYCLIC_NODES,
        _synthesizedFromIntent: "debate",
        _agentId: "bot",
      }),
    ).rejects.toThrow(/Graph validation failed/);
    // Governance rejected it BEFORE the coordinator — same path, no synthesis bypass.
    expect(seen).toHaveLength(0);
    // No emit on a graph that failed governance (the emit reflects a GOVERNED graph).
    expect(synthesizedPayloads(emit)).toHaveLength(0);

    // And a VALID synthesized graph traverses the IDENTICAL governance call-path:
    // buildGraphInput (parse + validateAndSortGraph) AND validateTypeConfigs are
    // both invoked on the synthesized nodes, exactly as a hand-authored
    // graph.execute invokes them — governance is on the SHARED path, not
    // re-implemented or skipped for synthesis (L-2 path-equivalence).
    buildGraphInputSpy.mockClear();
    validateTypeConfigsSpy.mockClear();
    const handlers2Run = makeRunCapture();
    const handlers2 = bindGraphMutateHandlers(
      makeDeps({ emit: vi.fn(), run: handlers2Run.run, authoringConfig: FLAGS_INTENT_ON }),
    );
    await handlers2["graph.execute"]!({
      nodes: VALID_NODES,
      _synthesizedFromIntent: "debate",
      _agentId: "bot",
    });
    // The exact same define-time governance functions ran on the synthesized graph.
    expect(buildGraphInputSpy).toHaveBeenCalledTimes(1);
    expect(validateTypeConfigsSpy).toHaveBeenCalledTimes(1);
    expect(handlers2Run.seen).toHaveLength(1);
    const coordInput = handlers2Run.seen[0]!;
    // The coordinator received a validated graph with an executionOrder (proof
    // validateAndSortGraph ran on the shared path).
    const graph = coordInput.graph as { graph: { nodes: unknown[] }; executionOrder: string[] };
    expect(Array.isArray(graph.executionOrder)).toBe(true);
    expect(graph.graph.nodes.length).toBe(VALID_NODES.length);
  });

  it("Test 4 (marker does NOT leak — M-1): the _synthesizedFromIntent marker is stripped before buildGraphInput (NOT in INTERNAL_FIELD_NAMES → explicit delete required)", async () => {
    buildGraphInputSpy.mockClear();
    const emit = vi.fn();
    const { run, seen } = makeRunCapture();
    const handlers = bindGraphMutateHandlers(
      makeDeps({ emit, run, authoringConfig: FLAGS_INTENT_ON }),
    );

    await handlers["graph.execute"]!({
      nodes: VALID_NODES,
      _synthesizedFromIntent: "debate",
      _agentId: "bot",
    });
    // PRIMARY M-1 assertion: the params object reaching buildGraphInput carries
    // NO _synthesizedFromIntent key. stripInternalFields alone leaves it (not in
    // the 15-name allowlist); the handler's explicit delete must remove it.
    expect(buildGraphInputSpy).toHaveBeenCalledTimes(1);
    const paramsToBuild = buildGraphInputSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(paramsToBuild).not.toHaveProperty("_synthesizedFromIntent");
    // Belt-and-suspenders: the marker also appears nowhere in the coordinator graph.
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).not.toContain("_synthesizedFromIntent");
  });

  it("Test 5 (emit best-effort): a throwing emit does NOT break a valid synthesized execute", async () => {
    const warn = vi.fn();
    const emit = vi.fn((event: string) => {
      if (event === "graph:synthesized_from_intent") throw new Error("obs buffer SQLITE_BUSY");
    });
    const { run, seen } = makeRunCapture();
    const handlers = bindGraphMutateHandlers(
      makeDeps({ emit, run, authoringConfig: FLAGS_INTENT_ON, logger: { warn } }),
    );

    // The execute still succeeds despite the emit throw (telemetry never breaks
    // the measured op — mirrors emitPipelineAuthored).
    const result = await handlers["graph.execute"]!({
      nodes: VALID_NODES,
      _synthesizedFromIntent: "debate",
      _agentId: "bot",
    });
    expect(result).toMatchObject({ async: true });
    expect(seen).toHaveLength(1); // the coordinator ran
    expect(warn).toHaveBeenCalled(); // the throw was logged at WARN
  });

  it("Test 6 (no marker = byte-identical): a normal graph.execute with NO _synthesizedFromIntent does NOT gate, emit, or otherwise change", async () => {
    const emit = vi.fn();
    const { run, seen } = makeRunCapture();
    // intentAction OFF — a NON-from_intent execute must be wholly unaffected.
    const handlers = bindGraphMutateHandlers(
      makeDeps({ emit, run, authoringConfig: FLAGS_INTENT_OFF }),
    );

    const result = await handlers["graph.execute"]!({ nodes: VALID_NODES, _agentId: "bot" });
    expect(result).toMatchObject({ async: true });
    expect(seen).toHaveLength(1);
    // No synthesis emit, no refusal (the gate only engages on the marker).
    expect(synthesizedPayloads(emit)).toHaveLength(0);
  });
});
