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

describe("translateOrchestrationPayload — orchestrate:run_summary (content-free)", () => {
  it("forwards ONLY the content-free run fields (ids + closed enums + counts + estimates) and STRIPS the envelope", () => {
    const data = translateOrchestrationPayload(
      "orchestrate:run_summary" as OrchestrationBridgedEventName,
      {
        // envelope correlation ids — MUST be stripped (ride the recorder envelope):
        agentId: "agent-A",
        sessionKey: "tenant:user:channel",
        timestamp: 1_717_171_717,
        // the content-free per-run fact:
        runId: "orch-abc",
        leaseId: "child-lease-1",
        rootRunId: "root-agent-1",
        language: "ts",
        durationMs: 1234,
        exitCode: 1,
        failureClass: "nonzero_exit",
        stdoutBytesRaw: 50_000,
        stdoutCharsReentered: 30_000,
        resultRefCount: 3,
        resultRefBytes: 122_880,
        estSavedTokens: 30_208,
        savedRatio: 0.983,
      },
    );
    expect(data).toEqual({
      runId: "orch-abc",
      leaseId: "child-lease-1",
      rootRunId: "root-agent-1",
      language: "ts",
      durationMs: 1234,
      exitCode: 1,
      failureClass: "nonzero_exit",
      stdoutBytesRaw: 50_000,
      stdoutCharsReentered: 30_000,
      resultRefCount: 3,
      resultRefBytes: 122_880,
      estSavedTokens: 30_208,
      savedRatio: 0.983,
    });
    // The envelope keys MUST NOT leak into data (the daemon-shared bus fans out to
    // every session bridge — data self-attributes via rootRunId, never sessionKey).
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("forwards a SUCCESS run (no failureClass, exitCode 0) with the savings numbers", () => {
    const data = translateOrchestrationPayload(
      "orchestrate:run_summary" as OrchestrationBridgedEventName,
      {
        agentId: "agent-B",
        timestamp: 1_717_171_718,
        runId: "orch-ok",
        leaseId: "child-lease-2",
        rootRunId: "root-agent-2",
        language: "js",
        durationMs: 42,
        exitCode: 0,
        // failureClass ABSENT on a clean run
        stdoutBytesRaw: 10,
        stdoutCharsReentered: 10,
        resultRefCount: 0,
        resultRefBytes: 0,
        estSavedTokens: 0,
        savedRatio: 0,
      },
    );
    expect(data.runId).toBe("orch-ok");
    expect(data.exitCode).toBe(0);
    expect(data.language).toBe("js");
    expect(data.resultRefCount).toBe(0);
    // No failure class on a successful run.
    expect(data.failureClass).toBeUndefined();
    expect(data.agentId).toBeUndefined();
  });

  it("never forwards a stderr tail / the script body / tool params even if present (INV-5 content-free)", () => {
    const data = translateOrchestrationPayload(
      "orchestrate:run_summary" as OrchestrationBridgedEventName,
      {
        agentId: "agent-C",
        timestamp: 1_717_171_719,
        runId: "orch-hostile",
        rootRunId: "root-agent-3",
        language: "ts",
        durationMs: 7,
        exitCode: 2,
        failureClass: "nonzero_exit",
        stdoutBytesRaw: 1,
        stdoutCharsReentered: 1,
        resultRefCount: 0,
        resultRefBytes: 0,
        // hostile extras that MUST NOT cross into the trajectory:
        stderrTail: "TypeError: content.trim is not a function\n    at run.ts:5",
        script: "await comis_tools.web_fetch('https://internal.example/secret')",
        params: { url: "https://internal.example/path" },
        apiKey: "sk-PLANTED-SECRET-TOKEN",
      } as Record<string, unknown>,
    );
    const json = JSON.stringify(data);
    expect(json).not.toContain("sk-PLANTED-SECRET-TOKEN");
    expect(json).not.toContain("content.trim is not a function");
    expect(json).not.toContain("internal.example");
    expect(json).not.toContain("comis_tools.web_fetch");
    expect("stderrTail" in data).toBe(false);
    expect("script" in data).toBe(false);
    expect("params" in data).toBe(false);
    expect("apiKey" in data).toBe(false);
  });

  it("forwards toolSequence verbatim — order + repeats preserved (NOT sorted/deduped); the turn traceId is NOT forwarded", () => {
    const data = translateOrchestrationPayload(
      "orchestrate:run_summary" as OrchestrationBridgedEventName,
      {
        agentId: "agent-seq",
        sessionKey: "tenant:user:channel",
        timestamp: 1_717_171_720,
        // the turn correlator rides the event but is redundant on the (already
        // traceId-keyed) trajectory record — it MUST NOT be forwarded into data:
        traceId: "7f1c9a2e-3b4d-4c5e-8a6f-0d1e2f3a4b5c",
        runId: "orch-seq",
        leaseId: "child-lease-seq",
        rootRunId: "root-agent-seq",
        language: "ts",
        durationMs: 500,
        exitCode: 0,
        stdoutBytesRaw: 20,
        stdoutCharsReentered: 20,
        resultRefCount: 2,
        resultRefBytes: 4096,
        estSavedTokens: 900,
        savedRatio: 0.9,
        // the content-free ordered descriptor — jq appears TWICE (its call count):
        toolSequence: ["web_search", "jq", "jq", "web_fetch"],
      },
    );
    // Rides verbatim — order + repeats preserved, NOT sorted, NOT deduped.
    expect(data.toolSequence).toEqual(["web_search", "jq", "jq", "web_fetch"]);
    // The turn traceId is deliberately stripped (the trajectory record is already traceId-keyed).
    expect(data.traceId).toBeUndefined();
    expect("traceId" in data).toBe(false);
    // The shipped projection is unchanged (no regression to the existing fields).
    expect(data.runId).toBe("orch-seq");
    expect(data.resultRefCount).toBe(2);
    expect(data.savedRatio).toBe(0.9);
  });

  it("omits toolSequence for a tool-less run — no phantom descriptor (sibling omit discipline)", () => {
    const data = translateOrchestrationPayload(
      "orchestrate:run_summary" as OrchestrationBridgedEventName,
      {
        runId: "orch-empty",
        rootRunId: "root-agent-empty",
        language: "js",
        durationMs: 5,
        exitCode: 0,
        stdoutBytesRaw: 0,
        stdoutCharsReentered: 0,
        resultRefCount: 0,
        resultRefBytes: 0,
        // toolSequence ABSENT — a run with zero cap-mapped call sites.
      },
    );
    // Mirrors the estSavedTokens/failureClass omit shape in this file (absent key → undefined).
    expect(data.toolSequence).toBeUndefined();
    expect(data.runId).toBe("orch-empty");
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
