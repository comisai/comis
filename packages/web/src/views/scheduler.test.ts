import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import type { IcSchedulerView } from "./scheduler.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";

// Side-effect import to register custom element
import "./scheduler.js";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const MOCK_JOBS = [
  {
    id: "daily-report",
    name: "Daily Report",
    agentId: "default",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "America/New_York" },
    payload: { kind: "agent_turn", message: "Generate daily report" },
    sessionTarget: "isolated",
    enabled: true,
    nextRunAtMs: Date.now() + 86400000,
    lastRunAtMs: Date.now() - 3600000,
    consecutiveErrors: 0,
    createdAtMs: Date.now() - 86400000 * 30,
  },
  {
    id: "health-check",
    name: "Health Check",
    agentId: "default",
    schedule: { kind: "every", everyMs: 300000 },
    payload: { kind: "system_event", text: "health ping" },
    sessionTarget: "main",
    enabled: true,
    nextRunAtMs: Date.now() + 300000,
    lastRunAtMs: Date.now() - 60000,
    consecutiveErrors: 0,
    createdAtMs: Date.now() - 86400000 * 7,
  },
  {
    id: "old-backup",
    name: "Old Backup",
    agentId: "backup-agent",
    schedule: { kind: "cron", expr: "0 3 * * *" },
    payload: { kind: "agent_turn", message: "Run backup" },
    sessionTarget: "isolated",
    enabled: false,
    lastRunAtMs: 0,
    consecutiveErrors: 0,
    createdAtMs: Date.now() - 86400000 * 60,
  },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function createSchedulerMockRpcClient(jobs: unknown[] = MOCK_JOBS): RpcClient {
  return createMockRpcClient((method: string) => {
    if (method === "cron.list") return Promise.resolve(jobs);
    if (method === "cron.add") return Promise.resolve({ jobId: "new-job-1" });
    if (method === "cron.update") return Promise.resolve({ updated: true });
    if (method === "cron.remove") return Promise.resolve({ removed: true });
    if (method === "config.read")
      return Promise.resolve({ heartbeat: { enabled: false, intervalMs: 300000 } });
    if (method === "config.set") return Promise.resolve({ updated: true });
    return Promise.resolve({});
  });
}

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcSchedulerView> {
  const el = document.createElement("ic-scheduler-view") as IcSchedulerView;
  if (props) {
    Object.assign(el, props);
  }
  document.body.appendChild(el);
  await (el as any).updateComplete;
  return el;
}

/** Flush pending microtasks (for RPC promises). */
async function flush(el: IcSchedulerView): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await (el as any).updateComplete;
}

function createMockEventDispatcher(): EventDispatcher & { _fire: (type: string, data?: unknown) => void } {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    connected: true,
    start: vi.fn(),
    stop: vi.fn(),
    addEventListener(type: string, handler: (data: unknown) => void): () => void {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
      return () => {
        handlers.get(type)?.delete(handler);
      };
    },
    _fire(type: string, data: unknown = {}) {
      handlers.get(type)?.forEach((h) => h(data));
    },
  };
}

