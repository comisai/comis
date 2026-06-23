// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first contract for the `capabilities.introspect` handler (Phase 215-04,
 * INTRO-01/INTRO-02) — the self-scoped, read-only, NO-cap `comis whoami` read.
 *
 * Tests drive the handler in isolation against a mock BoundedAutonomy + an
 * agents map:
 *   - Test 1: a call with `_agentId:"agent-a"` returns `{ agentId:"agent-a",
 *     caps:[...resolveAutonomy(agent-a.autonomy).capabilities] }` — self-scoped to
 *     the CALLER's `_agentId`.
 *   - Test 2: when a live `rootRunId` resolves (a caller session key is present
 *     and `resolveRootRunId` returns one), the response includes `budget` (from
 *     `boundedAutonomy.snapshot`) + `outwardQuota`; when no `rootRunId` is live
 *     (in-process, pre-spawn) both are ABSENT (optional, honest — never a
 *     fabricated zero snapshot).
 *   - Test 3: the handler reads the CALLER's `_agentId` ONLY — an arbitrary
 *     `agentId` REQUEST param is IGNORED (self-scope, the session-read precedent
 *     — T-215-11). `stripInternalFields` runs before the parse (no `_trustLevel`
 *     smuggling — T-215-12).
 *   - Test 4: NO `requireCapability` is invoked — the handler is reachable with
 *     no cap (INTRO-02). The mock BoundedAutonomy carries no capability gate; the
 *     handler resolving caps from the agents map (not a gate) is the proof.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveAutonomy } from "@comis/core";
import type { PerAgentConfig } from "@comis/core";
import {
  createCapabilitiesHandlers,
  type CapabilitiesHandlerDeps,
} from "./capabilities-handlers.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** A self-scope-distinguishing agents map: agent-a (an explicit cap list) +
 *  default (a different list). The handler must report agent-a's caps for an
 *  agent-a caller — never default's. */
const AGENTS: Record<string, PerAgentConfig> = {
  "agent-a": {
    autonomy: { profile: "standard", capabilities: ["orch:read", "orch:web"] },
  } as unknown as PerAgentConfig,
  default: {
    autonomy: { profile: "assistant", capabilities: [] },
  } as unknown as PerAgentConfig,
};

/** A composite snapshot the mock BoundedAutonomy returns for a live root. */
const SNAPSHOT = {
  budget: { tokensRemaining: 4000, wallClockMsRemaining: 120000, usdRemaining: 1.5 },
  outwardQuota: { perHourRemaining: 7 },
  leaseIds: ["L1"],
};

function createMockDeps(
  overrides: { resolveRootRunId?: (sk: never) => string } = {},
): CapabilitiesHandlerDeps {
  return {
    boundedAutonomy: {
      snapshot: vi.fn().mockReturnValue(SNAPSHOT),
    },
    agents: AGENTS,
    defaultAgentId: "default",
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() },
    ...overrides,
  } as unknown as CapabilitiesHandlerDeps;
}

