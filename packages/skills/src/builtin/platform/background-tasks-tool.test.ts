// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for background_tasks agent tool.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBackgroundTasksTool, type BackgroundTaskManagerLike } from "./background-tasks-tool.js";
import { ok, err } from "@comis/shared";

function createMockManager(overrides: Partial<BackgroundTaskManagerLike> = {}): BackgroundTaskManagerLike {
  return {
    cancel: vi.fn(() => ok(undefined)),
    getTask: vi.fn(() => undefined),
    getTasks: vi.fn(() => []),
    ...overrides,
  };
}

const AGENT_ID = "agent-1";

describe("background_tasks tool", () => {
  let manager: BackgroundTaskManagerLike;

  beforeEach(() => {
    manager = createMockManager();
  });

  describe("list action", () => {
    it("returns all tasks for the agent as JSON array", async () => {
      const tasks = [
        { id: "t1", agentId: AGENT_ID, toolName: "web_fetch", status: "running" as const, startedAt: 1000 },
        { id: "t2", agentId: AGENT_ID, toolName: "exec", status: "completed" as const, startedAt: 2000, completedAt: 3000 },
      ];
      manager = createMockManager({ getTasks: vi.fn(() => tasks) });
      const tool = createBackgroundTasksTool({ manager, agentId: AGENT_ID });

      const result = await tool.execute("call-1", { action: "list" });
      const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toMatchObject({ id: "t1", toolName: "web_fetch", status: "running" });
      expect(parsed[1]).toMatchObject({ id: "t2", toolName: "exec", status: "completed" });
      expect(manager.getTasks).toHaveBeenCalledWith(AGENT_ID);
    });

    it("returns empty array when no tasks", async () => {
      const tool = createBackgroundTasksTool({ manager, agentId: AGENT_ID });

      const result = await tool.execute("call-1", { action: "list" });
      const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

      expect(parsed).toEqual([]);
    });
  });

  describe("get action", () => {
    it("returns task details for valid taskId", async () => {
      const task = {
        id: "t1", agentId: AGENT_ID, toolName: "web_fetch",
        status: "completed" as const, startedAt: 1000, completedAt: 2000,
        result: '"done"',
      };
      manager = createMockManager({ getTask: vi.fn(() => task) });
      const tool = createBackgroundTasksTool({ manager, agentId: AGENT_ID });

      const result = await tool.execute("call-1", { action: "get", taskId: "t1" });
      const text = (result as { content: Array<{ text: string }> }).content[0].text;
      const parsed = JSON.parse(text);

      expect(parsed).toMatchObject({ id: "t1", toolName: "web_fetch", status: "completed" });
      expect(manager.getTask).toHaveBeenCalledWith("t1");
    });

    it("returns error for invalid taskId", async () => {
      const tool = createBackgroundTasksTool({ manager, agentId: AGENT_ID });

      const result = await tool.execute("call-1", { action: "get", taskId: "nonexistent" });
      const text = (result as { content: Array<{ text: string }> }).content[0].text;

      expect(text).toContain("not found");
    });

    it("returns error when task belongs to different agent", async () => {
      const task = {
        id: "t1", agentId: "other-agent", toolName: "web_fetch",
        status: "running" as const, startedAt: 1000,
      };
      manager = createMockManager({ getTask: vi.fn(() => task) });
      const tool = createBackgroundTasksTool({ manager, agentId: AGENT_ID });

      const result = await tool.execute("call-1", { action: "get", taskId: "t1" });
      const text = (result as { content: Array<{ text: string }> }).content[0].text;

      expect(text).toContain("not found");
    });
  });

  describe("cancel action", () => {
    it("cancels a valid running task", async () => {
      const task = { id: "t1", agentId: AGENT_ID, toolName: "exec", status: "running" as const, startedAt: 1000 };
      manager = createMockManager({
        getTask: vi.fn(() => task),
        cancel: vi.fn(() => ok(undefined)),
      });
      const tool = createBackgroundTasksTool({ manager, agentId: AGENT_ID });

      const result = await tool.execute("call-1", { action: "cancel", taskId: "t1" });
      const text = (result as { content: Array<{ text: string }> }).content[0].text;

      expect(text).toContain("cancelled successfully");
      expect(manager.cancel).toHaveBeenCalledWith("t1");
    });

    it("returns error for non-running task", async () => {
      const task = { id: "t1", agentId: AGENT_ID, toolName: "exec", status: "running" as const, startedAt: 1000 };
      manager = createMockManager({
        getTask: vi.fn(() => task),
        cancel: vi.fn(() => err(new Error("Task t1 is not running"))),
      });
      const tool = createBackgroundTasksTool({ manager, agentId: AGENT_ID });

      const result = await tool.execute("call-1", { action: "cancel", taskId: "t1" });
      const text = (result as { content: Array<{ text: string }> }).content[0].text;

      expect(text).toContain("Error");
    });

    it("returns error when task belongs to different agent", async () => {
      const task = { id: "t1", agentId: "other-agent", toolName: "exec", status: "running" as const, startedAt: 1000 };
      manager = createMockManager({ getTask: vi.fn(() => task) });
      const tool = createBackgroundTasksTool({ manager, agentId: AGENT_ID });

      const result = await tool.execute("call-1", { action: "cancel", taskId: "t1" });
      const text = (result as { content: Array<{ text: string }> }).content[0].text;

      expect(text).toContain("not found");
    });
  });

  describe("read_output action", () => {
    it("returns result for completed task", async () => {
      const task = {
        id: "t1", agentId: AGENT_ID, toolName: "web_fetch",
        status: "completed" as const, startedAt: 1000, completedAt: 2000,
        result: '{"data":"hello"}',
      };
      manager = createMockManager({ getTask: vi.fn(() => task) });
      const tool = createBackgroundTasksTool({ manager, agentId: AGENT_ID });

      const result = await tool.execute("call-1", { action: "read_output", taskId: "t1" });
      const text = (result as { content: Array<{ text: string }> }).content[0].text;

      expect(text).toContain('{"data":"hello"}');
    });

    it("returns still running message for running task", async () => {
      const task = {
        id: "t1", agentId: AGENT_ID, toolName: "web_fetch",
        status: "running" as const, startedAt: 1000,
      };
      manager = createMockManager({ getTask: vi.fn(() => task) });
      const tool = createBackgroundTasksTool({ manager, agentId: AGENT_ID });

      const result = await tool.execute("call-1", { action: "read_output", taskId: "t1" });
      const text = (result as { content: Array<{ text: string }> }).content[0].text;

      expect(text).toContain("still running");
    });

    it("returns failure message for failed task", async () => {
      const task = {
        id: "t1", agentId: AGENT_ID, toolName: "web_fetch",
        status: "failed" as const, startedAt: 1000, completedAt: 2000,
        error: "Connection timeout",
      };
      manager = createMockManager({ getTask: vi.fn(() => task) });
      const tool = createBackgroundTasksTool({ manager, agentId: AGENT_ID });

      const result = await tool.execute("call-1", { action: "read_output", taskId: "t1" });
      const text = (result as { content: Array<{ text: string }> }).content[0].text;

      expect(text).toContain("Task failed");
      expect(text).toContain("Connection timeout");
    });

    it("returns cancelled message for cancelled task", async () => {
      const task = {
        id: "t1", agentId: AGENT_ID, toolName: "web_fetch",
        status: "cancelled" as const, startedAt: 1000, completedAt: 2000,
      };
      manager = createMockManager({ getTask: vi.fn(() => task) });
      const tool = createBackgroundTasksTool({ manager, agentId: AGENT_ID });

      const result = await tool.execute("call-1", { action: "read_output", taskId: "t1" });
      const text = (result as { content: Array<{ text: string }> }).content[0].text;

      expect(text).toContain("cancelled");
    });
  });

  describe("validation", () => {
    it("throws error for missing taskId on get action", async () => {
      const tool = createBackgroundTasksTool({ manager, agentId: AGENT_ID });

      await expect(
        tool.execute("call-1", { action: "get" }),
      ).rejects.toThrow(/taskId/i);
    });

    it("throws error for missing taskId on cancel action", async () => {
      const tool = createBackgroundTasksTool({ manager, agentId: AGENT_ID });

      await expect(
        tool.execute("call-1", { action: "cancel" }),
      ).rejects.toThrow(/taskId/i);
    });

    it("throws error for missing taskId on read_output action", async () => {
      const tool = createBackgroundTasksTool({ manager, agentId: AGENT_ID });

      await expect(
        tool.execute("call-1", { action: "read_output" }),
      ).rejects.toThrow(/taskId/i);
    });
  });
});
