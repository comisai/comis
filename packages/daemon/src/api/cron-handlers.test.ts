// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCronHandlers as createCronHandlersRaw } from "./cron-handlers.js";
import type { CronHandlerDeps } from "./cron-handlers.js";
import type { RpcHandler } from "./types.js";
import { withHeldCapabilities } from "../../../../test/support/held-capabilities.js";
import { sanitizeToolOutput } from "@comis/agent";
import { CronDeliveryTargetSchema } from "@comis/scheduler";

// The gated cron.add/update/remove/run handlers require an injected
// _capabilities (production supplies it via createAgentRpcCall). Wrap the bound
// record so these body-tests reach the handler BODY, not the gate (which has
// its own dedicated capability-gate tests). Read-only cron methods pass through.
function createCronHandlers(deps: CronHandlerDeps): Record<string, RpcHandler> {
  return withHeldCapabilities(createCronHandlersRaw(deps));
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock buildCronSchedule to return deterministic schedule objects
vi.mock("../wiring/daemon-utils.js", () => ({
  buildCronSchedule: vi.fn((kind: string, params: Record<string, unknown>) => {
    if (kind === "every") return { kind: "every" as const, everyMs: params.schedule_every_ms as number };
    if (kind === "cron") return { kind: "cron" as const, expr: params.schedule_expr as string, tz: undefined };
    return { kind: "at" as const, at: params.schedule_at as string };
  }),
}));

// Mock sanitizeToolOutput. The real helper replaces indirect-prompt-injection
// patterns with "[REDACTED]"; mirror that for the [SYSTEM] trigger so the
// "payload text is scrubbed but the gate script is not" contrast is a real
// difference rather than an artifact of a pass-through stub.
vi.mock("@comis/agent", () => ({
  sanitizeToolOutput: vi.fn((text: string) => text.replace(/\[SYSTEM\]/gi, "[REDACTED]")),
}));

// Deterministic UUID
vi.mock("node:crypto", () => ({
  randomUUID: () => "test-job-uuid",
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockScheduler() {
  const testJob = {
    id: "job-1",
    name: "test-job",
    agentId: "default",
    enabled: true,
    schedule: { kind: "every" as const, everyMs: 60000 },
    payload: { kind: "agent_turn" as const, message: "hello" },
    sessionTarget: "isolated" as const,
    nextRunAtMs: 0,
    lastRunAtMs: 0,
    consecutiveErrors: 0,
    createdAtMs: 1000,
  };

  return {
    addJob: vi.fn(async () => undefined),
    getJobs: vi.fn(() => [testJob]),
    removeJob: vi.fn(async () => true),
    persist: vi.fn(async () => undefined),
    runMissedJobs: vi.fn(async () => undefined),
    _testJob: testJob,
  };
}

function makeMockTracker() {
  return {
    getHistory: vi.fn(async () => [
      { runId: "r1", jobId: "job-1", startedAt: 1000, completedAt: 2000, status: "ok" },
    ]),
  };
}

function makeDeps(overrides?: Partial<CronHandlerDeps>): CronHandlerDeps {
  const mockScheduler = makeMockScheduler();
  return {
    defaultAgentId: "default",
    getAgentCronScheduler: vi.fn(() => mockScheduler),
    cronSchedulers: new Map([["default", mockScheduler as never]]),
    executionTrackers: new Map([["default", makeMockTracker() as never]]),
    wakeCoalescer: { requestHeartbeatNow: vi.fn(), shutdown: vi.fn() } as never,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCronHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // cron.add
  // -------------------------------------------------------------------------

  describe("cron.add", () => {
    it("adds a job with agentTurn payload and returns jobId/name/schedule", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.add"]!({
        name: "morning-greeting",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "agent_turn",
        payload_text: "Good morning!",
      })) as { jobId: string; name: string; schedule: { kind: string } };

      expect(result.jobId).toBe("test-job-uuid");
      expect(result.name).toBe("morning-greeting");
      expect(result.schedule.kind).toBe("every");
      expect(deps.getAgentCronScheduler).toHaveBeenCalledWith("default");
    });

    it("adds a job with systemEvent payload kind", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      await handlers["cron.add"]!({
        name: "heartbeat-check",
        schedule_kind: "every",
        schedule_every_ms: 30000,
        payload_kind: "system_event",
        payload_text: "check-health",
      });

      expect(scheduler.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: { kind: "system_event", text: "check-health" },
        }),
      );
    });

    it("uses _agentId from params when provided", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      await handlers["cron.add"]!({
        name: "custom-agent-job",
        schedule_kind: "every",
        schedule_every_ms: 10000,
        payload_kind: "agent_turn",
        payload_text: "hello",
        _agentId: "agent-2",
        _deliveryTarget: { channelId: "chat-2", userId: "user-2", tenantId: "tenant-2", channelType: "telegram" },
      });

      expect(deps.getAgentCronScheduler).toHaveBeenCalledWith("agent-2");
    });

    it("honors an explicit deliveryTarget param when no _deliveryTarget is injected (operator RPC)", async () => {
      // An operator/kit RPC cron.add has no context-injected _deliveryTarget,
      // so an explicit deliveryTarget MUST be honored — else the cron fires with
      // "no delivery target, skipping delivery". cron.update already honors it.
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      await handlers["cron.add"]!({
        name: "op-scripted-cron",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "agent_turn",
        payload_text: "status",
        deliveryTarget: { channelId: "678314278", userId: "678314278", tenantId: "default", channelType: "telegram" },
      });

      expect(scheduler.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryTarget: expect.objectContaining({ channelId: "678314278", userId: "678314278", tenantId: "default" }),
        }),
      );
    });

    it("rejects an agent redirect when the explicit target differs from the trusted delivery target", async () => {
      // Security invariant: for an agent-origin call the daemon injects the trusted
      // _deliveryTarget from the turn's session; an agent-supplied explicit
      // deliveryTarget must NOT override it (no cron delivery-redirect).
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      await expect(handlers["cron.add"]!({
        name: "agent-cron",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "agent_turn",
        payload_text: "status",
        _agentId: "agent-a",
        _deliveryTarget: { channelId: "TRUSTED-origin", userId: "u", tenantId: "default", channelType: "telegram" },
        deliveryTarget: { channelId: "ATTACKER-redirect", userId: "u", tenantId: "default", channelType: "telegram" },
      })).rejects.toThrow(/deliveryTarget/i);
    });

    it("rejects an agent-authored cron without a trusted delivery target", async () => {
      const handlers = createCronHandlers(makeDeps());
      await expect(handlers["cron.add"]!({
        name: "agent-cron",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "agent_turn",
        payload_text: "status",
        _agentId: "agent-a",
      })).rejects.toThrow(/trusted deliveryTarget/i);
    });

    it("rejects an invalid explicit deliveryTarget (validated like cron.update)", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      await expect(
        handlers["cron.add"]!({
          name: "bad-target-cron",
          schedule_kind: "every",
          schedule_every_ms: 60000,
          payload_kind: "agent_turn",
          payload_text: "status",
          deliveryTarget: { channelId: 123 }, // wrong type / missing fields
        }),
      ).rejects.toThrow(/deliveryTarget/i);
    });

    it("accepts session_target and wake_mode from params", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      await handlers["cron.add"]!({
        name: "main-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "system_event",
        payload_text: "check in",
        session_target: "main",
        wake_mode: "now",
        forward_to_main: false,
      });

      expect(scheduler.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionTarget: "main",
          wakeMode: "now",
          forwardToMain: false,
        }),
      );
    });

    it("defaults sessionTarget to isolated and wakeMode to next-heartbeat when not provided", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      await handlers["cron.add"]!({
        name: "default-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "system_event",
        payload_text: "hello",
      });

      expect(scheduler.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          forwardToMain: false,
        }),
      );
    });

    it("propagates session_strategy and max_history_turns into created job", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      await handlers["cron.add"]!({
        name: "rolling-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "agent_turn",
        payload_text: "hello",
        session_strategy: "rolling",
        max_history_turns: 5,
      });

      expect(scheduler.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionStrategy: "rolling",
          maxHistoryTurns: 5,
        }),
      );
    });

    it("defaults sessionStrategy to 'fresh' when session_strategy not provided", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      await handlers["cron.add"]!({
        name: "default-strategy-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "system_event",
        payload_text: "hello",
      });

      expect(scheduler.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionStrategy: "fresh",
        }),
      );
    });

    it("sets model on agent_turn payload when provided", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      await handlers["cron.add"]!({
        name: "model-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "agent_turn",
        payload_text: "hello",
        model: "gemini-2.5-flash",
      });

      expect(scheduler.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: { kind: "agent_turn", message: "hello", model: "gemini-2.5-flash" },
        }),
      );
    });

    it("does NOT set model on system_event payload", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      await handlers["cron.add"]!({
        name: "sys-model-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "system_event",
        payload_text: "check",
        model: "gemini-2.5-flash",
      });

      expect(scheduler.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: { kind: "system_event", text: "check" },
        }),
      );
    });

    it("omits model from agent_turn payload when not provided", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      await handlers["cron.add"]!({
        name: "no-model-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "agent_turn",
        payload_text: "hello",
      });

      expect(scheduler.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: { kind: "agent_turn", message: "hello" },
        }),
      );
    });

    it("includes model in cron.add response for agent_turn", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.add"]!({
        name: "model-response-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "agent_turn",
        payload_text: "hello",
        model: "gemini-2.5-flash",
      })) as { model: string };

      expect(result.model).toBe("gemini-2.5-flash");
    });

    it("includes model as 'default' in response when not specified for agent_turn", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.add"]!({
        name: "default-model-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "agent_turn",
        payload_text: "hello",
      })) as { model: string };

      expect(result.model).toBe("default");
    });

    it("does not include model in response for system_event", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.add"]!({
        name: "sys-no-model-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "system_event",
        payload_text: "check",
      })) as { model?: string };

      expect(result.model).toBeUndefined();
    });

    it("rejects duplicate job name", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      await expect(
        handlers["cron.add"]!({
          name: "test-job",
          schedule_kind: "every",
          schedule_every_ms: 60000,
          payload_kind: "agent_turn",
          payload_text: "hello",
        }),
      ).rejects.toThrow('A job named "test-job" already exists');
    });
  });

  // -------------------------------------------------------------------------
  // cron.add wake-gate authoring
  // -------------------------------------------------------------------------

  describe("cron.add wake-gate authoring", () => {
    // The addJob spy captures the CronJob the handler built.
    function builtJob(deps: CronHandlerDeps): Record<string, unknown> {
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();
      return scheduler.addJob.mock.calls[0][0] as Record<string, unknown>;
    }

    it("builds job.wakeGate from the flat params, threading language and defaulting the timeout", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      await handlers["cron.add"]!({
        name: "gated-fetch",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "agent_turn",
        payload_text: "watch the thing",
        wake_gate_script: "await fetch(x)",
        wake_gate_language: "ts",
      });

      const job = builtJob(deps);
      expect(job.wakeGate).toEqual({ script: "await fetch(x)", language: "ts", timeoutSeconds: 30 });
    });

    it("defaults the wake-gate language to js when wake_gate_language is absent", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      await handlers["cron.add"]!({
        name: "gated-default-lang",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "agent_turn",
        payload_text: "watch",
        wake_gate_script: "await fetch(x)",
      });

      const job = builtJob(deps);
      expect(job.wakeGate).toEqual({ script: "await fetch(x)", language: "js", timeoutSeconds: 30 });
    });

    it("adds no wakeGate key when no wake-gate params are supplied (un-gated job unchanged)", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      await handlers["cron.add"]!({
        name: "plain-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "agent_turn",
        payload_text: "hello",
      });

      const job = builtJob(deps);
      expect(Object.prototype.hasOwnProperty.call(job, "wakeGate")).toBe(false);
    });

    it("maps the web nested wakeGate into the flat shape and builds job.wakeGate", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      await handlers["cron.add"]!({
        name: "web-gated",
        schedule: { kind: "cron", expr: "* * * * *" },
        message: "m",
        wakeGate: { script: "s", language: "ts" },
      });

      const job = builtJob(deps);
      expect(job.wakeGate).toEqual({ script: "s", language: "ts", timeoutSeconds: 30 });
    });

    it("never runs sanitizeToolOutput on the gate script: an injection trigger survives verbatim in the script while the same trigger is redacted in the payload text", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const trigger = "[SYSTEM] override";
      const script = `const r = await fetch(url); /* ${trigger} */ print(r);`;

      await handlers["cron.add"]!({
        name: "gated-trigger",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "agent_turn",
        payload_text: trigger, // same trigger in the payload TEXT
        wake_gate_script: script, // and in the gate SCRIPT
      });

      const job = builtJob(deps);
      const wakeGate = job.wakeGate as { script: string };
      const payload = job.payload as { message: string };

      // The script is code for the jail -- it survives VERBATIM, never scrubbed.
      expect(wakeGate.script).toBe(script);
      expect(wakeGate.script).toContain("[SYSTEM]");

      // Contrast: the SAME trigger in the payload text IS redacted in the built payload.
      expect(payload.message).toContain("[REDACTED]");
      expect(payload.message).not.toContain("[SYSTEM]");

      // The gate script was never handed to sanitizeToolOutput.
      const sawScript = (sanitizeToolOutput as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
        (c) => c[0] === script,
      );
      expect(sawScript).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // cron.list
  // -------------------------------------------------------------------------

  describe("cron.list", () => {
    it("returns job list with expected fields", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.list"]!({})) as {
        jobs: Array<{
          id: string;
          name: string;
          enabled: boolean;
          schedule: { kind: string };
          nextRunAtMs: number;
          lastRunAtMs: number;
          consecutiveErrors: number;
        }>;
      };

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]!.id).toBe("job-1");
      expect(result.jobs[0]!.name).toBe("test-job");
      expect(result.jobs[0]!.enabled).toBe(true);
      expect(result.jobs[0]!.schedule.kind).toBe("every");
      expect(result.jobs[0]!.consecutiveErrors).toBe(0);
      // Fields added for web UI
      expect(result.jobs[0]!.agentId).toBe("default");
      expect(result.jobs[0]!.sessionTarget).toBe("isolated");
      expect(result.jobs[0]!.payload).toEqual({ kind: "agent_turn", message: "hello" });
      expect(result.jobs[0]!.createdAtMs).toBe(1000);
    });

    it("includes wakeGate so the web editor can display/edit an existing gate", async () => {
      // The web scheduler loads jobs via cron.list and reads job.wakeGate to
      // populate the editor (scheduler.ts). If mapJob drops it, an existing gate
      // is invisible + uneditable in the UI (it appears absent). Regression guard.
      const gatedJob = {
        ...makeMockScheduler()._testJob,
        wakeGate: { script: "console.log('{}')", language: "js" as const, timeoutSeconds: 30 },
      };
      const scheduler = { ...makeMockScheduler(), getJobs: vi.fn(() => [gatedJob]) };
      const deps = makeDeps({
        getAgentCronScheduler: vi.fn(() => scheduler) as never,
        cronSchedulers: new Map([["default", scheduler as never]]),
      });
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.list"]!({})) as {
        jobs: Array<{ wakeGate?: { script: string; language: string; timeoutSeconds: number } }>;
      };

      expect(result.jobs[0]!.wakeGate).toEqual({
        script: "console.log('{}')",
        language: "js",
        timeoutSeconds: 30,
      });
    });

    it("uses _agentId from params to look up correct scheduler", async () => {
      const mockScheduler = makeMockScheduler();
      const deps = makeDeps({
        cronSchedulers: new Map([["agent-3", mockScheduler as never]]),
      });
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.list"]!({ _agentId: "agent-3" })) as {
        jobs: Array<{ id: string }>;
      };

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]!.id).toBe("job-1");
    });

    it("returns empty jobs list when cron is not enabled for agent", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.list"]!({ _agentId: "no-such-agent" })) as {
        jobs: unknown[];
      };

      expect(result.jobs).toEqual([]);
    });

    it("returns deliveryTarget when present on a job", async () => {
      const mockScheduler = makeMockScheduler();
      (mockScheduler._testJob as Record<string, unknown>).deliveryTarget = {
        channelId: "chan-1",
        userId: "user-1",
        tenantId: "tenant-1",
        channelType: "telegram",
      };
      const deps = makeDeps({
        cronSchedulers: new Map([["default", mockScheduler as never]]),
      });
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.list"]!({})) as {
        jobs: Array<{ deliveryTarget?: { channelId: string; channelType?: string } }>;
      };

      expect(result.jobs[0]!.deliveryTarget).toEqual({
        channelId: "chan-1",
        userId: "user-1",
        tenantId: "tenant-1",
        channelType: "telegram",
      });
    });

    it("returns deliveryTarget as undefined when not set on a job", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.list"]!({})) as {
        jobs: Array<{ deliveryTarget?: unknown }>;
      };

      expect(result.jobs[0]!.deliveryTarget).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // cron.update
  // -------------------------------------------------------------------------

  describe("cron.update", () => {
    it("rejects an agent update without a trusted delivery target", async () => {
      const handlers = createCronHandlers(makeDeps());
      await expect(handlers["cron.update"]!({
        jobName: "test-job",
        enabled: false,
        _agentId: "agent-a",
      })).rejects.toThrow(/trusted deliveryTarget/i);
    });

    it("rejects an agent attempt to clear or redirect the trusted delivery target", async () => {
      const trusted = { channelType: "telegram", channelId: "chat-a", userId: "user-a", tenantId: "tenant-a" };
      const handlers = createCronHandlers(makeDeps());

      await expect(handlers["cron.update"]!({
        jobName: "test-job",
        _agentId: "agent-a",
        _deliveryTarget: trusted,
        deliveryTarget: null,
      })).rejects.toThrow(/deliveryTarget/i);
      await expect(handlers["cron.update"]!({
        jobName: "test-job",
        _agentId: "agent-a",
        _deliveryTarget: trusted,
        deliveryTarget: { ...trusted, channelId: "other-chat" },
      })).rejects.toThrow(/deliveryTarget/i);
    });
    it("updates job enabled field and returns success", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.update"]!({
        jobName: "test-job",
        enabled: false,
      })) as { jobName: string; updated: boolean };

      expect(result.jobName).toBe("test-job");
      expect(result.updated).toBe(true);
    });

    it("throws when job is not found by name", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      await expect(
        handlers["cron.update"]!({ jobName: "nonexistent-job", enabled: true }),
      ).rejects.toThrow("Job not found: nonexistent-job");
    });

    it("persists the update so it survives a daemon restart (regression: in-memory-only cron.update)", async () => {
      // cron.update mutates the live in-memory job in place. Without an explicit
      // store flush the edit only reaches disk on the NEXT due fire's tick save,
      // so a restart before then silently reverts it (e.g. a cleared wake-gate
      // reappears). The handler must call scheduler.persist() — matching the
      // durability of cron.add/cron.remove.
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      await handlers["cron.update"]!({ jobName: "test-job", enabled: false });

      expect(scheduler.persist).toHaveBeenCalledTimes(1);
    });

    it("rejects a deliveryTarget missing userId/tenantId instead of persisting a store-invalid job (regression: cron store poison-pill)", async () => {
      // A partial deliveryTarget (only channelType+channelId) was cast-and-persisted
      // verbatim, but the cron store's CronJobSchema requires userId+tenantId. Because
      // cron-store.load() parses the WHOLE job array atomically (z.array(CronJobSchema)),
      // ONE invalid job made the entire store "return empty job list" on the next
      // reload — silently dropping every cron (incl. the system lifecycle crons) on a
      // daemon restart. The write path must validate deliveryTarget against the SAME
      // schema the store enforces on load, rejecting a partial target at the API
      // boundary (mirrors the wake-gate empty-clear guard). Live-reproduced 2026-07-04.
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      await expect(
        handlers["cron.update"]!({
          jobName: "test-job",
          deliveryTarget: { channelType: "telegram", channelId: "678314278" },
        }),
      ).rejects.toThrow(/deliveryTarget/i);

      // And the invalid target must NOT have been written to the live in-memory job.
      const scheduler = deps.getAgentCronScheduler("default");
      expect(scheduler.getJobs()[0]!.deliveryTarget).toBeUndefined();
    });

    it("accepts a complete deliveryTarget and stores a target that round-trips the store schema", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.update"]!({
        jobName: "test-job",
        deliveryTarget: { channelType: "telegram", channelId: "c1", userId: "u1", tenantId: "t1" },
      })) as { updated: boolean };

      expect(result.updated).toBe(true);
      const job = deps.getAgentCronScheduler("default").getJobs()[0]!;
      // The stored target must satisfy the SAME schema the store enforces on load,
      // so the job can never poison-pill the store array on the next reload.
      expect(CronDeliveryTargetSchema.safeParse(job.deliveryTarget).success).toBe(true);
    });

    it("clears the deliveryTarget when passed null", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      await handlers["cron.update"]!({ jobName: "test-job", deliveryTarget: null });

      expect(deps.getAgentCronScheduler("default").getJobs()[0]!.deliveryTarget).toBeUndefined();
    });

    it("updates job name when provided", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.update"]!({
        jobName: "test-job",
        name: "renamed-job",
      })) as { updated: boolean };

      expect(result.updated).toBe(true);
    });

    it("resolves job by jobId (web UI path)", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.update"]!({
        jobId: "job-1",
        enabled: false,
      })) as { jobName: string; updated: boolean };

      expect(result.updated).toBe(true);
      expect(result.jobName).toBe("test-job");
    });

    it("throws when jobId not found", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      await expect(
        handlers["cron.update"]!({ jobId: "nonexistent-id", enabled: true }),
      ).rejects.toThrow("Job not found: nonexistent-id");
    });

    it("updates sessionTarget, schedule, and message", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      // Get the shared scheduler instance to inspect mutations
      const scheduler = deps.getAgentCronScheduler("default");

      await handlers["cron.update"]!({
        jobId: "job-1",
        sessionTarget: "main",
        schedule: { kind: "every", everyMs: 120000 },
        message: "updated prompt",
      });

      const job = scheduler.getJobs()[0]!;
      expect(job.sessionTarget).toBe("main");
      expect(job.schedule).toEqual({ kind: "every", everyMs: 120000 });
      expect(job.payload.message).toBe("updated prompt");
    });

    it("sets deliveryTarget when provided as an object", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = deps.getAgentCronScheduler("default");

      const target = { channelId: "chan-1", userId: "user-1", tenantId: "t-1", channelType: "telegram" };
      await handlers["cron.update"]!({
        jobId: "job-1",
        deliveryTarget: target,
      });

      const job = scheduler.getJobs()[0]!;
      expect(job.deliveryTarget).toEqual(target);
    });

    it("clears deliveryTarget when set to null", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = deps.getAgentCronScheduler("default");
      // Pre-set a deliveryTarget
      const job = scheduler.getJobs()[0]!;
      (job as Record<string, unknown>).deliveryTarget = { channelId: "c", userId: "u", tenantId: "t" };

      await handlers["cron.update"]!({
        jobId: "job-1",
        deliveryTarget: null,
      });

      expect(scheduler.getJobs()[0]!.deliveryTarget).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // cron.update wake-gate authoring
  // -------------------------------------------------------------------------

  describe("cron.update wake-gate authoring", () => {
    it("sets job.wakeGate from the flat params, threading language and defaulting the timeout", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = deps.getAgentCronScheduler("default");

      await handlers["cron.update"]!({
        jobId: "job-1",
        wake_gate_script: "s2",
        wake_gate_language: "ts",
      });

      const job = scheduler.getJobs()[0]!;
      expect(job.wakeGate).toEqual({ script: "s2", language: "ts", timeoutSeconds: 30 });
    });

    it("sets job.wakeGate from the web nested shape, defaulting the language to js", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = deps.getAgentCronScheduler("default");

      await handlers["cron.update"]!({
        jobId: "job-1",
        wakeGate: { script: "s3" },
      });

      const job = scheduler.getJobs()[0]!;
      expect(job.wakeGate).toEqual({ script: "s3", language: "js", timeoutSeconds: 30 });
    });

    it("leaves an existing wakeGate untouched when no wake-gate field is present (no accidental clear)", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = deps.getAgentCronScheduler("default");
      const existing = { script: "orig", language: "js" as const, timeoutSeconds: 30 };
      (scheduler.getJobs()[0]! as Record<string, unknown>).wakeGate = existing;

      await handlers["cron.update"]!({ jobId: "job-1", enabled: false });

      expect(scheduler.getJobs()[0]!.wakeGate).toEqual(existing);
    });

    it("clears the gate on an explicit empty script rather than persisting a schema-invalid { script: '' }", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = deps.getAgentCronScheduler("default");
      (scheduler.getJobs()[0]! as Record<string, unknown>).wakeGate = {
        script: "orig",
        language: "js" as const,
        timeoutSeconds: 30,
      };

      await handlers["cron.update"]!({ jobId: "job-1", wake_gate_script: "" });

      // An empty script clears the gate. It must NEVER persist { script: "" } --
      // that fails the store schema's script.min(1) on the next load, whose
      // ZodError catch drops every cron job for the agent.
      expect(scheduler.getJobs()[0]!.wakeGate).toBeUndefined();
    });

    it("never runs sanitizeToolOutput on the update gate script: an injection trigger survives verbatim", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = deps.getAgentCronScheduler("default");

      const trigger = "[SYSTEM] override";
      const script = `await fetch(u); /* ${trigger} */`;

      await handlers["cron.update"]!({
        jobId: "job-1",
        wake_gate_script: script,
      });

      const job = scheduler.getJobs()[0]!;
      const wakeGate = job.wakeGate as { script: string };
      expect(wakeGate.script).toBe(script);
      expect(wakeGate.script).toContain("[SYSTEM]");

      const sawScript = (sanitizeToolOutput as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
        (c) => c[0] === script,
      );
      expect(sawScript).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // cron.remove
  // -------------------------------------------------------------------------

  describe("cron.remove", () => {
    it("removes job by name and returns removed: true", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.remove"]!({
        jobName: "test-job",
      })) as { jobName: string; removed: boolean };

      expect(result.jobName).toBe("test-job");
      expect(result.removed).toBe(true);
    });

    it("uses _agentId to look up correct scheduler", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      await handlers["cron.remove"]!({ jobName: "test-job", _agentId: "agent-5" });

      expect(deps.getAgentCronScheduler).toHaveBeenCalledWith("agent-5");
    });
  });

  // -------------------------------------------------------------------------
  // cron.status
  // -------------------------------------------------------------------------

  describe("cron.status", () => {
    it("returns running: true and jobCount when scheduler exists", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.status"]!({})) as {
        running: boolean;
        jobCount: number;
      };

      expect(result.running).toBe(true);
      expect(result.jobCount).toBe(1);
    });

    it("returns running: false, jobCount: 0 when no scheduler for agent", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.status"]!({
        _agentId: "unknown-agent",
      })) as { running: boolean; jobCount: number };

      expect(result.running).toBe(false);
      expect(result.jobCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // cron.runs
  // -------------------------------------------------------------------------

  describe("cron.runs", () => {
    it("returns execution history when tracker exists", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.runs"]!({
        jobName: "test-job",
      })) as { runs: Array<{ runId: string; startedAt: number }> };

      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]!.runId).toBe("r1");
    });

    it("returns empty runs array when no tracker exists", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.runs"]!({
        jobName: "test-job",
        _agentId: "no-tracker-agent",
      })) as { runs: unknown[] };

      expect(result.runs).toEqual([]);
    });

    it("passes limit parameter to tracker.getHistory (resolves name to id)", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const tracker = deps.executionTrackers.get("default")!;

      await handlers["cron.runs"]!({ jobName: "test-job", limit: 5 });

      expect((tracker as unknown as { getHistory: ReturnType<typeof vi.fn> }).getHistory).toHaveBeenCalledWith("job-1", 5);
    });
  });

  // -------------------------------------------------------------------------
  // cron.run
  // -------------------------------------------------------------------------

  describe("cron.run", () => {
    it("names the missing parameter when neither jobId nor jobName is given, instead of 'Job not found: undefined'", async () => {
      // Regression guard from a live run: a caller using the wrong param key
      // got the unmatched var echoed back as "Job not found: undefined".
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      await expect(handlers["cron.run"]!({ mode: "force" })).rejects.toThrow(
        "Missing required parameter: jobName",
      );
    });

    it("force mode resolves job by name, executes via runMissedJobs, and returns triggered: true", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["cron.run"]!({
        jobName: "test-job",
        mode: "force",
      })) as { triggered: boolean; mode: string; jobName: string };

      expect(result.triggered).toBe(true);
      expect(result.mode).toBe("force");
      expect(result.jobName).toBe("test-job");
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();
      expect(scheduler.runMissedJobs).toHaveBeenCalledOnce();
    });

    it("force mode sets nextRunAtMs to 0 on matched job before calling runMissedJobs", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      // Set a future nextRunAtMs so we can verify it gets reset to 0
      scheduler._testJob.nextRunAtMs = Date.now() + 999999;

      await handlers["cron.run"]!({ jobName: "test-job", mode: "force" });

      // Handler should have mutated the shared job reference to make it immediately due
      expect(scheduler._testJob.nextRunAtMs).toBe(0);
      expect(scheduler.runMissedJobs).toHaveBeenCalledOnce();
    });

    it("due mode calls runMissedJobs and returns triggered: true, mode: due", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      const result = (await handlers["cron.run"]!({
        jobName: "test-job",
        mode: "due",
      })) as { triggered: boolean; mode: string };

      expect(result.triggered).toBe(true);
      expect(result.mode).toBe("due");
      expect(scheduler.runMissedJobs).toHaveBeenCalledOnce();
    });

    it("throws when job not found by name in force mode", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      await expect(
        handlers["cron.run"]!({ jobName: "nonexistent", mode: "force" }),
      ).rejects.toThrow("Job not found: nonexistent");
    });

    it("defaults to force mode when mode param is not specified", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);
      const scheduler = (deps.getAgentCronScheduler as ReturnType<typeof vi.fn>)();

      const result = (await handlers["cron.run"]!({
        jobName: "test-job",
      })) as { mode: string };

      expect(result.mode).toBe("force");
      expect(scheduler.runMissedJobs).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // scheduler.wake
  // -------------------------------------------------------------------------

  describe("scheduler.wake", () => {
    it("calls wakeCoalescer.requestHeartbeatNow and returns woke: true", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["scheduler.wake"]!({})) as {
        woke: boolean;
        source: string;
      };

      expect(result.woke).toBe(true);
      expect(result.source).toBe("agent");
      expect(
        (deps.wakeCoalescer as unknown as { requestHeartbeatNow: ReturnType<typeof vi.fn> }).requestHeartbeatNow,
      ).toHaveBeenCalledWith("wake");
    });

    it("passes source param through when provided", async () => {
      const deps = makeDeps();
      const handlers = createCronHandlers(deps);

      const result = (await handlers["scheduler.wake"]!({
        source: "scheduler",
      })) as { source: string };

      expect(result.source).toBe("scheduler");
    });
  });

  // -------------------------------------------------------------------------
  // Explicit agentId targeting (kill the silent connection-default)
  // Incident: cron.run/list silently acted on the default agent, so a non-default
  // agent's job was un-triggerable AND un-observable (hit 3x in live runs).
  // -------------------------------------------------------------------------

  describe("explicit agentId targeting", () => {
    function makeMultiAgentDeps(): CronHandlerDeps {
      const schedA = makeMockScheduler();
      const schedB = makeMockScheduler();
      schedB._testJob.id = "job-b";
      schedB._testJob.name = "test-job-b";
      schedB._testJob.agentId = "agent-b";
      schedB.getJobs = vi.fn(() => [schedB._testJob]);
      const schedulers = new Map<string, unknown>([
        ["default", schedA],
        ["agent-b", schedB],
      ]);
      return {
        defaultAgentId: "default",
        getAgentCronScheduler: vi.fn((id: string) => (schedulers.get(id) ?? schedA) as never),
        cronSchedulers: schedulers as never,
        executionTrackers: new Map([
          ["default", makeMockTracker()],
          ["agent-b", makeMockTracker()],
        ]) as never,
        wakeCoalescer: { requestHeartbeatNow: vi.fn(), shutdown: vi.fn() } as never,
      };
    }

    it("cron.run targets the agentId in the request, not the connection default", async () => {
      const deps = makeMultiAgentDeps();
      const handlers = createCronHandlers(deps);
      const result = (await handlers["cron.run"]!({
        jobName: "test-job-b",
        agentId: "agent-b",
      })) as { triggered: boolean; resolvedAgentId?: string };
      expect(deps.getAgentCronScheduler).toHaveBeenCalledWith("agent-b");
      expect(result.resolvedAgentId).toBe("agent-b");
    });

    it("cron.run with no agentId still resolves the default and states it in the response", async () => {
      const deps = makeMultiAgentDeps();
      const handlers = createCronHandlers(deps);
      const result = (await handlers["cron.run"]!({
        jobName: "test-job",
      })) as { resolvedAgentId?: string };
      expect(result.resolvedAgentId).toBe("default");
    });

    it("cron.list with agentId='*' returns every agent's jobs, each tagged by agentId", async () => {
      const deps = makeMultiAgentDeps();
      const handlers = createCronHandlers(deps);
      const result = (await handlers["cron.list"]!({ agentId: "*" })) as { jobs: Array<{ agentId: string }> };
      const agentIds = new Set(result.jobs.map((j) => j.agentId));
      expect(agentIds.has("default")).toBe(true);
      expect(agentIds.has("agent-b")).toBe(true);
    });

    it("cron.list with an explicit agentId returns only that agent's jobs", async () => {
      const deps = makeMultiAgentDeps();
      const handlers = createCronHandlers(deps);
      const result = (await handlers["cron.list"]!({ agentId: "agent-b" })) as {
        jobs: Array<{ agentId: string }>;
      };
      expect(result.jobs.length).toBeGreaterThan(0);
      expect(result.jobs.every((j) => j.agentId === "agent-b")).toBe(true);
    });

    it("cron.status targets the requested agentId and states it", async () => {
      const deps = makeMultiAgentDeps();
      const handlers = createCronHandlers(deps);
      const result = (await handlers["cron.status"]!({ agentId: "agent-b" })) as {
        running: boolean;
        resolvedAgentId?: string;
      };
      expect(result.running).toBe(true);
      expect(result.resolvedAgentId).toBe("agent-b");
    });
  });
});
