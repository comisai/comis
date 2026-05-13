// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `createConsoleLogger()` — Pino-free structured logger.
 *
 * WEB-CONTRACTS-04. Covers:
 *   - one JSON line per call with level + msg
 *   - object-arg merging into the line
 *   - child() merges bindings (shallow)
 *   - .level get/set works
 *
 * Each test spies on `process.stderr.write` to capture the emitted line and
 * `JSON.parse`s it to assert the structured payload.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createConsoleLogger } from "./console-logger.js";

describe("createConsoleLogger (WEB-CONTRACTS-04)", () => {
  let writes: string[];
  let restore: () => void;

  beforeEach(() => {
    writes = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(String(chunk));
        return true;
      });
    restore = (): void => spy.mockRestore();
  });

  afterEach(() => restore());

  it("writes one JSON line per call with level + msg", () => {
    const log = createConsoleLogger();
    log.info("hello");
    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]!.trim());
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hello");
    expect(typeof parsed.time).toBe("number");
  });

  it("merges object-arg into the JSON line", () => {
    const log = createConsoleLogger();
    log.info({ userId: "u1" }, "ping");
    const parsed = JSON.parse(writes[0]!.trim());
    expect(parsed.userId).toBe("u1");
    expect(parsed.msg).toBe("ping");
  });

  it("child() merges bindings", () => {
    const log = createConsoleLogger("info", { module: "test" });
    const child = log.child({ submodule: "sub" });
    child.warn("hi");
    const parsed = JSON.parse(writes[0]!.trim());
    expect(parsed.module).toBe("test");
    expect(parsed.submodule).toBe("sub");
    expect(parsed.level).toBe("warn");
  });

  it(".level is settable", () => {
    const log = createConsoleLogger("info");
    expect(log.level).toBe("info");
    log.level = "debug";
    expect(log.level).toBe("debug");
  });
});
