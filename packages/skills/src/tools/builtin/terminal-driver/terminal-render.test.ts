// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the per-session terminal emulator wrapper (spec §2.4, TR-02).
 *
 * `terminal-render.ts` wraps a REAL `@xterm/headless` Terminal (pure-JS — these
 * tests run green on macOS without a PTY or a forked process). It is the new
 * source of truth for the worker's `read` snapshot: a stable `cols×rows`
 * character grid, the REAL cursor (`buffer.active.cursorX/cursorY`), and the
 * REAL alt-screen flag (`buffer.active.type === "alternate"`).
 *
 * Plan 121-01 (this file): construct + plain grid + real cursor + alt-screen flag
 * + write-flush ordering + resize + safe dispose.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { createSessionEmulator } from "./terminal-render.js";

describe("createSessionEmulator — construct + plain grid (TR-02)", () => {
  it("renders written text into the grid and reports cols/rows/alt", async () => {
    const emu = createSessionEmulator({ cols: 80, rows: 24, scrollback: 1000 });
    await emu.write("hello world");
    const snap = emu.snapshot();

    expect(snap.screen).toContain("hello world");
    expect(snap.cols).toBe(80);
    expect(snap.rows).toBe(24);
    expect(snap.alt).toBe(false);
    emu.dispose();
  });
});

describe("createSessionEmulator — real cursor (replaces the P1 {0,0} placeholder)", () => {
  it("reports the REAL cursorX/cursorY after a write", async () => {
    const emu = createSessionEmulator({ cols: 80, rows: 24, scrollback: 1000 });
    await emu.write("abc");
    const snap = emu.snapshot();

    // The real emulator cursor — NOT the P1 hard-coded {0,0}.
    expect(snap.cursor.x).toBe(3);
    expect(snap.cursor.y).toBe(0);
    emu.dispose();
  });
});

describe("createSessionEmulator — alt-screen flag (TR-02)", () => {
  it("flips alt:true on the alt-screen enter sequence and alt:false on leave", async () => {
    const emu = createSessionEmulator({ cols: 80, rows: 24, scrollback: 1000 });

    // DECSET 1049 — enter the alternate screen buffer (vim/htop), then draw.
    await emu.write("\x1b[?1049h");
    await emu.write("VIM-ALT");
    expect(emu.snapshot().alt).toBe(true);
    expect(emu.snapshot().screen).toContain("VIM-ALT");

    // DECRST 1049 — leave the alternate screen buffer.
    await emu.write("\x1b[?1049l");
    expect(emu.snapshot().alt).toBe(false);
    emu.dispose();
  });
});

describe("createSessionEmulator — write flush ordering (the §2.4 parse-complete primitive)", () => {
  it("write resolves only AFTER the chunk is parsed, so a post-await snapshot reflects it", async () => {
    const emu = createSessionEmulator({ cols: 80, rows: 24, scrollback: 1000 });

    // Clear + home + draw. The await is the parse-complete flush: a non-awaited
    // snapshot could observe the grid BEFORE @xterm finished parsing the chunk.
    await emu.write("\x1b[2J\x1b[Hdone");
    expect(emu.snapshot().screen).toContain("done");
    emu.dispose();
  });
});

describe("createSessionEmulator — resize", () => {
  it("resizes the grid geometry", async () => {
    const emu = createSessionEmulator({ cols: 80, rows: 24, scrollback: 1000 });
    emu.resize(100, 30);
    const snap = emu.snapshot();

    expect(snap.cols).toBe(100);
    expect(snap.rows).toBe(30);
    emu.dispose();
  });
});

describe("createSessionEmulator — dispose is safe + idempotent", () => {
  it("dispose() does not throw and a second dispose() is a no-op", () => {
    const emu = createSessionEmulator({ cols: 80, rows: 24, scrollback: 1000 });
    expect(() => emu.dispose()).not.toThrow();
    expect(() => emu.dispose()).not.toThrow();
  });
});
