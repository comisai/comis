// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import type { HookRunner } from "./hook-runner.js";
import {
  setGlobalHookRunner,
  getGlobalHookRunner,
  clearGlobalHookRunner,
} from "./hook-runner-global.js";

describe("hook-runner-global", () => {
  afterEach(() => {
    clearGlobalHookRunner();
  });

  it("returns null before any runner is set", () => {
    expect(getGlobalHookRunner()).toBeNull();
  });

  it("returns the runner after setGlobalHookRunner", () => {
    const runner = {} as HookRunner;
    setGlobalHookRunner(runner);
    expect(getGlobalHookRunner()).toBe(runner);
  });

  it("returns null after clearGlobalHookRunner", () => {
    const runner = {} as HookRunner;
    setGlobalHookRunner(runner);
    clearGlobalHookRunner();
    expect(getGlobalHookRunner()).toBeNull();
  });

  it("replaces the previous runner when set again", () => {
    const first = {} as HookRunner;
    const second = {} as HookRunner;
    setGlobalHookRunner(first);
    setGlobalHookRunner(second);
    expect(getGlobalHookRunner()).toBe(second);
    expect(getGlobalHookRunner()).not.toBe(first);
  });
});