describe("createCapabilitiesHandlers — capabilities.introspect (INTRO-01/02)", () => {
  let deps: CapabilitiesHandlerDeps;
  let handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown>>;

  beforeEach(() => {
    deps = createMockDeps();
    handlers = createCapabilitiesHandlers(deps);
  });

  // -------------------------------------------------------------------------
  // Test 1: self-scoped caps for the CALLER's _agentId
  // -------------------------------------------------------------------------
  it("returns the CALLER's resolved caps self-scoped to the injected _agentId", async () => {
    const result = (await handlers["capabilities.introspect"]!({ _agentId: "agent-a" })) as {
      agentId: string;
      caps: string[];
    };

    const expectedCaps = [...resolveAutonomy(AGENTS["agent-a"]!.autonomy).capabilities];
    expect(result.agentId).toBe("agent-a");
    expect(result.caps).toEqual(expectedCaps);
    // agent-a holds orch:web; the default (assistant) caller would NOT.
    expect(result.caps).toContain("orch:web");
  });

  // -------------------------------------------------------------------------
  // Test 2: budget/quota present ONLY when a live rootRunId resolves; absent
  // (honest) when no root is live (in-process pre-spawn).
  // -------------------------------------------------------------------------
  it("includes budget + outwardQuota from the snapshot when a live rootRunId resolves", async () => {
    const resolveRootRunId = vi.fn().mockReturnValue("root-session-X");
    deps = createMockDeps({ resolveRootRunId: resolveRootRunId as never });
    handlers = createCapabilitiesHandlers(deps);

    const result = (await handlers["capabilities.introspect"]!({
      _agentId: "agent-a",
      // A valid formatted session key (tenant:user:channel) so
      // parseFormattedSessionKey resolves it → resolveRootRunId is consulted.
      _callerSessionKey: "default:user:peer123",
    })) as { budget?: unknown; outwardQuota?: unknown };

    expect(resolveRootRunId).toHaveBeenCalled();
    expect(deps.boundedAutonomy.snapshot).toHaveBeenCalledWith("root-session-X", "agent-a", "");
    expect(result.budget).toEqual(SNAPSHOT.budget);
    expect(result.outwardQuota).toEqual(SNAPSHOT.outwardQuota);
  });

  it("omits budget + outwardQuota when no rootRunId is live (in-process pre-spawn — honest)", async () => {
    // No resolveRootRunId wired AND no caller session key → no live root.
    const result = (await handlers["capabilities.introspect"]!({ _agentId: "agent-a" })) as {
      budget?: unknown;
      outwardQuota?: unknown;
    };

    expect(result.budget).toBeUndefined();
    expect(result.outwardQuota).toBeUndefined();
    // Never fabricated: the snapshot accessor is not even consulted with no root.
    expect(deps.boundedAutonomy.snapshot).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 3: self-scope — an arbitrary agentId request param is IGNORED
  // (T-215-11); stripInternalFields runs before the parse (T-215-12).
  // -------------------------------------------------------------------------
  it("ignores an arbitrary agentId request param and self-scopes to _agentId only (T-215-11)", async () => {
    const result = (await handlers["capabilities.introspect"]!({
      _agentId: "agent-a",
      // A caller trying to introspect another agent — MUST be ignored.
      agentId: "default",
      // A forged trust level — stripInternalFields drops it before the parse.
      _trustLevel: "admin",
    })) as { agentId: string; caps: string[] };

    // Self-scoped to agent-a (the unforgeable _agentId), NOT the smuggled "default".
    expect(result.agentId).toBe("agent-a");
    expect(result.caps).toEqual([...resolveAutonomy(AGENTS["agent-a"]!.autonomy).capabilities]);
  });

  it("falls back to defaultAgentId when no _agentId is present (operator/CLI origin)", async () => {
    const result = (await handlers["capabilities.introspect"]!({})) as {
      agentId: string;
      caps: string[];
    };

    expect(result.agentId).toBe("default");
    expect(result.caps).toEqual([...resolveAutonomy(AGENTS["default"]!.autonomy).capabilities]);
  });

  // -------------------------------------------------------------------------
  // Test 4: NO requireCapability (INTRO-02) — reachable with no cap. The
  // handler resolves caps from the agents map; it never calls a cap gate, so an
  // assistant-profile agent (zero caps) still gets an honest empty list, not a
  // CapabilityDeniedError.
  // -------------------------------------------------------------------------
  it("is reachable with NO capability (INTRO-02) — a zero-cap caller gets an empty caps list, not a denial", async () => {
    const result = (await handlers["capabilities.introspect"]!({ _agentId: "default" })) as {
      agentId: string;
      caps: string[];
    };

    // The assistant default profile resolves to zero orch:* caps — and the call
    // SUCCEEDS (no requireCapability gate fired).
    expect(result.agentId).toBe("default");
    expect(result.caps).toEqual([]);
  });
});
