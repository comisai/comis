// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDirtyTracker } from "./dirty-state.js";

describe("createDirtyTracker", () => {
  let tracker: ReturnType<typeof createDirtyTracker>;

  beforeEach(() => {
    tracker = createDirtyTracker();
  });

  afterEach(() => {
    tracker.detach();
  });

  it("isDirty is false initially", () => {
    expect(tracker.isDirty).toBe(false);
  });

  it("markDirty() sets isDirty to true", () => {
    tracker.markDirty();
    expect(tracker.isDirty).toBe(true);
  });

  it("markDirty(fieldName) tracks specific field", () => {
    tracker.markDirty("name");
    expect(tracker.isDirty).toBe(true);
    expect(tracker.dirtyFields()).toContain("name");
  });

  it("tracks multiple dirty fields", () => {
    tracker.markDirty("name");
    tracker.markDirty("model");
    tracker.markDirty("provider");
    expect(tracker.dirtyFields()).toEqual(
      expect.arrayContaining(["name", "model", "provider"]),
    );
    expect(tracker.dirtyFields()).toHaveLength(3);
  });

  it("markDirty() with same field does not duplicate", () => {
    tracker.markDirty("name");
    tracker.markDirty("name");
    expect(tracker.dirtyFields()).toHaveLength(1);
  });

  it("markClean() resets to not dirty", () => {
    tracker.markDirty("name");
    tracker.markDirty("model");
    expect(tracker.isDirty).toBe(true);

    tracker.markClean();
    expect(tracker.isDirty).toBe(false);
    expect(tracker.dirtyFields()).toHaveLength(0);
  });

  it("dirtyFields() returns the set of dirty field names", () => {
    expect(tracker.dirtyFields()).toEqual([]);

    tracker.markDirty("temperature");
    tracker.markDirty("maxSteps");
    const fields = tracker.dirtyFields();
    expect(fields).toContain("temperature");
    expect(fields).toContain("maxSteps");
    expect(fields).toHaveLength(2);
  });

  it("dirtyFields() returns a copy, not the internal set", () => {
    tracker.markDirty("name");
    const fields1 = tracker.dirtyFields();
    tracker.markDirty("model");
    const fields2 = tracker.dirtyFields();
    // fields1 should not have been mutated
    expect(fields1).toHaveLength(1);
    expect(fields2).toHaveLength(2);
  });

  it("confirmNavigation() returns true when clean (no prompt)", () => {
    const original = window.confirm;
    window.confirm = vi.fn(() => true);
    expect(tracker.confirmNavigation()).toBe(true);
    expect(window.confirm).not.toHaveBeenCalled();
    window.confirm = original;
  });

  it("confirmNavigation() calls window.confirm when dirty and user confirms", () => {
    const original = window.confirm;
    window.confirm = vi.fn(() => true);
    tracker.markDirty("name");
    expect(tracker.confirmNavigation()).toBe(true);
    expect(window.confirm).toHaveBeenCalledWith(
      "You have unsaved changes. Discard and leave?",
    );
    window.confirm = original;
  });

  it("confirmNavigation() returns false when dirty and user cancels", () => {
    const original = window.confirm;
    window.confirm = vi.fn(() => false);
    tracker.markDirty("name");
    expect(tracker.confirmNavigation()).toBe(false);
    expect(window.confirm).toHaveBeenCalled();
    window.confirm = original;
  });

  it("attach() adds beforeunload listener", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    tracker.attach();
    expect(addSpy).toHaveBeenCalledWith(
      "beforeunload",
      expect.any(Function),
    );
    addSpy.mockRestore();
    tracker.detach();
  });

  it("detach() removes beforeunload listener", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    tracker.attach();
    tracker.detach();
    expect(removeSpy).toHaveBeenCalledWith(
      "beforeunload",
      expect.any(Function),
    );
    removeSpy.mockRestore();
  });

  it("beforeunload handler calls preventDefault when dirty", () => {
    tracker.attach();
    tracker.markDirty("name");
    const event = new Event("beforeunload") as BeforeUnloadEvent;
    const preventSpy = vi.spyOn(event, "preventDefault");
    window.dispatchEvent(event);
    expect(preventSpy).toHaveBeenCalled();
    tracker.detach();
  });

  it("beforeunload handler does not call preventDefault when clean", () => {
    tracker.attach();
    const event = new Event("beforeunload") as BeforeUnloadEvent;
    const preventSpy = vi.spyOn(event, "preventDefault");
    window.dispatchEvent(event);
    expect(preventSpy).not.toHaveBeenCalled();
    tracker.detach();
  });

  it("markDirty() without argument uses _default field name", () => {
    tracker.markDirty();
    expect(tracker.dirtyFields()).toEqual(["_default"]);
  });
});
