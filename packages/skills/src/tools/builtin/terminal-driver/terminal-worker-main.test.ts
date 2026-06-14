// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the standalone worker process entry's PURE helpers. The module's
 * `main()` is guarded by `isEntryScript()`, so importing it here runs no side
 * effects (no fork, no stdin listeners) — we exercise the config/wiring helpers
 * the forked process uses.
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  parseStuckMs,
  durableDir,
  buildLoadTmux,
  createFileLogger,
} from "./terminal-worker-main.js";

const origData = process.env.COMIS_TERMINAL_DATA_DIR;
const origStuck = process.env.COMIS_TERMINAL_STUCK_MS;

describe("terminal-worker-main helpers", () => {
  afterEach(() => {
    if (origData === undefined) delete process.env.COMIS_TERMINAL_DATA_DIR;
    else process.env.COMIS_TERMINAL_DATA_DIR = origData;
    if (origStuck === undefined) delete process.env.COMIS_TERMINAL_STUCK_MS;
    else process.env.COMIS_TERMINAL_STUCK_MS = origStuck;
  });

  it("parseStuckMs reads COMIS_TERMINAL_STUCK_MS; absent/invalid/non-positive → undefined", () => {
    delete process.env.COMIS_TERMINAL_STUCK_MS;
    expect(parseStuckMs()).toBeUndefined();
    process.env.COMIS_TERMINAL_STUCK_MS = "45000";
    expect(parseStuckMs()).toBe(45000);
    process.env.COMIS_TERMINAL_STUCK_MS = "-5";
    expect(parseStuckMs()).toBeUndefined();
    process.env.COMIS_TERMINAL_STUCK_MS = "notanumber";
    expect(parseStuckMs()).toBeUndefined();
  });

  it("durableDir = <COMIS_TERMINAL_DATA_DIR>/terminal-worker (matches the --allow-fs-write scope)", () => {
    process.env.COMIS_TERMINAL_DATA_DIR = "/data/x";
    expect(durableDir()).toBe(resolve("/data/x", "terminal-worker"));
  });

  it("createFileLogger appends JSONL with level+msg and is best-effort (never throws on a bad path)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "twm-test-"));
    const logPath = resolve(dir, "worker.log");
    const logger = createFileLogger(logPath);
    logger.info({ pid: 7 }, "started");
    logger.warn({ x: 1 }, "warned");
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0])).toMatchObject({ level: "info", msg: "started", pid: 7 });
    expect(JSON.parse(lines[1])).toMatchObject({ level: "warn", msg: "warned", x: 1 });
    // A write to a non-existent dir must NOT throw out of the worker.
    const bad = createFileLogger("/nonexistent-dir-twm-xyz/worker.log");
    expect(() => bad.error({}, "boom")).not.toThrow();
  });

  it("buildLoadTmux returns a TmuxBackendLike with a spawn() factory (wiring into createTmuxBackend)", () => {
    const loadTmux = buildLoadTmux("/usr/bin/tmux");
    expect(typeof loadTmux.spawn).toBe("function");
    // Not invoked here: spawn() would run tmux has-session / new-session (a real
    // server). The construction + shape is what's under test.
  });
});
