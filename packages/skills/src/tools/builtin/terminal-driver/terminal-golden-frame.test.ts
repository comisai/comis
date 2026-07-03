// SPDX-License-Identifier: Apache-2.0
/**
 * Golden-frame tests for the terminal rendering.
 *
 * The "experimental addon-serialize churn" guard: `@xterm/addon-serialize` is
 * pinned (0.14.0) but flagged experimental, so a future bump could silently change
 * the serialization. This test REPLAYS each committed byte-stream fixture through a
 * fresh `createSessionEmulator` and asserts `snapshot({format:'ansi'}).screen`
 * EQUALS a committed golden — a serialization change (or a tampered fixture)
 * surfaces LOUDLY as a `serialize() !== golden` failure, never silently.
 *
 * The replay is platform-independent: `@xterm/headless` is pure-JS, so the SAME
 * bytes produce the SAME serialization on macOS and Linux. That is exactly why the
 * replay runs here on macOS even for the VPS-recorded `vim` stream — the bytes are
 * captured on a real PTY (the VPS), but the golden assertion is host-independent.
 *
 * Fixtures (see `fixtures/README.md`):
 *   - `spinner.stream.txt`   — a synthetic CR-redraw spinner (macOS-authored).
 *   - `altscreen.stream.txt` — a synthetic alt-screen banner (macOS-authored).
 *   - `vim.stream.txt`       — a real `vim` session recorded on the VPS.
 *     The vim case is GATED on the fixture existing (`it.skipIf(!existsSync(...))`)
 *     so this suite is green on macOS BEFORE the VPS records it; once the fixture
 *     is committed the case executes (no longer skipped).
 *
 * Goldens are regenerated ONLY via the documented command in `fixtures/README.md`
 * (an intentional, reviewed act on a deliberate addon-serialize bump) — never
 * silently. A regeneration re-commits each `<name>.golden.txt` alongside the
 * stream so the diff is reviewable.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createSessionEmulator, type EmulatorSnapshot } from "./terminal-render.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

/** The committed vim fixture (recorded on the VPS; absent ⇒ skip). */
const VIM_STREAM = join(FIXTURES, "vim.stream.txt");

/**
 * Replay a committed byte-stream fixture through a FRESH emulator (the same
 * geometry the worker uses) and return its snapshot. Reads the RAW bytes (latin1
 * so the escape bytes round-trip exactly — the fixtures hold control sequences,
 * not UTF-8 text). The grid is `80×24` to match the canonical session geometry.
 */
async function replayFixture(streamName: string): Promise<EmulatorSnapshot> {
  const bytes = readFileSync(join(FIXTURES, streamName), "latin1");
  const emu = createSessionEmulator({ cols: 80, rows: 24, scrollback: 1000 });
  await emu.write(bytes);
  const snap = emu.snapshot({ format: "ansi" });
  emu.dispose();
  return snap;
}

/** Read a committed golden (`serialize({format:'ansi'})` output) verbatim. */
function readGolden(goldenName: string): string {
  return readFileSync(join(FIXTURES, goldenName), "latin1");
}

describe("golden-frame — synthetic spinner stream (the serialize-churn guard)", () => {
  it("replays spinner.stream.txt and serialize() === the committed golden", async () => {
    const snap = await replayFixture("spinner.stream.txt");

    // The churn guard: the ansi serialization is byte-for-byte the committed golden.
    expect(snap.screen).toBe(readGolden("spinner.golden.txt"));
    // The spinner's FINAL `\r`-redrawn frame is what renders (each \r overwrites
    // the prior glyph in place) — the settled line, not a mid-spin glyph.
    expect(snap.screen).toContain("Working done");
    // A CR-spinner is a normal-buffer animation, never the alternate screen.
    expect(snap.alt).toBe(false);
  });
});

describe("golden-frame — synthetic alt-screen stream", () => {
  it("replays altscreen.stream.txt, stays in alt, and serialize() === the golden", async () => {
    const snap = await replayFixture("altscreen.stream.txt");

    // The stream enters the alternate buffer and never leaves — alt at capture end.
    expect(snap.alt).toBe(true);
    // The drawn banner is in the rendered grid.
    expect(snap.screen).toContain("EDITOR");
    // The churn guard: the full ansi serialization equals the committed golden.
    expect(snap.screen).toBe(readGolden("altscreen.golden.txt"));
  });
});

describe("golden-frame — recorded vim stream (VPS-recorded; skips until the fixture lands)", () => {
  // GATED: `vim.stream.txt` is recorded on the VPS. Until it is
  // committed this case SKIPS so the suite is green on macOS; once present it runs
  // (the replay is host-independent — pure-JS @xterm gives the identical golden).
  it.skipIf(!existsSync(VIM_STREAM))(
    "replays vim.stream.txt, is in alt, and serialize() === the committed vim golden",
    async () => {
      const snap = await replayFixture("vim.stream.txt");

      // A real vim session is a full-screen alt-buffer TUI.
      expect(snap.alt).toBe(true);
      // The churn guard over the REAL recorded stream: serialize() === the golden.
      expect(snap.screen).toBe(readGolden("vim.golden.txt"));
    },
  );
});
