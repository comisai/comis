// SPDX-License-Identifier: Apache-2.0
/**
 * ORIGIN-01 deny-by-origin helper unit tests.
 *
 * Trust-tiered (30uc-20260624 decision): an ADMIN-trust agent origin is ALLOWED
 * through (it inherits the admin user's control-plane privileges — the operator's
 * explicit senderTrustMap grant); a NON-admin agent origin (guest/user/unset) is
 * DENIED (the confused-deputy floor) with exactly one content-free audited denial.
 * An operator origin (no `_agentId`) always passes.
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
import { createMockEventBus } from "../../../../../test/support/mock-event-bus.js";
import { assertNotAgentOrigin } from "./assert-not-agent-origin.js";

/**
 * Build a minimal structural deps object carrying the two fields the guard
 * reads: `container.eventBus.emit` (for the audited denial) and
 * `container.config.tenantId` (for the audit tenant scope). Captures every
 * `audit:event` so the content-free assertion can inspect it.
 */
function makeDeps(): {
  deps: Parameters<typeof assertNotAgentOrigin>[1];
  capturedAuditEvents: Record<string, unknown>[];
} {
  const capturedAuditEvents: Record<string, unknown>[] = [];
  const eventBus = createMockEventBus({
    emit: vi.fn((kind: string, evt: unknown) => {
      if (kind === "audit:event") capturedAuditEvents.push(evt as Record<string, unknown>);
      return false;
    }),
  });
  const deps = {
    logger: createMockLogger(),
    container: { eventBus, config: { tenantId: "default" } },
  } as unknown as Parameters<typeof assertNotAgentOrigin>[1];
  return { deps, capturedAuditEvents };
}

describe("assertNotAgentOrigin (ORIGIN-01 deny-by-origin)", () => {
  it("ORIGIN-01-S1: ALLOWS an _agentId-carrying call when _trustLevel is admin (the admin user's agent inherits admin)", () => {
    const { deps, capturedAuditEvents } = makeDeps();
    // The agent acts for an admin-trust user (the operator's senderTrustMap grant)
    // → it inherits admin control-plane access. The admin handler re-checks the
    // trust (defense-in-depth). No deny, no audited denial.
    expect(() =>
      assertNotAgentOrigin({ _agentId: "agent-a", _trustLevel: "admin" }, deps, "agents.create"),
    ).not.toThrow();
    expect(capturedAuditEvents).toHaveLength(0);
  });

  it("ORIGIN-01-S1b: THROWS on an _agentId-carrying call when _trustLevel is NON-admin (user/guest/unset — the confused-deputy floor)", () => {
    for (const trust of ["user", "guest", undefined] as const) {
      const { deps } = makeDeps();
      expect(() =>
        assertNotAgentOrigin(
          { _agentId: "agent-a", ...(trust !== undefined ? { _trustLevel: trust } : {}) },
          deps,
          "secrets.get",
        ),
        `trust=${String(trust)} must be denied`,
      ).toThrow();
    }
  });

  it("ORIGIN-01-S2: a NON-admin agent denial emits exactly one content-free audit:event (capability_denied/denied/actionType=method)", () => {
    const { deps, capturedAuditEvents } = makeDeps();
    try {
      assertNotAgentOrigin({ _agentId: "forged-agent", _trustLevel: "user" }, deps, "secrets.get");
    } catch {
      /* expected throw — the audit emit precedes it */
    }
    expect(capturedAuditEvents).toHaveLength(1);
    const evt = capturedAuditEvents[0]!;
    expect(evt.kind).toBe("capability_denied");
    expect(evt.outcome).toBe("denied");
    expect(evt.actionType).toBe("secrets.get");
    // Content-free: the metadata free-map carries ONLY the method + a fixed
    // reason string — never any param value (no _agentId VALUE, no secret).
    const metadata = evt.metadata as Record<string, unknown>;
    expect(metadata.method).toBe("secrets.get");
    expect(metadata.reason).toBe("non_admin_agent_origin");
    const metaJson = JSON.stringify(metadata);
    // The forged _agentId value itself must NOT leak into metadata.
    expect(metaJson).not.toContain("forged-agent");
  });

  it("ORIGIN-01-S3: a legitimate operator call (no _agentId) does NOT throw and emits NO audit event", () => {
    const { deps, capturedAuditEvents } = makeDeps();
    expect(() =>
      assertNotAgentOrigin({ _trustLevel: "admin", name: "DB_URL" }, deps, "secrets.get"),
    ).not.toThrow();
    expect(capturedAuditEvents).toHaveLength(0);
  });

  it("ORIGIN-01-S4: the thrown error (non-admin agent) names the method but does NOT leak param values", () => {
    const { deps } = makeDeps();
    let caught: unknown;
    try {
      assertNotAgentOrigin(
        { _agentId: "agent-7", _trustLevel: "user", apiKey: "sk-PLANTED-SECRET" },
        deps,
        "secrets.get",
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain("secrets.get");
    // Neither the forged _agentId nor any other param value may appear in the
    // thrown message (it surfaces to the caller as a JSON-RPC error).
    expect(msg).not.toContain("agent-7");
    expect(msg).not.toContain("sk-PLANTED-SECRET");
  });
});
