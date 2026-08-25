// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for approval boot wiring (setup-approvals.ts).
 *
 * Two halves, both boot-critical. `createConfiguredApprovalGate` is the only
 * place operator `approvals` config reaches the gate — if it captured the config
 * object or dropped the policy, rules would silently stop deciding and every
 * gated action would fall back to prompting. `restoreApprovalState` consumes the
 * files the previous process left behind; a throw here fails the boot, so every
 * branch must degrade to a warning and still clear the file.
 *
 * Uses real config parsed through AppConfigSchema and a real temp directory —
 * the on-disk filenames are the contract between shutdown and boot.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppConfigSchema, ConversationRefSchema, TypedEventBus } from "@comis/core";
import type { AppConfig, ClockPort, TimerPort, TimerHandle } from "@comis/core";
import { createConfiguredApprovalGate, restoreApprovalState } from "./setup-approvals.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

const FINGERPRINT_SECRET = "setup-approvals-test-secret-32-bytes";

const clock: ClockPort = { now: () => Date.now(), nowDate: () => new Date() };

function wrap(t: NodeJS.Timeout): TimerHandle {
  let cancelled = false;
  return {
    get cancelled() { return cancelled; },
    cancel() { cancelled = true; clearTimeout(t); },
    unref() { t.unref(); },
  };
}
const timers: TimerPort = {
  setTimeout: (cb, ms) => wrap(setTimeout(cb, ms)),
  setInterval: (cb, ms) => wrap(setInterval(cb, ms)),
};

function approvals(overrides: Record<string, unknown> = {}): AppConfig["approvals"] {
  return AppConfigSchema.parse({ approvals: { enabled: true, ...overrides } }).approvals;
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "comis-approvals-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("createConfiguredApprovalGate", () => {
  it("threads the operator policy through, so a deny rule decides without prompting", async () => {
    const eventBus = new TypedEventBus();
    const prompted = vi.fn();
    eventBus.on("approval:requested", prompted);
    const gate = createConfiguredApprovalGate({
      eventBus,
      getApprovals: () => approvals({ rules: [{ actionPattern: "memory.*", mode: "deny" }] }),
      clock,
      timers,
      fingerprintSecret: FINGERPRINT_SECRET,
      daemonLogger: createMockLogger(),
    });

    await expect(gate.requestApproval(request("memory.delete"))).resolves.toMatchObject({
      approved: false,
      approvedBy: "system:policy-rule",
    });
    expect(prompted).not.toHaveBeenCalled();
    gate.dispose();
  });

  it("re-reads config on every request, so a reloaded policy takes effect without a restart", async () => {
    let current = approvals();
    const gate = createConfiguredApprovalGate({
      eventBus: new TypedEventBus(),
      getApprovals: () => current,
      clock,
      timers,
      fingerprintSecret: FINGERPRINT_SECRET,
      daemonLogger: createMockLogger(),
    });

    // No rule yet: the request stays pending for a human.
    gate.requestApproval(request("system.exec"));
    expect(gate.pending()).toHaveLength(1);

    current = approvals({ rules: [{ actionPattern: "system.exec", mode: "deny" }] });

    await expect(gate.requestApproval(request("system.exec", "other:user:web"))).resolves.toMatchObject({
      approvedBy: "system:policy-rule",
    });
    gate.dispose();
  });

  it("uses the configured timeout for a pending request", () => {
    const gate = createConfiguredApprovalGate({
      eventBus: new TypedEventBus(),
      getApprovals: () => approvals({ defaultTimeoutMs: 4242 }),
      clock,
      timers,
      fingerprintSecret: FINGERPRINT_SECRET,
      daemonLogger: createMockLogger(),
    });

    gate.requestApproval(request("system.exec"));

    expect(gate.pending()[0]!.timeoutMs).toBe(4242);
    gate.dispose();
  });
});

describe("restoreApprovalState", () => {
  function gate() {
    return createConfiguredApprovalGate({
      eventBus: new TypedEventBus(),
      getApprovals: () => approvals(),
      clock,
      timers,
      fingerprintSecret: FINGERPRINT_SECRET,
      daemonLogger: createMockLogger(),
    });
  }

  it("is a no-op when the previous process left nothing behind", () => {
    const logger = createMockLogger();
    const g = gate();

    expect(() => restoreApprovalState({
      approvalGate: g, dataDir: dir, containerDataDir: undefined, daemonLogger: logger,
    })).not.toThrow();

    expect(g.pending()).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
    g.dispose();
  });

  it("consumes both restart files so a second boot cannot replay them", () => {
    writeFileSync(join(dir, "restart-approvals.json"), "[]");
    writeFileSync(join(dir, "restart-approval-cache.json"), "[]");
    const g = gate();

    restoreApprovalState({
      approvalGate: g, dataDir: dir, containerDataDir: undefined, daemonLogger: createMockLogger(),
    });

    expect(existsSync(join(dir, "restart-approvals.json"))).toBe(false);
    expect(existsSync(join(dir, "restart-approval-cache.json"))).toBe(false);
    g.dispose();
  });

  it("warns and clears the file when a restart record is corrupt, rather than failing the boot", () => {
    writeFileSync(join(dir, "restart-approvals.json"), "{ not json");
    const logger = createMockLogger();
    const g = gate();

    expect(() => restoreApprovalState({
      approvalGate: g, dataDir: dir, containerDataDir: undefined, daemonLogger: logger,
    })).not.toThrow();

    expect(logger.warn).toHaveBeenCalled();
    expect(existsSync(join(dir, "restart-approvals.json"))).toBe(false);
    g.dispose();
  });

  it("prefers the container data directory when one is configured", () => {
    writeFileSync(join(dir, "restart-approvals.json"), "{ not json");
    const logger = createMockLogger();
    const g = gate();

    // dataDir points somewhere with no restart files; containerDataDir has the corrupt one.
    restoreApprovalState({
      approvalGate: g, dataDir: tmpdir(), containerDataDir: dir, daemonLogger: logger,
    });

    expect(logger.warn).toHaveBeenCalled();
    expect(existsSync(join(dir, "restart-approvals.json"))).toBe(false);
    g.dispose();
  });
});

/** A minimal, valid approval request for one action. */
function request(action: string, sessionKey = "default:user1:web") {
  const [tenantId = "default", userId = "user1", channelKey = "web"] = sessionKey.split(":");
  return {
    toolName: "t",
    action,
    params: {},
    fingerprintParams: { action },
    sessionKey,
    traceId: "40000000-0000-4000-8000-000000000004",
    tenantId,
    agentId: "agent-1",
    conversationRef: ConversationRefSchema.parse(
      `cv_${createHash("sha256").update(sessionKey).digest("base64url")}`,
    ),
    resolvingPrincipalId: `principal:${sessionKey}`,
    trustLevel: "user" as const,
    callbackOwner: { tenantId, userId, channelType: channelKey, channelKey },
  };
}
