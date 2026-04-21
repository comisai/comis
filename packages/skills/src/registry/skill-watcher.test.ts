// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock chokidar
// ---------------------------------------------------------------------------

type EventHandler = (path: string) => void;

/** Simulated FSWatcher that stores event handlers for test-driven invocation. */
function createMockWatcher() {
  const handlers = new Map<string, EventHandler>();
  return {
    on(event: string, handler: EventHandler) {
      handlers.set(event, handler);
      return this;
    },
    close: vi.fn(async () => {}),
    /** Invoke the handler registered for the given event. */
    simulateEvent(event: string, path: string) {
      const handler = handlers.get(event);
      if (handler) handler(path);
    },
  };
}

/** Pool of mock watchers returned by successive watch() calls. */
let mockWatchers: ReturnType<typeof createMockWatcher>[];
let watchCallIndex: number;

vi.mock("chokidar", () => ({
  watch: vi.fn(() => {
    const watcher = mockWatchers[watchCallIndex] ?? createMockWatcher();
    watchCallIndex++;
    return watcher;
  }),
}));

// ---------------------------------------------------------------------------
// Mock node:fs
// ---------------------------------------------------------------------------

const accessSyncMock = vi.fn();

vi.mock("node:fs", () => ({
  accessSync: (...args: unknown[]) => accessSyncMock(...args),
  realpathSync: (p: string) => p,
}));

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------

import { createSkillWatcher } from "./skill-watcher.js";
import { watch } from "chokidar";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSkillWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockWatchers = [createMockWatcher(), createMockWatcher()];
    watchCallIndex = 0;
    accessSyncMock.mockReset();
    // Default: all paths exist
    accessSyncMock.mockImplementation(() => {});
    vi.mocked(watch).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("single file change triggers onReload after debounce", () => {
    const onReload = vi.fn();
    createSkillWatcher({
      discoveryPaths: ["/skills"],
      debounceMs: 400,
      onReload,
    });

    mockWatchers[0].simulateEvent("change", "/skills/SKILL.md");

    // Not called yet -- still within debounce window
    expect(onReload).not.toHaveBeenCalled();

    vi.advanceTimersByTime(400);

    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("multiple changes within debounce window coalesce into one reload", () => {
    const onReload = vi.fn();
    createSkillWatcher({
      discoveryPaths: ["/skills"],
      debounceMs: 400,
      onReload,
    });

    // Simulate 5 rapid changes, each 50ms apart (all within 400ms window)
    for (let i = 0; i < 5; i++) {
      mockWatchers[0].simulateEvent("change", `/skills/skill-${i}.md`);
      vi.advanceTimersByTime(50);
    }

    // At this point 250ms have elapsed since first event, 0ms since last.
    // Still within debounce window of last event.
    expect(onReload).not.toHaveBeenCalled();

    // Advance past the debounce window from the last event
    vi.advanceTimersByTime(400);

    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("close() cancels pending debounce timer", async () => {
    const onReload = vi.fn();
    const handle = createSkillWatcher({
      discoveryPaths: ["/skills"],
      debounceMs: 400,
      onReload,
    });

    mockWatchers[0].simulateEvent("change", "/skills/SKILL.md");

    // Close before debounce fires
    await handle.close();

    // Advance well past the debounce window
    vi.advanceTimersByTime(1000);

    expect(onReload).not.toHaveBeenCalled();
    expect(mockWatchers[0].close).toHaveBeenCalledTimes(1);
  });

  it("no-op handle when no discovery paths exist and no parent found", async () => {
    // Simulate no paths exist and no parent dirs (root-level)
    accessSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const onReload = vi.fn();
    const handle = createSkillWatcher({
      discoveryPaths: ["/nonexistent/a", "/nonexistent/b"],
      debounceMs: 400,
      onReload,
    });

    // watch() should not have been called for skill watching
    expect(watch).not.toHaveBeenCalled();

    // close() should resolve cleanly
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it("add event triggers reload (new skill files)", () => {
    const onReload = vi.fn();
    createSkillWatcher({
      discoveryPaths: ["/skills"],
      debounceMs: 400,
      onReload,
    });

    mockWatchers[0].simulateEvent("add", "/skills/new-skill/SKILL.md");

    vi.advanceTimersByTime(400);

    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("unlink event triggers reload (deleted skill files)", () => {
    const onReload = vi.fn();
    createSkillWatcher({
      discoveryPaths: ["/skills"],
      debounceMs: 400,
      onReload,
    });

    mockWatchers[0].simulateEvent("unlink", "/skills/removed/SKILL.md");

    vi.advanceTimersByTime(400);

    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("close() resolves cleanly even without pending timer", async () => {
    const onReload = vi.fn();
    const handle = createSkillWatcher({
      discoveryPaths: ["/skills"],
      debounceMs: 400,
      onReload,
    });

    // No events triggered -- close immediately
    await expect(handle.close()).resolves.toBeUndefined();
    expect(mockWatchers[0].close).toHaveBeenCalledTimes(1);
  });

  it("logger receives debug message when no paths exist", () => {
    accessSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    createSkillWatcher({
      discoveryPaths: ["/nonexistent"],
      debounceMs: 400,
      onReload: vi.fn(),
      logger,
    });

    expect(logger.debug).toHaveBeenCalledWith(
      {},
      "No discovery paths exist, skill watcher not started",
    );
  });

  it("watches parent directory when discovery path does not exist yet", () => {
    // /data exists, /data/skills does not
    accessSyncMock.mockImplementation((p: string) => {
      if (p === "/data/skills") throw new Error("ENOENT");
      // /data exists
    });

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    createSkillWatcher({
      discoveryPaths: ["/data/skills"],
      debounceMs: 400,
      onReload: vi.fn(),
      logger,
    });

    // Should have started a parent watcher on /data
    expect(watch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(watch).mock.calls[0][0]).toEqual(["/data"]);

    expect(logger.debug).toHaveBeenCalledWith(
      { missingPaths: ["/data/skills"], watchedParents: ["/data"] },
      "Watching parent directories for discovery path creation",
    );
  });

  it("starts skill watcher when missing discovery path is created", () => {
    // Initially: /data exists, /data/skills does not
    let skillsExists = false;
    accessSyncMock.mockImplementation((p: string) => {
      if (p === "/data/skills" && !skillsExists) throw new Error("ENOENT");
    });

    const onReload = vi.fn();
    createSkillWatcher({
      discoveryPaths: ["/data/skills"],
      debounceMs: 400,
      onReload,
    });

    // First watch() call is the parent watcher
    expect(watch).toHaveBeenCalledTimes(1);
    const parentWatcherInstance = mockWatchers[0];

    // Simulate /data/skills being created
    skillsExists = true;
    parentWatcherInstance.simulateEvent("addDir", "/data/skills");

    // Parent watcher should be closed
    expect(parentWatcherInstance.close).toHaveBeenCalledTimes(1);

    // A new skill watcher should have been started
    expect(watch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(watch).mock.calls[1][0]).toEqual(["/data/skills"]);

    // Re-discovery should be triggered after debounce
    vi.advanceTimersByTime(400);
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