/** Access private fields. */
function priv(el: IcSchedulerView) {
  return el as unknown as {
    _jobs: unknown[];
    _loading: boolean;
    _error: string;
    _activeTab: string;
    _executions: Array<{ jobId: string; success: boolean | "pending"; durationMs?: number }>;
    _heartbeats: Array<{ checksRun: number; alertsRaised: number; timestamp: number }>;
    _heartbeatAlerts: Array<{ agentId: string; classification: string; reason: string; consecutiveErrors: number; backoffMs: number; timestamp: number }>;
    _heartbeatDeliveries: Array<{ agentId: string; channelType: string; outcome: string; level: string; durationMs: number; timestamp: number }>;
    _heartbeatEnabled: boolean;
    _heartbeatIntervalMs: number;
    _extractedTasks: Array<{ taskId: string; title: string; status: string; priority: string }>;
    _editorOpen: boolean;
    _editingJob: unknown;
    _editorError: string;
    _sse: unknown;
    _initSse(): void;
    rpcClient: RpcClient | null;
    eventDispatcher: EventDispatcher | null;
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("IcSchedulerView", () => {
  it("1 - renders 3 tabs", async () => {
    const rpc = createSchedulerMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const tabs = el.shadowRoot?.querySelector("ic-tabs");
    expect(tabs).toBeTruthy();
    const tabDefs = (tabs as any).tabs;
    expect(tabDefs).toHaveLength(3);
    expect(tabDefs.map((t: { id: string }) => t.id)).toEqual(["cron-jobs", "heartbeat", "extracted-tasks"]);
  });

  it("2 - shows loading state initially", async () => {
    // Create a never-resolving RPC to keep loading
    const rpc = createSchedulerMockRpcClient();
    (rpc.call as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => {}),
    );
    const el = await createElement({ rpcClient: rpc });

    expect(priv(el)._loading).toBe(true);
    const loading = el.shadowRoot?.querySelector("ic-skeleton-view");
    expect(loading).toBeTruthy();
  });

  it("3 - calls cron.list on connect", async () => {
    const rpc = createSchedulerMockRpcClient();
    await createElement({ rpcClient: rpc });

    expect(rpc.call).toHaveBeenCalledWith("cron.list", expect.objectContaining({}));
  });

  it("4 - renders job table with correct rows", async () => {
    const rpc = createSchedulerMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const rows = el.shadowRoot?.querySelectorAll(".grid-row");
    expect(rows?.length).toBe(3);
  });

  it("5 - job table shows schedule expression", async () => {
    const rpc = createSchedulerMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const rows = el.shadowRoot?.querySelectorAll(".grid-row");
    const firstRowText = rows?.[0]?.textContent ?? "";
    expect(firstRowText).toContain("0 9 * * *");
  });

  it("6 - job table shows relative time for last run", async () => {
    const rpc = createSchedulerMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const relTimes = el.shadowRoot?.querySelectorAll("ic-relative-time");
    expect(relTimes?.length).toBeGreaterThanOrEqual(1);
  });

  it("7 - job table shows status indicators", async () => {
    const rpc = createSchedulerMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const activeDots = el.shadowRoot?.querySelectorAll(".status-dot--active");
    const inactiveDots = el.shadowRoot?.querySelectorAll(".status-dot--inactive");
    // 2 enabled jobs (daily-report, health-check), 1 disabled (old-backup)
    expect(activeDots?.length).toBe(2);
    expect(inactiveDots?.length).toBe(1);
  });

  it("8 - shows empty state when no jobs", async () => {
    const rpc = createMockRpcClient([]);
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const empty = el.shadowRoot?.querySelector("ic-empty-state");
    expect(empty).toBeTruthy();
    expect((empty as any)?.message).toBe("No scheduled jobs");
  });

  it("9 - shows error state on RPC failure", async () => {
    const rpc = createSchedulerMockRpcClient();
    (rpc.call as ReturnType<typeof vi.fn>).mockImplementation((method: string) => {
      if (method === "cron.list") return Promise.reject(new Error("Connection lost"));
      if (method === "config.read")
        return Promise.resolve({ heartbeat: { enabled: false, intervalMs: 300000 } });
      return Promise.resolve({});
    });
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    expect(priv(el)._error).toBe("Connection lost");
    const errMsg = el.shadowRoot?.querySelector(".error-message");
    expect(errMsg?.textContent).toContain("Connection lost");
  });

  it("10 - click job row opens editor", async () => {
    const rpc = createSchedulerMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const row = el.shadowRoot?.querySelector(".grid-row") as HTMLElement;
    row.click();
    await (el as any).updateComplete;

    expect(priv(el)._editorOpen).toBe(true);
    expect(priv(el)._editingJob).toBeTruthy();
    const editor = el.shadowRoot?.querySelector("ic-cron-editor");
    expect(editor).toBeTruthy();
    expect((editor as any)?.mode).toBe("edit");
  });

  it("11 - New Job button opens editor in create mode", async () => {
    const rpc = createSchedulerMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const btn = el.shadowRoot?.querySelector(".btn-primary") as HTMLElement;
    btn.click();
    await (el as any).updateComplete;

    expect(priv(el)._editorOpen).toBe(true);
    expect(priv(el)._editingJob).toBeNull();
    const editor = el.shadowRoot?.querySelector("ic-cron-editor");
    expect(editor).toBeTruthy();
    expect((editor as any)?.mode).toBe("create");
  });

  it("12 - cancel editor closes overlay", async () => {
    const rpc = createSchedulerMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    // Open editor
    const btn = el.shadowRoot?.querySelector(".btn-primary") as HTMLElement;
    btn.click();
    await (el as any).updateComplete;
    expect(priv(el)._editorOpen).toBe(true);

    // Dispatch cancel from ic-cron-editor
    const editor = el.shadowRoot?.querySelector("ic-cron-editor") as HTMLElement;
    editor.dispatchEvent(new CustomEvent("cancel"));
    await (el as any).updateComplete;

    expect(priv(el)._editorOpen).toBe(false);
  });

  it("13 - tab switching shows correct content", async () => {
    const rpc = createSchedulerMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    // Switch to heartbeat tab
    priv(el)._activeTab = "heartbeat";
    await (el as any).updateComplete;

    // Heartbeat tab renders empty state when no agents configured
    const emptyState = el.shadowRoot?.querySelector("ic-empty-state");
    expect(emptyState).toBeTruthy();
  });

  it("14 - SSE job_completed event adds execution record", async () => {
    const rpc = createSchedulerMockRpcClient();
    const mockDispatcher = createMockEventDispatcher();
    const el = await createElement({ rpcClient: rpc, eventDispatcher: mockDispatcher });
    await flush(el);

    mockDispatcher._fire("scheduler:job_completed", {
      jobId: "daily-report",
      jobName: "Daily Report",
      agentId: "default",
      durationMs: 1200,
      success: true,
      timestamp: Date.now(),
    });
    await (el as any).updateComplete;

    expect(priv(el)._executions).toHaveLength(1);
    expect(priv(el)._executions[0].jobId).toBe("daily-report");
    expect(priv(el)._executions[0].success).toBe(true);
    expect(priv(el)._executions[0].durationMs).toBe(1200);
  });

  it("15 - SSE job_started then job_completed updates pending record", async () => {
    const rpc = createSchedulerMockRpcClient();
    const mockDispatcher = createMockEventDispatcher();
    const el = await createElement({ rpcClient: rpc, eventDispatcher: mockDispatcher });
    await flush(el);

    // Dispatch job_started
    mockDispatcher._fire("scheduler:job_started", {
      jobId: "health-check",
      jobName: "Health Check",
      agentId: "default",
      timestamp: Date.now(),
    });
    await (el as any).updateComplete;

    expect(priv(el)._executions).toHaveLength(1);
    expect(priv(el)._executions[0].success).toBe("pending");

    // Dispatch job_completed for same job
    mockDispatcher._fire("scheduler:job_completed", {
      jobId: "health-check",
      jobName: "Health Check",
      success: true,
      durationMs: 500,
      timestamp: Date.now(),
    });
    await (el as any).updateComplete;

    expect(priv(el)._executions).toHaveLength(1);
    expect(priv(el)._executions[0].success).toBe(true);
    expect(priv(el)._executions[0].durationMs).toBe(500);
  });

  it("16 - SSE task_extracted event adds task to extracted tasks tab", async () => {
    const rpc = createSchedulerMockRpcClient();
    const mockDispatcher = createMockEventDispatcher();
    const el = await createElement({ rpcClient: rpc, eventDispatcher: mockDispatcher });
    await flush(el);

    mockDispatcher._fire("scheduler:task_extracted", {
      taskId: "task-001",
      title: "Summarize meeting",
      priority: "high",
      confidence: 0.9,
      sessionKey: "agent:default",
      timestamp: Date.now(),
    });
    await (el as any).updateComplete;

    expect(priv(el)._extractedTasks).toHaveLength(1);
    expect(priv(el)._extractedTasks[0].title).toBe("Summarize meeting");
    expect(priv(el)._extractedTasks[0].status).toBe("pending");

    // Switch to extracted tasks tab and verify rendering
    priv(el)._activeTab = "extracted-tasks";
    await (el as any).updateComplete;

    const taskTable = el.shadowRoot?.querySelector(".task-grid");
    expect(taskTable).toBeTruthy();
    const taskText = taskTable?.textContent ?? "";
    expect(taskText).toContain("Summarize meeting");
  });

  it("17 - extracted task mark-complete updates status", async () => {
    const rpc = createSchedulerMockRpcClient();
    const mockDispatcher = createMockEventDispatcher();
    const el = await createElement({ rpcClient: rpc, eventDispatcher: mockDispatcher });
    await flush(el);

    // Add a task via SSE
    mockDispatcher._fire("scheduler:task_extracted", {
      taskId: "task-002",
      title: "Fix bug",
      priority: "medium",
      timestamp: Date.now(),
    });
    await (el as any).updateComplete;

    // Switch to tasks tab
    priv(el)._activeTab = "extracted-tasks";
    await (el as any).updateComplete;

    // Click complete button
    const completeBtn = el.shadowRoot?.querySelector(".btn-complete") as HTMLElement;
    expect(completeBtn).toBeTruthy();
    completeBtn.click();
    await (el as any).updateComplete;

    expect(priv(el)._extractedTasks[0].status).toBe("completed");
  });

  it("18 - delete button calls cron.remove RPC", async () => {
    // Mock window.confirm to return true
    vi.stubGlobal("confirm", vi.fn(() => true));

    const rpc = createSchedulerMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const deleteBtn = el.shadowRoot?.querySelector(".btn-delete") as HTMLElement;
    expect(deleteBtn).toBeTruthy();

    deleteBtn.click();
    await flush(el);

    expect(rpc.call).toHaveBeenCalledWith("cron.remove", expect.objectContaining({ jobId: "daily-report" }));
    // Job should be removed from list (optimistic)
    expect(priv(el)._jobs).toHaveLength(2);

    vi.unstubAllGlobals();
  });

  it("19 - editor save in create mode calls cron.add RPC", async () => {
    const rpc = createSchedulerMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    // Open create editor
    const btn = el.shadowRoot?.querySelector(".btn-primary") as HTMLElement;
    btn.click();
    await (el as any).updateComplete;

    // Dispatch save event from editor
    const editor = el.shadowRoot?.querySelector("ic-cron-editor") as HTMLElement;
    editor.dispatchEvent(
      new CustomEvent("save", {
        detail: {
          id: "new-job",
          name: "New Job",
          agentId: "default",
          schedule: { kind: "cron", expr: "0 12 * * *" },
          message: "Do something",
          enabled: true,
          maxConcurrent: 1,
          sessionTarget: "main",
        },
      }),
    );
    await flush(el);

    expect(rpc.call).toHaveBeenCalledWith(
      "cron.add",
      expect.objectContaining({ id: "new-job", name: "New Job" }),
    );
    // New job should be in list
    expect(priv(el)._jobs).toHaveLength(4);
    expect(priv(el)._editorOpen).toBe(false);
  });

  it("20 - editor save in edit mode calls cron.update RPC", async () => {
    const rpc = createSchedulerMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    // Click first job row to open in edit mode
    const row = el.shadowRoot?.querySelector(".grid-row") as HTMLElement;
    row.click();
    await (el as any).updateComplete;

    // Dispatch save event from editor
    const editor = el.shadowRoot?.querySelector("ic-cron-editor") as HTMLElement;
    editor.dispatchEvent(
      new CustomEvent("save", {
        detail: {
          id: "daily-report",
          name: "Daily Report Updated",
          agentId: "default",
          schedule: { kind: "cron", expr: "0 10 * * *" },
          message: "Generate updated report",
          enabled: true,
          maxConcurrent: 1,
          sessionTarget: "isolated",
        },
      }),
    );
    await flush(el);

    expect(rpc.call).toHaveBeenCalledWith(
      "cron.update",
      expect.objectContaining({ jobId: "daily-report", name: "Daily Report Updated" }),
    );
    expect(priv(el)._editorOpen).toBe(false);
  });

  it("21 - heartbeat tab shows global status when enabled", async () => {
    const rpc = createSchedulerMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    // Enable heartbeat in internal state
    priv(el)._heartbeatEnabled = true;
    priv(el)._activeTab = "heartbeat";
    await (el as any).updateComplete;

    // Should show global heartbeat summary bar (no agents, but enabled)
    const summaryBar = el.shadowRoot?.querySelector(".hb-summary-bar");
    expect(summaryBar).toBeTruthy();
    expect(summaryBar?.textContent).toContain("enabled");
  });

  it("22 - disconnectedCallback cleans up SSE listeners", async () => {
    const rpc = createSchedulerMockRpcClient();
    const mockDispatcher = createMockEventDispatcher();
    const el = await createElement({ rpcClient: rpc, eventDispatcher: mockDispatcher });
    await flush(el);

    // SseController should be initialized
    expect(priv(el)._sse).not.toBeNull();

    // Remove the element -- should call disconnectedCallback which triggers SseController cleanup
    el.remove();

    // After removal, dispatching events through the mock dispatcher should not affect state
    const execBefore = priv(el)._executions.length;
    mockDispatcher._fire("scheduler:job_completed", {
      jobId: "test",
      success: true,
      timestamp: Date.now(),
    });
    expect(priv(el)._executions.length).toBe(execBefore);
  });

  it("23 - SSE heartbeat_delivered event adds delivery record", async () => {
    const rpc = createSchedulerMockRpcClient();
    const mockDispatcher = createMockEventDispatcher();
    const el = await createElement({ rpcClient: rpc, eventDispatcher: mockDispatcher });
    await flush(el);

    mockDispatcher._fire("scheduler:heartbeat_delivered", {
      agentId: "default",
      channelType: "telegram",
      outcome: "delivered",
      level: "ok",
      durationMs: 250,
      timestamp: Date.now(),
    });
    await (el as any).updateComplete;

    expect(priv(el)._heartbeatDeliveries).toHaveLength(1);
    expect(priv(el)._heartbeatDeliveries[0].agentId).toBe("default");
    expect(priv(el)._heartbeatDeliveries[0].outcome).toBe("delivered");
  });

  it("24 - loads heartbeat config on connect", async () => {
    const rpc = createSchedulerMockRpcClient();
    await createElement({ rpcClient: rpc });

    expect(rpc.call).toHaveBeenCalledWith("config.read", { section: "scheduler" });
  });
});
