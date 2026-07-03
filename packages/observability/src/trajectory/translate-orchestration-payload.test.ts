// SPDX-License-Identifier: Apache-2.0
/**
 * Content-free translator unit tests for the `capability:audited`
 * spawn-tree producer event.
 *
 * The `capability:audited` translator is the chokepoint that decides which
 * payload fields cross into the persisted trajectory. It MUST forward ONLY the
 * content-free per-node tuple — capability + tool NAME + decision + the
 * lease/root ids — and MUST strip the envelope (agentId/timestamp) plus any
 * tool args, message body, file path, or secret-shaped value that a careless
 * emit might have attached. The `subagent:steered` /
 * `subagent:budget_exceeded` arms are the exact precedent.
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  translateOrchestrationPayload,
  type OrchestrationBridgedEventName,
} from "./translate-orchestration-payload.js";

describe("translateOrchestrationPayload — capability:audited (content-free)", () => {
  it("forwards ONLY {capability, tool, decision, leaseId, parentLeaseId, rootRunId} for an allow record (socket full tuple)", () => {
    const data = translateOrchestrationPayload(
      "capability:audited" as OrchestrationBridgedEventName,
      {
        // envelope correlation ids — MUST be stripped (ride the recorder envelope):
        agentId: "agent-A",
        timestamp: 1_717_171_717,
        // the method identifier is an envelope-ish label — not part of the node tuple:
        method: "tool.invoke",
        // the content-free per-node tuple:
        capability: "orch:read",
        tool: "memory_search",
        decision: "allow",
        leaseId: "lease-abc",
        parentLeaseId: "lease-root",
        rootRunId: "run-1",
      },
    );
    expect(data).toEqual({
      capability: "orch:read",
      tool: "memory_search",
      decision: "allow",
      leaseId: "lease-abc",
      parentLeaseId: "lease-root",
      rootRunId: "run-1",
    });
    // The envelope keys MUST NOT leak into data.
    expect(data.agentId).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
    expect(data.method).toBeUndefined();
  });

  it("forwards the in-process shape (no leaseId/parentLeaseId — honest absence) for a deny record", () => {
    const data = translateOrchestrationPayload(
      "capability:audited" as OrchestrationBridgedEventName,
      {
        agentId: "agent-B",
        timestamp: 1_717_171_718,
        capability: "orch:spawn",
        decision: "deny",
        rootRunId: "root-session-tenant:user:channel",
        // in-process path: leaseId/parentLeaseId/tool are absent (undefined)
        leaseId: undefined,
        parentLeaseId: undefined,
        tool: undefined,
      },
    );
    expect(data.capability).toBe("orch:spawn");
    expect(data.decision).toBe("deny");
    expect(data.rootRunId).toBe("root-session-tenant:user:channel");
    // Honest absence in-process — no fabricated lease.
    expect(data.leaseId).toBeUndefined();
    expect(data.parentLeaseId).toBeUndefined();
    expect(data.agentId).toBeUndefined();
  });

  it("never forwards tool args / a message body / a file path / a secret value even if present (T-215-01 content-free)", () => {
    const data = translateOrchestrationPayload(
      "capability:audited" as OrchestrationBridgedEventName,
      {
        agentId: "agent-C",
        timestamp: 1_717_171_719,
        capability: "orch:message",
        tool: "message_send",
        decision: "allow",
        leaseId: "lease-xyz",
        rootRunId: "run-9",
        // hostile extras that MUST NOT cross into the trajectory:
        args: { body: "the actual chat message body" },
        params: { url: "https://internal.example/path" },
        path: "/home/user/.comis/secret.txt",
        apiKey: "sk-PLANTED-SECRET-TOKEN",
        body: "another body field",
      } as Record<string, unknown>,
    );
    expect(data).toEqual({
      capability: "orch:message",
      tool: "message_send",
      decision: "allow",
      leaseId: "lease-xyz",
      // parentLeaseId absent on this record → undefined key value
      parentLeaseId: undefined,
      rootRunId: "run-9",
    });
    const json = JSON.stringify(data);
    expect(json).not.toContain("sk-PLANTED-SECRET-TOKEN");
    expect(json).not.toContain("the actual chat message body");
    expect(json).not.toContain("internal.example");
    expect(json).not.toContain("secret.txt");
    expect("args" in data).toBe(false);
    expect("params" in data).toBe(false);
    expect("path" in data).toBe(false);
    expect("apiKey" in data).toBe(false);
    expect("body" in data).toBe(false);
  });
});

describe("translateOrchestrationPayload — graph:node_spawned (content-free)", () => {
  it("forwards ONLY {graphId, nodeId, nodeAgentId, rootRunId, tokenBudget} — child agent rides nodeAgentId, not the correlation key agentId", () => {
    const data = translateOrchestrationPayload(
      "graph:node_spawned" as OrchestrationBridgedEventName,
      {
        graphId: "g1",
        nodeId: "analyst-0",
        agentId: "analyst", // the node's CHILD agent → mapped to nodeAgentId
        rootRunId: "run-1",
        tokenBudget: 5000,
        timestamp: 1_717_171_719, // envelope-only — stripped
        // hostile extras that MUST NOT cross into the trajectory:
        task: "Research NVDA Q3 earnings and the analyst sentiment",
        output: "the node's full LLM output",
      } as Record<string, unknown>,
    );
    expect(data).toEqual({
      graphId: "g1",
      nodeId: "analyst-0",
      nodeAgentId: "analyst",
      rootRunId: "run-1",
      tokenBudget: 5000,
    });
    // The correlation key `agentId` is NOT forwarded (it would be stripped to the
    // envelope); the child identity rides `nodeAgentId` instead.
    expect("agentId" in data).toBe(false);
    expect("timestamp" in data).toBe(false);
    const json = JSON.stringify(data);
    expect(json).not.toContain("Research NVDA"); // never the node task
    expect(json).not.toContain("full LLM output"); // never the node output
  });
});
