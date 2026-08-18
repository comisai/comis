// SPDX-License-Identifier: Apache-2.0
/**
 * Data-operation conformance for the capability-service platform.
 *
 * One service, two tools: an inspection that only reads, and a mutation that
 * changes something outside Comis. They must not blur. A read that inherited the
 * mutation's side effects would be gated as though it changed the world; a
 * mutation that inherited the read's posture would run without the approval its
 * side effects require, which is the failure that matters.
 *
 * The fixture also pins the claim that gives the shape its name: holding the
 * attention scope — the ability to ask a human a question and receive an answer
 * — grants no mutation authority. A human answering "yes, that looks right" to a
 * question is not the same act as approving a side effect, and a runtime that
 * let one stand in for the other would turn any conversational reply into
 * consent for a change the person was never shown.
 *
 * The fixture is deliberately neutral: it carries no consumer's domain nouns.
 *
 * @module
 */
import { describe, expect, it, vi } from "vitest";
import { ok } from "@comis/shared";
import type { ComisLogger } from "@comis/core";
import { createManagedMcpPrivateMetadataBridge } from "./managed-mcp-private-metadata.js";

const NOW_MS = 1_800_000_000_000;

function makeLogger(): ComisLogger {
  return {
    level: "debug",
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
    error: vi.fn(), fatal: vi.fn(), audit: vi.fn(),
    child: vi.fn(function child() { return this; }),
  } as unknown as ComisLogger;
}

/**
 * One service exposing both shapes at once. The scopes deliberately include
 * attention: the point is that holding it changes nothing about what the
 * mutation requires.
 */
function dataOperationView(scopes: readonly string[] = ["health", "report", "attention_response"]) {
  return {
    viewHash: "c".repeat(64),
    definitions: [{
      contributionId: "data.fixture",
      serviceDefinitionId: "data.fixture-definition",
      mcpServerName: "data-fixture",
      managedToolBindings: [
        {
          toolName: "inspect_records",
          behavior: "prepare_run" as const,
          actionClassification: "read" as const,
          invocationSideEffects: [] as readonly string[],
        },
        {
          toolName: "apply_change",
          behavior: "prepare_run" as const,
          actionClassification: "mutate" as const,
          invocationSideEffects: ["external_write"] as readonly string[],
        },
      ],
      requestedScopes: scopes,
      evidencePolicies: [] as const,
    }],
    instances: [{
      contributionId: "data.fixture",
      serviceDefinitionId: "data.fixture-definition",
      serviceInstanceId: "service-instance_data",
      mcpServerName: "data-fixture",
      allowedAgents: ["agent_a"],
      allowedWorkspaceRoots: [],
      allowedRuntimeRoots: [],
      state: "active" as const,
      activeScopes: scopes,
    }],
  };
}

function dataOperationDeps(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent_a",
    activeView: dataOperationView(),
    capturedAgentCapabilities: ["orch:read"] as const,
    getCapturedToolIds: () => [
      "mcp:data-fixture/inspect_records",
      "mcp:data-fixture/apply_change",
    ],
    nowMs: () => NOW_MS,
    resolveRootRunId: () => ok("root-run_a"),
    getManagedRunByExternalRef: vi.fn(async () => ok(undefined)),
    activatePrepared: vi.fn(async () => ok({ kind: "activated" as const })),
    logger: makeLogger(),
    ...overrides,
  };
}

function metadataFor(toolName: string, deps = dataOperationDeps()) {
  const bridge = createManagedMcpPrivateMetadataBridge(deps);
  return bridge.resolveRegistrationMetadata?.({
    serverName: "data-fixture",
    toolName,
    qualifiedName: `mcp:data-fixture/${toolName}`,
  });
}

describe("data-operation fixture conformance", () => {
  it("keeps the inspection read-only and the mutation separately gated", () => {
    const inspection = metadataFor("inspect_records");
    const mutation = metadataFor("apply_change");

    expect(inspection?.actionClassification).toBe("read");
    // A read that carried the sibling's side effects would be gated as though it
    // changed the world, and an agent would learn to route around the gate.
    expect(inspection?.invocationSideEffects).toEqual([]);

    expect(mutation?.actionClassification).toBe("mutate");
    expect(mutation?.invocationSideEffects).toEqual(["external_write"]);
  });

  it("does not let the attention scope stand in for the mutation's approval", () => {
    // The service holds attention_response: it can ask a human a question and
    // receive an answer. That is a different act from approving a side effect,
    // and it must not weaken what the mutation declares. The same binding
    // resolved on a service without the scope must produce identical authority.
    const withAttention = metadataFor("apply_change");
    const withoutAttention = metadataFor("apply_change", dataOperationDeps({
      activeView: dataOperationView(["health", "report"]),
    }));

    expect(withAttention).toEqual(withoutAttention);
    expect(withAttention?.invocationSideEffects).toEqual(["external_write"]);
    expect(withAttention?.actionClassification).not.toBe("read");
  });

  it("fails an unresolvable binding closed to destructive rather than open to read", () => {
    // Two definitions claiming the same server and tool name is an ambiguity the
    // host cannot resolve. The safe answer is the most restrictive one: treating
    // an unresolvable tool as a read would let a mutation run ungated precisely
    // when the runtime has lost track of what the tool is.
    const ambiguous = dataOperationView();
    const duplicate = {
      ...ambiguous.definitions[0]!,
      serviceDefinitionId: "data.fixture-duplicate",
    };
    const metadata = metadataFor("apply_change", dataOperationDeps({
      activeView: { ...ambiguous, definitions: [ambiguous.definitions[0]!, duplicate] },
    }));

    expect(metadata?.actionClassification).toBe("destructive");
  });

  it("publishes nothing for a tool no active instance authorizes for this agent", () => {
    // An unknown tool is not a permissive default. It has no managed metadata at
    // all, so nothing downstream can mistake it for a reviewed read.
    const foreign = metadataFor("apply_change", dataOperationDeps({ agentId: "agent_b" }));

    expect(foreign?.actionClassification).toBe("destructive");
  });
});
