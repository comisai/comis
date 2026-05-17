// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for installCompactionTrigger — wires the compaction:flush
 * event bus subscription.
 *
 * Closure-extracted helper (state-first): the empty state shape is by
 * design (the handler reads from deps only); these tests assert the
 * subscription is registered.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { installCompactionTrigger } from "./compaction-trigger.js";
import type { PiExecutorDeps } from "./pi-executor.js";

describe("installCompactionTrigger", () => {
  it("subscribes to the compaction:flush event", () => {
    const handlers: Record<string, ((event: unknown) => void)[]> = {};
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      trace: () => {},
      child: () => logger,
    };
    const deps = {
      eventBus: {
        on: (eventName: string, handler: (event: unknown) => void) => {
          (handlers[eventName] ??= []).push(handler);
        },
        emit: () => {},
        off: () => {},
      } as unknown as PiExecutorDeps["eventBus"],
      logger: logger as unknown as PiExecutorDeps["logger"],
    } as PiExecutorDeps;

    installCompactionTrigger({}, deps);

    expect(handlers["compaction:flush"]).toBeDefined();
    expect(handlers["compaction:flush"]!.length).toBe(1);
  });

  it("state parameter is named `state`", () => {
    // Structural assertion: the function signature has `state` as first param.
    // The actual structural test is in __tests__/architecture.test.ts; here
    // we cross-check the function is callable with the empty state shape.
    const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, trace: () => {}, child: () => noopLogger };
    const deps = {
      eventBus: { on: () => {}, emit: () => {}, off: () => {} },
      logger: noopLogger,
    } as unknown as PiExecutorDeps;
    expect(() => installCompactionTrigger({}, deps)).not.toThrow();
  });
});
