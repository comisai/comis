// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the per-session terminal emulator wrapper (spec §2.4).
 *
 * `terminal-render.ts` wraps a REAL `@xterm/headless` Terminal (pure-JS — these
 * tests run green on macOS without a PTY or a forked process). It is the new
 * source of truth for the worker's `read` snapshot: a stable `cols×rows`
 * character grid, the REAL cursor (`buffer.active.cursorX/cursorY`), and the
 * REAL alt-screen flag (`buffer.active.type === "alternate"`).
 *
 * This file covers: construct + plain grid + real cursor + alt-screen flag
 * + write-flush ordering + resize + safe dispose.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { createSessionEmulator, diffSnapshot, type EmulatorSnapshot } from "./terminal-render.js";
import { claudeCodeProfile } from "./platforms/claude-code/profile.js";

describe("createSessionEmulator — construct + plain grid", () => {
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

describe("createSessionEmulator — real cursor (replaces the earlier {0,0} placeholder)", () => {
  it("reports the REAL cursorX/cursorY after a write", async () => {
    const emu = createSessionEmulator({ cols: 80, rows: 24, scrollback: 1000 });
    await emu.write("abc");
    const snap = emu.snapshot();

    // The real emulator cursor — NOT the earlier hard-coded {0,0}.
    expect(snap.cursor.x).toBe(3);
    expect(snap.cursor.y).toBe(0);
    emu.dispose();
  });
});

describe("createSessionEmulator — alt-screen flag", () => {
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

// ===========================================================================
// Render formats (text | ansi | html) via @xterm/addon-serialize
// + the scrollback:N off-screen perception.
// ===========================================================================

describe("createSessionEmulator — render formats", () => {
  it("format:'text' (the default) returns the plain grid with NO SGR escapes", async () => {
    const emu = createSessionEmulator({ cols: 80, rows: 24, scrollback: 1000 });
    await emu.write("\x1b[31mRED\x1b[0m"); // red text — the SGR must NOT survive in text

    const defaultScreen = emu.snapshot().screen;
    const textScreen = emu.snapshot({ format: "text" }).screen;

    expect(defaultScreen).not.toContain("\x1b[");
    expect(textScreen).not.toContain("\x1b[");
    expect(textScreen).toContain("RED"); // the visible text remains
    emu.dispose();
  });

  it("format:'ansi' preserves SGR (calls serializeAddon.serialize())", async () => {
    const emu = createSessionEmulator({ cols: 80, rows: 24, scrollback: 1000 });
    await emu.write("\x1b[31mRED\x1b[0m");

    const ansi = emu.snapshot({ format: "ansi" }).screen;

    // The ANSI serialization re-emits an SGR escape AND the text.
    expect(ansi).toContain("\x1b[");
    expect(ansi).toContain("RED");
    emu.dispose();
  });

  it("format:'html' returns an HTML-shaped fragment (calls serializeAsHTML())", async () => {
    const emu = createSessionEmulator({ cols: 80, rows: 24, scrollback: 1000 });
    await emu.write("hi");

    const html = emu.snapshot({ format: "html" }).screen;

    // HTML-shaped + non-empty + carries the text (an exact golden is deferred).
    expect(html).toContain("<");
    expect(html).toContain("hi");
    expect(html.length).toBeGreaterThan(0);
    emu.dispose();
  });
});

describe("createSessionEmulator — scrollback perception beyond the viewport", () => {
  // Zero-padded labels (LINE-01..LINE-12) so "LINE-01" is NEVER a substring of
  // "LINE-10"/"LINE-11"/"LINE-12" — the off-screen assertions are unambiguous.
  function label(i: number): string {
    return `LINE-${String(i).padStart(2, "0")}`;
  }

  it("scrollback:N (text) returns off-screen lines that the viewport-only snapshot omits", async () => {
    const emu = createSessionEmulator({ cols: 80, rows: 5, scrollback: 1000 });
    // 12 CRLF-separated lines on a 5-row viewport — 7 lines scroll above the fold.
    for (let i = 1; i <= 12; i++) await emu.write(`${label(i)}\r\n`);

    const viewportOnly = emu.snapshot().screen; // default scrollback:0
    const withScrollback = emu.snapshot({ scrollback: 10 }).screen;

    // The viewport only shows the bottom lines — LINE-01 has scrolled off.
    expect(viewportOnly).not.toContain(label(1));
    // With scrollback, the early off-screen line is perceivable.
    expect(withScrollback).toContain(label(1));
    emu.dispose();
  });

  it("scrollback:N (ansi) calls serialize({scrollback:N}) and includes an off-screen line", async () => {
    const emu = createSessionEmulator({ cols: 80, rows: 5, scrollback: 1000 });
    for (let i = 1; i <= 12; i++) await emu.write(`${label(i)}\r\n`);

    const ansiScroll = emu.snapshot({ format: "ansi", scrollback: 10 }).screen;

    expect(ansiScroll).toContain(label(1)); // off-screen line in the ansi serialization
    emu.dispose();
  });

  it("scrollback:0 (the default) returns only the visible viewport rows", async () => {
    const emu = createSessionEmulator({ cols: 80, rows: 5, scrollback: 1000 });
    for (let i = 1; i <= 12; i++) await emu.write(`${label(i)}\r\n`);

    const viewportOnly = emu.snapshot({ scrollback: 0 }).screen;

    expect(viewportOnly).not.toContain(label(1));
    // The latest lines ARE visible (the bottom of the buffer).
    expect(viewportOnly).toContain(label(12));
    emu.dispose();
  });
});

// ===========================================================================
// hasContentBelowFold() (the "more content below the fold ⇒ NOT
// settled" rendering signal) + diffSnapshot() (the per-read screen-diff).
// ===========================================================================

describe("createSessionEmulator — hasContentBelowFold", () => {
  it("returns true when the viewport is scrolled UP so content sits below the fold", async () => {
    const emu = createSessionEmulator({ cols: 80, rows: 5, scrollback: 1000 });
    // 10 CRLF lines auto-scroll the viewport to the bottom; then scroll UP so
    // content is now BELOW the displayed viewport.
    for (let i = 1; i <= 10; i++) await emu.write(`L${i}\r\n`);
    emu.term.scrollToLine(0); // display the top — content is below the fold now

    expect(emu.hasContentBelowFold()).toBe(true);
    emu.dispose();
  });

  it("returns false at the bottom (nothing below the viewport)", async () => {
    const emu = createSessionEmulator({ cols: 80, rows: 5, scrollback: 1000 });
    for (let i = 1; i <= 10; i++) await emu.write(`L${i}\r\n`);
    // Viewport auto-scrolled to the bottom after writing — nothing below.
    expect(emu.hasContentBelowFold()).toBe(false);
    emu.dispose();
  });

  it("returns false for a short output that fits the viewport (no scroll)", async () => {
    const emu = createSessionEmulator({ cols: 80, rows: 5, scrollback: 1000 });
    await emu.write("one\r\ntwo\r\n"); // 2 lines, fits the 5-row viewport
    expect(emu.hasContentBelowFold()).toBe(false);
    emu.dispose();
  });

  it("returns false on the alternate buffer (alt apps own the full screen, no scrollback below)", async () => {
    const emu = createSessionEmulator({ cols: 80, rows: 5, scrollback: 1000 });
    await emu.write("\x1b[?1049h"); // enter alt
    await emu.write("ALT-DRAW");
    expect(emu.hasContentBelowFold()).toBe(false);
    emu.dispose();
  });
});

describe("createSessionEmulator — diffSnapshot (the per-read screen-diff)", () => {
  it("changed:true when a write alters a row, with the changed-row range covering it", async () => {
    const emu = createSessionEmulator({ cols: 80, rows: 24, scrollback: 1000 });
    const a = emu.snapshot();
    await emu.write("NEW");
    const b = emu.snapshot();

    const diff = diffSnapshot(a, b);
    expect(diff.changed).toBe(true);
    // "NEW" landed on row 0 (the home row) — the changed range includes it.
    expect(diff.firstChangedRow).toBeLessThanOrEqual(0);
    expect(diff.lastChangedRow).toBeGreaterThanOrEqual(0);
    emu.dispose();
  });

  it("changed:false when nothing changed between two snapshots", async () => {
    const emu = createSessionEmulator({ cols: 80, rows: 24, scrollback: 1000 });
    await emu.write("stable");
    const a = emu.snapshot();
    const b = emu.snapshot(); // no write between
    const diff = diffSnapshot(a, b);

    expect(diff.changed).toBe(false);
    expect(diff.firstChangedRow).toBe(-1);
    expect(diff.lastChangedRow).toBe(-1);
    emu.dispose();
  });

  it("prev===undefined ⇒ changed:true (the first read), full range", async () => {
    const emu = createSessionEmulator({ cols: 80, rows: 24, scrollback: 1000 });
    await emu.write("first");
    const b = emu.snapshot();
    const diff = diffSnapshot(undefined, b);

    expect(diff.changed).toBe(true);
    expect(diff.firstChangedRow).toBe(0);
    emu.dispose();
  });
});

// ===========================================================================
// FINDING-3 / RENDER-01 (v2.26): the dim-autocomplete ghost-strip is a Claude
// SPECIAL-CASE and now lives in the `claude-code` PROFILE (`transformSnapshot`),
// NOT the agnostic engine. The engine here proves two things: (1) with NO profile
// the render is the plain `translateToString` grid — the dim ghost is kept (INV-1,
// byte-identical to today's generic path); (2) `transformSnapshot` is a GENERIC
// injected hook the engine applies to text reads, feeding it the viewport cell
// grid (so a profile can read the `dim` attribute the flat `screen` lost). The
// ghost-strip ITSELF is golden-tested in `platforms/claude-code/profile.test.ts`.
// ===========================================================================

describe("createSessionEmulator — agnostic render is the plain grid (no platform strip, INV-1)", () => {
  it("keeps the dim composer ghost verbatim when no profile transform is wired", async () => {
    // No transform ⇒ the engine is byte-identical to translateToString: the dim ghost is NOT stripped.
    const emu = createSessionEmulator({ cols: 80, rows: 6, scrollback: 0 });
    await emu.write("\x1b[2;1H❯ \x1b[2mcommit this\x1b[0m");
    await emu.write("\x1b[2;3H");
    const snap = emu.snapshot({ format: "text" });
    expect(snap.screen).toContain("commit this"); // agnostic engine carries no platform strip
    expect(snap.grid).toBeUndefined(); // no transform ⇒ no cell grid built (zero added cost)
    emu.dispose();
  });
});

describe("createSessionEmulator — transformSnapshot is a generic read-side hook", () => {
  it("applies an injected transform to text reads and feeds it the viewport cell grid", async () => {
    let received: EmulatorSnapshot | undefined;
    const emu = createSessionEmulator({
      cols: 20,
      rows: 3,
      scrollback: 0,
      transformSnapshot: (snap) => {
        received = snap;
        return { ...snap, screen: "TRANSFORMED" };
      },
    });
    await emu.write("hello");
    const snap = emu.snapshot({ format: "text" });
    expect(snap.screen).toBe("TRANSFORMED"); // the transform's output is what the emulator returns
    expect(received?.grid).toBeDefined(); // the engine attached the viewport cell grid for the hook
    expect(received?.grid?.length).toBe(3); // one cell-row per viewport row
    expect(received?.grid?.[0]?.some((c) => c.chars === "h")).toBe(true); // cells carry the real chars
    emu.dispose();
  });

  it("does not build the grid for ansi format, so a transform no-ops on non-text reads", async () => {
    let received: EmulatorSnapshot | undefined;
    const emu = createSessionEmulator({
      cols: 20,
      rows: 3,
      scrollback: 0,
      transformSnapshot: (snap) => {
        received = snap;
        return snap;
      },
    });
    await emu.write("hi");
    emu.snapshot({ format: "ansi" });
    expect(received?.grid).toBeUndefined(); // ansi screen is not a plain row grid ⇒ no grid attached
    emu.dispose();
  });
});

describe("createSessionEmulator + claudeCodeProfile.transformSnapshot — FINDING-3 end-to-end (design §8)", () => {
  it("strips the dim composer ghost on the cursor row when the claude-code profile is selected", async () => {
    const emu = createSessionEmulator({
      cols: 80,
      rows: 6,
      scrollback: 0,
      transformSnapshot: claudeCodeProfile.transformSnapshot,
    });
    await emu.write("\x1b[2;1H❯ \x1b[2mcommit this\x1b[0m"); // composer + dim ghost
    await emu.write("\x1b[5;1H\x1b[2mSonnet 4.6\x1b[0m"); // dim status bar on another row
    await emu.write("\x1b[2;3H"); // cursor to the input position (cursorX=2, cursorY=1)
    const snap = emu.snapshot({ format: "text" });
    expect(snap.screen).not.toContain("commit this"); // ghost stripped via the profile transform
    expect(snap.screen).toContain("❯"); // the prompt survives
    expect(snap.screen).toContain("Sonnet 4.6"); // dim chrome on another row untouched
    emu.dispose();
  });

  it("also strips in the alt buffer via the profile (tmux-attach sessions render alt-screen)", async () => {
    const emu = createSessionEmulator({
      cols: 80,
      rows: 6,
      scrollback: 0,
      transformSnapshot: claudeCodeProfile.transformSnapshot,
    });
    await emu.write("\x1b[?1049h"); // enter alt screen (as `tmux attach` does)
    await emu.write("\x1b[2;1H❯ \x1b[2mcommit this\x1b[0m");
    await emu.write("\x1b[5;1H\x1b[2mSonnet 4.6\x1b[0m");
    await emu.write("\x1b[2;3H");
    const snap = emu.snapshot({ format: "text" });
    expect(snap.alt).toBe(true);
    expect(snap.screen).not.toContain("commit this"); // ghost stripped EVEN in alt
    expect(snap.screen).toContain("❯");
    expect(snap.screen).toContain("Sonnet 4.6");
    emu.dispose();
  });
});
