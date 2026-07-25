// SPDX-License-Identifier: Apache-2.0
/**
 * SEC-05 — gateway token scope enforcement + approval-gate pause/resolve.
 *
 * Certifies two trust-boundary primitives deterministically:
 *   (a) GatewayTokenSchema scope-disjointness refine — a token carrying "mcp-client"
 *       MUST be the sole scope; co-issuance with admin/rpc/* is REJECTED at config-load
 *       (an external MCP credential cannot escalate to operator RPC). Valid sole-scope /
 *       operator postures parse.
 *   (b) createApprovalGate pause→resolve — requestApproval blocks + emits approval:requested;
 *       resolveApproval unblocks + emits approval:resolved.
 *
 * Both are pure (no daemon/key/network). The live-gateway admin-RPC-denial + per-client
 * rate-limit-429 over hono-server.ts is Stage-C (it.skip).
 *
 * costTier: "$0".
 *
 * @module
 */

import { createHash } from "node:crypto";
import { describe, it, expect, afterEach } from "vitest";
import { GatewayTokenSchema, createApprovalGate, ConversationRefSchema, TypedEventBus } from "@comis/core";
import type { ApprovalGate } from "@comis/core";

const isLive = !!process.env["COMIS_LIVE"];

// ---------------------------------------------------------------------------
// ClockPort / TimerPort test doubles — copied from
// packages/core/src/approval/approval-gate.test.ts (the canonical port doubles).
// Structural literals so no deep-path import is needed.
// ---------------------------------------------------------------------------

const testClock = {
  now: () => Date.now(),
  nowDate: () => new Date(),
};

function wrapTimerHandle(t: NodeJS.Timeout) {
  let cancelled = false;
  let unrefCalled = false;
  return {
    get cancelled() {
      return cancelled;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(t);
    },
    unref() {
      if (cancelled || unrefCalled) return;
      unrefCalled = true;
      t.unref();
    },
  };
}

const testTimers = {
  setTimeout: (cb: () => void, ms: number) => wrapTimerHandle(setTimeout(cb, ms)),
  setInterval: (cb: () => void, ms: number) => wrapTimerHandle(setInterval(cb, ms)),
};

// ---------------------------------------------------------------------------
// SEC-05 Stage-B — gateway token scope disjointness (mcp-client co-issuance rejected)
// ---------------------------------------------------------------------------

describe("SEC-05 Stage-B — gateway token scope disjointness (mcp-client co-issuance rejected)", () => {
  const SECRET = "x".repeat(32); // GatewayTokenSchema requires a >=32-char string secret

  it("REJECTS mcp-client + admin co-issuance with [scope_disjointness]", () => {
    expect(() =>
      GatewayTokenSchema.parse({ id: "t", secret: SECRET, scopes: ["mcp-client", "admin"] }),
    ).toThrow(/scope_disjointness/);
  });

  it("REJECTS mcp-client + rpc co-issuance", () => {
    expect(() =>
      GatewayTokenSchema.parse({ id: "t", secret: SECRET, scopes: ["mcp-client", "rpc"] }),
    ).toThrow(/scope_disjointness/);
  });

  it("REJECTS mcp-client + wildcard '*' co-issuance", () => {
    expect(() =>
      GatewayTokenSchema.parse({ id: "t", secret: SECRET, scopes: ["mcp-client", "*"] }),
    ).toThrow(/scope_disjointness/);
  });

  it("ACCEPTS a sole-scope mcp-client token", () => {
    expect(() =>
      GatewayTokenSchema.parse({ id: "t", secret: SECRET, scopes: ["mcp-client"] }),
    ).not.toThrow();
  });

  it("ACCEPTS operator postures ['admin'] and ['rpc','ws']", () => {
    expect(() => GatewayTokenSchema.parse({ id: "t", secret: SECRET, scopes: ["admin"] })).not.toThrow();
    expect(() =>
      GatewayTokenSchema.parse({ id: "t", secret: SECRET, scopes: ["rpc", "ws"] }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SEC-05 Stage-B — approval gate pause → resolve
// ---------------------------------------------------------------------------

describe("SEC-05 Stage-B — approval gate pause → resolve", () => {
  let gate: ApprovalGate | undefined;

  afterEach(() => {
    gate?.dispose();
    gate = undefined;
  });

  it("pauses on requestApproval (approval:requested) and resolves on resolveApproval (approval:resolved)", async () => {
    const eventBus = new TypedEventBus();
    const events: string[] = [];
    eventBus.on("approval:requested", () => events.push("requested"));
    eventBus.on("approval:resolved", () => events.push("resolved"));

    gate = createApprovalGate({
      eventBus,
      getTimeoutMs: () => 60_000,
      clock: testClock,
      timers: testTimers,
      fingerprintSecret: "test-approval-fingerprint-secret",
    });

    // Approval requests now carry the canonical conversation authority
    // (tenant + agent + opaque conversationRef + resolving principal) rather
    // than a formatted session-key string. The ref is a branded cv_ digest.
    const conversationRef = ConversationRefSchema.parse(
      `cv_${createHash("sha256").update("default:user-1:channel-1").digest("base64url")}`,
    );
    const pending = gate.requestApproval({
      toolName: "agents.delete",
      action: "agents.delete",
      params: {},
      fingerprintParams: {},
      tenantId: "default",
      agentId: "agent-1",
      conversationRef,
      resolvingPrincipalId: "principal:user-1",
      trustLevel: "user",
      callbackOwner: {
        tenantId: "default",
        userId: "user-1",
        channelType: "echo",
        channelKey: "channel-1",
      },
    });

    // Paused: one pending request + approval:requested emitted.
    expect(gate.pending().length).toBe(1);
    expect(events).toContain("requested");

    const requestId = gate.pending()[0]!.requestId;
    gate.resolveApproval(requestId, true, "operator");

    const resolution = await pending;
    expect(resolution.approved).toBe(true);
    expect(gate.pending().length).toBe(0);
    expect(events).toContain("resolved");
  });
});

// ---------------------------------------------------------------------------
// SEC-05 Stage-C — live gateway admin-RPC-denial + rate-limit-429 (COMIS_LIVE)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("SEC-05 Stage-C — live gateway scope/rate-limit (COMIS_LIVE + live hono-server)", () => {
  it.skip(
    "admin-only RPC returns 403 for a non-admin token + the Nth request in the window returns 429 over the live " +
      "hono-server.ts (SKIPPED(no-network): needs the live HTTP gateway bound + tokens; the scope-disjointness " +
      "refine + the approval state machine are proven deterministically in Stage-B above)",
    () => {
      // Stage-C (operator): boot the daemon, issue a non-admin token, call an admin-only RPC → 403;
      //   loop requests past the rate-limit window → 429.
    },
  );
});
