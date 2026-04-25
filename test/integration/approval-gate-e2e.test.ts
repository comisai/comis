// SPDX-License-Identifier: Apache-2.0
/**
 * APPROVAL GATE E2E: Full lifecycle integration tests for the approval gate.
 *
 * Validates the complete approval pipeline against a running daemon:
 *   TEST-06-01: admin.approval.pending returns empty when no requests pending
 *   TEST-06-02: Approve flow -- requestApproval blocks, RPC resolve unblocks with approved=true
 *   TEST-06-03: Deny flow -- requestApproval blocks, RPC resolve unblocks with approved=false
 *   TEST-06-04: Timeout flow -- requestApproval auto-denies after 3s
 *   TEST-06-05: SSE streams approval:requested and approval:resolved events
 *   TEST-06-06: Idempotent resolution does not throw on double-resolve
 *   TEST-06-07: WebSocket RPC can list pending and resolve approval requests
 *   TEST-06-08: Tool wrapper triggers approval and completes on approve
 *   TEST-06-09: Tool wrapper triggers approval and returns denial on deny
 *
 * Uses a dedicated config (port 8522, separate memory DB) to avoid conflicts.
 * Accesses daemon internals directly: approvalGate, rpcCall.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
  makeAuthHeaders,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { RPC_FAST_MS } from "../support/timeouts.js";
import type { ApprovalGate } from "@comis/core";
import { runWithContext } from "@comis/core";
import { createAgentsManageTool } from "@comis/skills";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-approval-gate-e2e.yaml",
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** SSE event parsed from text/event-stream format. */
interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

// ---------------------------------------------------------------------------
// SSE Helper
// ---------------------------------------------------------------------------

/**
 * Read SSE events from a streaming fetch response.
 *
 * Parses the text/event-stream format: fields separated by newlines,
 * events separated by double newlines. Collects up to maxEvents or
 * until timeoutMs elapsed, then aborts and returns collected events.
 */
async function readSseEvents(
  response: Response,
  maxEvents: number,
  timeoutMs: number,
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];

  if (!response.body) {
    return events;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const abortTimeout = setTimeout(() => {
    reader.cancel().catch(() => {});
  }, timeoutMs);

  try {
    while (events.length < maxEvents) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by double newlines
      const parts = buffer.split("\n\n");

      // The last part may be incomplete; keep it in the buffer
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) {
          continue;
        }

        const event: SseEvent = { data: "" };
        const lines = part.split("\n");

        for (const line of lines) {
          if (line.startsWith("event:")) {
            event.event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            event.data = line.slice(5).trim();
          } else if (line.startsWith("id:")) {
            event.id = line.slice(3).trim();
          }
        }

        events.push(event);

        if (events.length >= maxEvents) {
          break;
        }
      }
    }
  } catch {
    // Reader was cancelled by timeout or stream ended -- expected
  } finally {
    clearTimeout(abortTimeout);
    reader.cancel().catch(() => {});
  }

  return events;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("APPROVAL GATE E2E: Full Lifecycle Integration", () => {
  let handle: TestDaemonHandle;
  let approvalGate: ApprovalGate;
  let rpcCall: TestDaemonHandle["daemon"]["rpcCall"];

  beforeAll(async () => {
    // Wipe the test dataDir so the daemon does not restore approval cache
    // entries (restart-approval-cache.json) or pending requests
    // (restart-approvals.json) from a prior test run -- those would
    // auto-approve / auto-deny new requests via cache hits and break the
    // deterministic pending-count and denial-flow assertions below.
    const { rmSync } = await import("node:fs");
    rmSync("/tmp/comis-test-approval-gate-e2e", { recursive: true, force: true });

    handle = await startTestDaemon({ configPath: CONFIG_PATH });

    // Access typed approvalGate directly (exposed via DaemonInstance)
    approvalGate = handle.daemon.approvalGate!;
    expect(approvalGate).toBeDefined();

    // Access internal rpcCall from daemon instance
    rpcCall = handle.daemon.rpcCall;
    expect(rpcCall).toBeDefined();
  }, 120_000);

  afterAll(async () => {
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        // Expected: graceful shutdown calls the overridden exit() which throws.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
  }, 30_000);

  // =========================================================================
  // Section 1: Approval Gate Pending RPC
  // =========================================================================

  describe("Approval Gate Pending RPC", () => {
    it(
      "TEST-06-01: admin.approval.pending returns empty when no requests pending",
      async () => {
        const result = (await rpcCall("admin.approval.pending", { _trustLevel: "admin" })) as {
          requests: unknown[];
          total: number;
        };

        expect(result).toBeDefined();
        expect(result.requests).toEqual([]);
        expect(result.total).toBe(0);
      },
      10_000,
    );
  });

  // =========================================================================
  // Section 2: Approval Approve Flow (the core E2E test)
  // =========================================================================

  describe("Approval Approve Flow", () => {
    it(
      "TEST-06-02: requestApproval blocks, RPC resolve unblocks with approved=true",
      async () => {
        // 1. Start requestApproval in a Promise (this BLOCKS until resolved)
        const approvalPromise = approvalGate.requestApproval({
          toolName: "agents_manage",
          action: "agents.create",
          params: { agent_id: "test-agent" },
          agentId: "test-user",
          sessionKey: "test:test-user:test-chan",
          trustLevel: "admin",
        });

        // 2. Wait briefly for the event bus to fire
        await new Promise((resolve) => setTimeout(resolve, 50));

        // 3. Call rpcCall to list pending requests
        const pendingResult = (await rpcCall("admin.approval.pending", { _trustLevel: "admin" })) as {
          requests: Array<{
            requestId: string;
            toolName: string;
            action: string;
            params: Record<string, unknown>;
          }>;
          total: number;
        };

        // 4. Verify the pending request has correct fields
        expect(pendingResult.total).toBe(1);
        expect(pendingResult.requests).toHaveLength(1);
        const pendingReq = pendingResult.requests[0]!;
        expect(pendingReq.toolName).toBe("agents_manage");
        expect(pendingReq.action).toBe("agents.create");
        expect(pendingReq.params.agent_id).toBe("test-agent");

        // 5. Resolve via RPC
        await rpcCall("admin.approval.resolve", {
          requestId: pendingReq.requestId,
          approved: true,
          approvedBy: "test-operator",
          _trustLevel: "admin",
        });

        // 6. Await the original promise -- should resolve with approved=true
        const resolution = await approvalPromise;
        expect(resolution.approved).toBe(true);
        expect(resolution.approvedBy).toBe("test-operator");
        expect(resolution.requestId).toBe(pendingReq.requestId);

        // 7. Verify pending is now empty
        const afterResult = (await rpcCall("admin.approval.pending", { _trustLevel: "admin" })) as {
          requests: unknown[];
          total: number;
        };
        expect(afterResult.total).toBe(0);
        expect(afterResult.requests).toEqual([]);
      },
      10_000,
    );
  });

  // =========================================================================
  // Section 3: Approval Deny Flow
  // =========================================================================

  describe("Approval Deny Flow", () => {
    it(
      "TEST-06-03: requestApproval blocks, RPC resolve unblocks with approved=false and reason",
      async () => {
        // Start requestApproval
        const approvalPromise = approvalGate.requestApproval({
          toolName: "channels_manage",
          action: "channels.disable",
          params: { channel: "discord" },
          agentId: "test-user",
          sessionKey: "test:test-user:test-chan",
          trustLevel: "admin",
        });

        // Wait for event bus
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Get the pending request
        const pendingResult = (await rpcCall("admin.approval.pending", { _trustLevel: "admin" })) as {
          requests: Array<{ requestId: string }>;
          total: number;
        };
        expect(pendingResult.total).toBe(1);
        const requestId = pendingResult.requests[0]!.requestId;

        // Deny with reason
        await rpcCall("admin.approval.resolve", {
          requestId,
          approved: false,
          approvedBy: "test-operator",
          reason: "Not safe to disable",
          _trustLevel: "admin",
        });

        // Verify resolution
        const resolution = await approvalPromise;
        expect(resolution.approved).toBe(false);
        expect(resolution.approvedBy).toBe("test-operator");
        expect(resolution.reason).toBe("Not safe to disable");

        // Verify pending is empty
        const afterResult = (await rpcCall("admin.approval.pending", { _trustLevel: "admin" })) as {
          total: number;
        };
        expect(afterResult.total).toBe(0);
      },
      10_000,
    );
  });

  // =========================================================================
  // Section 4: Approval Timeout Auto-Deny
  // =========================================================================

  describe("Approval Timeout Auto-Deny", () => {
    it(
      "TEST-06-04: requestApproval auto-denies after configured timeout (3s)",
      async () => {
        const startMs = Date.now();

        // Start requestApproval -- config has 3s timeout
        const resolution = await approvalGate.requestApproval({
          toolName: "tokens_manage",
          action: "tokens.revoke",
          params: { token_id: "old-token" },
          agentId: "test-user",
          sessionKey: "test:test-user:test-chan",
          trustLevel: "admin",
        });

        const elapsedMs = Date.now() - startMs;

        // Should auto-deny after ~3s
        expect(resolution.approved).toBe(false);
        expect(resolution.approvedBy).toBe("system:timeout");
        expect(resolution.reason).toBe("Approval request timed out");

        // Elapsed time should be at least 2.5s but not more than 6s
        expect(elapsedMs).toBeGreaterThanOrEqual(2500);
        expect(elapsedMs).toBeLessThan(6000);
      },
      10_000,
    );
  });

  // =========================================================================
  // Section 5: SSE Approval Events
  // =========================================================================

  describe("SSE Approval Events", () => {
    it(
      "TEST-06-05: SSE streams approval:requested and approval:resolved events",
      async () => {
        // 1. Open an SSE connection to /api/events
        const controller = new AbortController();

        try {
          const response = await fetch(`${handle.gatewayUrl}/api/events`, {
            headers: { Authorization: `Bearer ${handle.authToken}` },
            signal: controller.signal,
          });

          expect(response.status).toBe(200);
          const contentType = response.headers.get("content-type") ?? "";
          expect(contentType).toMatch(/^text\/event-stream/);

          // 2. Trigger a requestApproval on the gate (with a short delay to ensure SSE is connected)
          await new Promise((resolve) => setTimeout(resolve, 200));

          const approvalPromise = approvalGate.requestApproval({
            toolName: "agents_manage",
            action: "agents.suspend",
            params: { agent_id: "helper" },
            agentId: "test-user",
            sessionKey: "test:test-user:test-chan",
            trustLevel: "admin",
          });

          // 3. Wait briefly for event to be emitted
          await new Promise((resolve) => setTimeout(resolve, 200));

          // 4. Resolve the approval via the gate directly (faster than RPC for this test)
          const pending = approvalGate.pending();
          expect(pending.length).toBe(1);
          approvalGate.resolveApproval(pending[0]!.requestId, true, "sse-test-operator");

          // 5. Await the approval promise
          const resolution = await approvalPromise;
          expect(resolution.approved).toBe(true);

          // 6. Read SSE events (the retry event + any approval events)
          // We read with a short timeout since events have already been emitted
          const events = await readSseEvents(response, 10, 3_000);

          // 7. Verify we received approval events in the SSE stream
          const requestedEvents = events.filter((e) => e.event === "approval:requested");
          const resolvedEvents = events.filter((e) => e.event === "approval:resolved");

          expect(requestedEvents.length).toBeGreaterThanOrEqual(1);
          expect(resolvedEvents.length).toBeGreaterThanOrEqual(1);

          // Verify the requested event has correct data
          const reqData = JSON.parse(requestedEvents[0]!.data) as {
            toolName: string;
            action: string;
          };
          expect(reqData.toolName).toBe("agents_manage");
          expect(reqData.action).toBe("agents.suspend");

          // Verify the resolved event has correct data
          const resData = JSON.parse(resolvedEvents[0]!.data) as {
            approved: boolean;
            approvedBy: string;
          };
          expect(resData.approved).toBe(true);
          expect(resData.approvedBy).toBe("sse-test-operator");
        } finally {
          controller.abort();
        }
      },
      15_000,
    );
  });

  // =========================================================================
  // Section 6: Idempotent Resolution
  // =========================================================================

  describe("Idempotent Resolution", () => {
    it(
      "TEST-06-06: double-resolve on gate is idempotent, RPC throws for already-resolved",
      async () => {
        // 1. Create a request and resolve it
        const approvalPromise = approvalGate.requestApproval({
          toolName: "memory_manage",
          action: "memory.flush",
          params: {},
          agentId: "test-user",
          sessionKey: "test:test-user:test-chan",
          trustLevel: "admin",
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        const pending = approvalGate.pending();
        expect(pending.length).toBe(1);
        const requestId = pending[0]!.requestId;

        // First resolve -- should succeed
        approvalGate.resolveApproval(requestId, true, "first-operator");
        const resolution = await approvalPromise;
        expect(resolution.approved).toBe(true);

        // 2. Second resolve on the gate directly -- idempotent, should NOT throw
        expect(() => {
          approvalGate.resolveApproval(requestId, false, "second-operator");
        }).not.toThrow();

        // 3. RPC handler throws for already-resolved request (not found in pending)
        await expect(
          rpcCall("admin.approval.resolve", {
            requestId,
            approved: false,
            approvedBy: "rpc-operator",
            _trustLevel: "admin",
          }),
        ).rejects.toThrow(/not found/i);
      },
      10_000,
    );
  });

  // =========================================================================
  // Section 7: WebSocket RPC Approval Flow
  // =========================================================================

  describe("WebSocket RPC Approval Flow", () => {
    it(
      "TEST-06-07: WebSocket RPC can list pending and resolve approval requests",
      async () => {
        let ws: WebSocket | undefined;

        try {
          // 1. Open authenticated WebSocket
          ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
          expect(ws.readyState).toBe(WebSocket.OPEN);

          // 2. Send admin.approval.pending via WS -- verify empty
          const emptyResponse = (await sendJsonRpc(
            ws,
            "admin.approval.pending",
            {},
            1,
            { timeoutMs: RPC_FAST_MS },
          )) as { result: { requests: unknown[]; total: number } };

          expect(emptyResponse.result.total).toBe(0);
          expect(emptyResponse.result.requests).toEqual([]);

          // 3. Trigger an approval request on the gate
          const approvalPromise = approvalGate.requestApproval({
            toolName: "sessions_manage",
            action: "sessions.delete",
            params: { session_key: "test:user:chan" },
            agentId: "test-user",
            sessionKey: "test:test-user:test-chan",
            trustLevel: "admin",
          });

          await new Promise((resolve) => setTimeout(resolve, 100));

          // 4. Send admin.approval.pending via WS -- verify it shows up
          const pendingResponse = (await sendJsonRpc(
            ws,
            "admin.approval.pending",
            {},
            2,
            { timeoutMs: RPC_FAST_MS },
          )) as { result: { requests: Array<{ requestId: string; toolName: string }>; total: number } };

          expect(pendingResponse.result.total).toBe(1);
          expect(pendingResponse.result.requests[0]!.toolName).toBe("sessions_manage");
          const requestId = pendingResponse.result.requests[0]!.requestId;

          // 5. Send admin.approval.resolve via WS -- verify success
          const resolveResponse = (await sendJsonRpc(
            ws,
            "admin.approval.resolve",
            {
              requestId,
              approved: true,
              approvedBy: "ws-operator",
            },
            3,
            { timeoutMs: RPC_FAST_MS },
          )) as { result: { requestId: string; approved: boolean; approvedBy: string } };

          expect(resolveResponse.result.requestId).toBe(requestId);
          expect(resolveResponse.result.approved).toBe(true);
          expect(resolveResponse.result.approvedBy).toBe("ws-operator");

          // Verify the approval promise resolved
          const resolution = await approvalPromise;
          expect(resolution.approved).toBe(true);
          expect(resolution.approvedBy).toBe("ws-operator");
        } finally {
          // 6. Close WS
          ws?.close();
        }
      },
      10_000,
    );
  });

  // =========================================================================
  // Section 8: Tool Wrapper -> Approval Gate Integration
  // =========================================================================

  describe("Tool Wrapper -> Approval Gate Integration", () => {
    // Spy on process.kill to no-op SIGUSR1 signals (persistToConfig sends SIGUSR1
    // after agent create/delete, which triggers full daemon shutdown and breaks
    // subsequent tests that depend on the same approval gate reference).
    let killSpy: ReturnType<typeof vi.spyOn>;

    beforeAll(() => {
      killSpy = vi
        .spyOn(process, "kill")
        .mockImplementation(
          ((pid: number, signal?: string | number) => {
            if (signal === "SIGUSR1") return true;
            return process.kill.call(process, pid, signal as string);
          }) as typeof process.kill,
        );
    });

    afterAll(() => {
      if (killSpy) killSpy.mockRestore();
    });

    it(
      "TEST-06-08: Tool wrapper triggers approval and completes on approve",
      async () => {
        // 1. Create the tool wired to daemon's rpcCall and approvalGate
        // Wrap rpcCall to inject _trustLevel: "admin" so mutating RPC calls succeed
        const adminRpcCall: typeof rpcCall = (method, params) =>
          rpcCall(method, { ...params, _trustLevel: "admin" });
        const tool = createAgentsManageTool(adminRpcCall, approvalGate);

        // 2. Start tool execute in a runWithContext scope with admin trust level
        const executePromise = runWithContext(
          {
            tenantId: "test",
            userId: "admin-operator",
            sessionKey: "test:admin-operator:e2e-channel",
            traceId: randomUUID(),
            startedAt: Date.now(),
            trustLevel: "admin",
          },
          () =>
            tool.execute("call-approve-1", {
              action: "create",
              agent_id: "tool-test-approve-agent",
              config: { name: "Tool Test Agent", model: "test-model" },
            }),
        );

        // 3. Wait briefly for the approval request to be registered
        await new Promise((r) => setTimeout(r, 200));

        // 4. Verify a pending approval exists via RPC
        const pending = (await rpcCall("admin.approval.pending", { _trustLevel: "admin" })) as {
          requests: Array<{
            requestId: string;
            toolName: string;
            action: string;
          }>;
          total: number;
        };

        expect(pending.total).toBe(1);
        expect(pending.requests).toHaveLength(1);
        expect(pending.requests[0]!.toolName).toBe("agents_manage");
        expect(pending.requests[0]!.action).toBe("agents.create");

        // 5. Approve it via RPC
        await rpcCall("admin.approval.resolve", {
          requestId: pending.requests[0]!.requestId,
          approved: true,
          _trustLevel: "admin",
        });

        // 6. Await the execute promise
        const result = await executePromise;

        // 7. Assert the result is successful (no error in details)
        expect(result.content).toHaveLength(1);
        expect(result.content[0]!.text).not.toContain("Error:");
        expect(result.details).toBeDefined();
        expect((result.details as Record<string, unknown>).error).toBeUndefined();

        // 8. Clean up: delete the created agent
        try {
          await rpcCall("agents.delete", {
            agentId: "tool-test-approve-agent",
            _trustLevel: "admin",
          });
        } catch {
          // Ignore if agent wasn't fully created
        }
      },
      30_000,
    );

    it(
      "TEST-06-09: Tool wrapper triggers approval and returns denial on deny",
      // Disable vitest's auto-retry. A retry would re-run the test against a
      // daemon whose denial cache (60s TTL, in-memory only) still holds the
      // denial from this test's first attempt, causing the second attempt to
      // be auto-denied without ever creating a pending entry.
      { retry: 0 },
      async () => {
        // 1. Create the tool wired to daemon's rpcCall and approvalGate.
        // Wrap rpcCall to inject _trustLevel: "admin" so mutating RPC calls succeed.
        const adminRpcCall: typeof rpcCall = (method, params) =>
          rpcCall(method, { ...params, _trustLevel: "admin" });
        const tool = createAgentsManageTool(adminRpcCall, approvalGate);

        // 2. Start tool execute in a runWithContext scope with admin trust level.
        // Use a distinct sessionKey from TEST-06-08 to avoid the batch-approval
        // cache (keyed by `${sessionKey}::${action}`) auto-approving this request.
        const executePromise = runWithContext(
          {
            tenantId: "test",
            userId: "admin-operator",
            sessionKey: "test:admin-operator:e2e-deny-channel",
            traceId: randomUUID(),
            startedAt: Date.now(),
            trustLevel: "admin",
          },
          () =>
            tool.execute("call-deny-1", {
              action: "create",
              agent_id: "tool-test-deny-agent",
              config: { name: "Tool Test Deny Agent", model: "test-model" },
            }),
        );

        // 3. Wait briefly for the approval request to be registered
        await new Promise((r) => setTimeout(r, 200));

        // 4. Verify a pending approval exists via RPC
        const pending = (await rpcCall("admin.approval.pending", { _trustLevel: "admin" })) as {
          requests: Array<{
            requestId: string;
            toolName: string;
            action: string;
          }>;
          total: number;
        };

        expect(pending.total).toBe(1);
        expect(pending.requests).toHaveLength(1);
        expect(pending.requests[0]!.action).toBe("agents.create");

        // 5. Deny it via RPC with a reason
        await rpcCall("admin.approval.resolve", {
          requestId: pending.requests[0]!.requestId,
          approved: false,
          reason: "E2E deny test",
          _trustLevel: "admin",
        });

        // 6. Tool wrapper throws on denial (admin-manage-factory.ts calls
        // throwToolError when resolution.approved is false). Assert the
        // rejection contains the action name and the denial reason from step 5.
        let thrown: unknown;
        try {
          await executePromise;
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toContain("Action denied");
        expect(message).toContain("agents.create");
        expect(message).toContain("E2E deny test");
      },
      30_000,
    );
  });
});
