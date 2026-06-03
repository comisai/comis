#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The golden-frame fixture-recording helper (§11).
//
// Two modes:
//
//   1. --synthetic  — write a built-in literal byte string to --out WITHOUT a
//      PTY. Reproducibly authors the macOS-side synthetic fixtures (the spinner
//      + the alt-screen stream) so they are regenerable from THIS script, never
//      hand-typed raw escapes that drift. Runs anywhere (no node-pty).
//
//   2. (default)    — spawn a real command through node-pty, pipe its raw output
//      bytes to --out for a bounded --duration, optionally feeding scripted
//      --keys, then exit. This is the REAL-PTY recording the orchestrator runs on
//      the VPS `comisvps` to capture `fixtures/vim.stream.txt` (macOS node-pty
//      cannot posix_spawnp in-harness). node-pty is loaded
//      via `createRequire` (the SAME guarded lazy-load the worker uses), so this
//      script imports it only in PTY mode and never at module top-level.
//
// It lives under `scripts/` (NOT `src/`), so it is outside the file-size / globals
// / infra-runtime architecture gates — but it is kept small + documented. It has
// NO `@comis/infra` dependency and no project imports: a standalone Node tool.
//
// Usage:
//   Synthetic (no PTY — authors a committed fixture):
//     node record-fixture.mjs --synthetic spinner   --out ../fixtures/spinner.stream.txt
//     node record-fixture.mjs --synthetic altscreen --out ../fixtures/altscreen.stream.txt
//
//   Real PTY (VPS — records a live TUI byte stream):
//     node record-fixture.mjs vim --args "-u NONE -N" \
//          --keys ":set nonumber\riHELLO\x1b:q!\r" --duration 2000 \
//          --out ../fixtures/vim.stream.txt
//
//   Generate a golden from an already-recorded stream (replay → serialize):
//     node record-fixture.mjs --golden --in ../fixtures/vim.stream.txt \
//          --out ../fixtures/vim.golden.txt
//
// The --golden mode replays a recorded stream through the SAME emulator the test
// drives and writes the committed `serialize({format:'ansi'})` golden. @xterm is
// pure-JS, so the golden a VPS-recorded stream produces is identical on macOS —
// which is exactly why the replay test runs on macOS.

import { createRequire } from "node:module";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, isAbsolute } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Tiny flag parser — positional command + --flag value pairs. No deps.
// ---------------------------------------------------------------------------

/** Parse `argv` into `{ _: [...positionals], flags: {name: value|true} }`. */
function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out.flags[name] = true;
      } else {
        out.flags[name] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** Resolve a path arg relative to THIS script dir (so `../fixtures/x` works). */
function resolveOut(p) {
  return isAbsolute(p) ? p : resolve(HERE, p);
}

/**
 * Decode a CLI-supplied keys/args string's escape shorthands into real bytes:
 * `\r`, `\n`, `\t`, `\x1b` (and `\\`). Lets the caller pass a scripted edit like
 * `":set nonumber\riHELLO\x1b:q!\r"` on a single shell-quoted argument.
 */
function decodeEscapes(s) {
  return s.replace(/\\x([0-9a-fA-F]{2})|\\(.)/g, (_m, hex, ch) => {
    if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
    if (ch === "r") return "\r";
    if (ch === "n") return "\n";
    if (ch === "t") return "\t";
    if (ch === "\\") return "\\";
    return ch;
  });
}

// ---------------------------------------------------------------------------
// The built-in synthetic fixtures (the macOS-authorable byte streams).
//
// These are LITERAL byte strings — no PTY, no host content, fully deterministic
// + human-reviewable in the commit diff. Each is the exact
// stream the golden-frame test replays.
// ---------------------------------------------------------------------------

const ESC = "\x1b";

/**
 * A classic CLI spinner: a label, then several `\r`-redrawn glyph frames over the
 * SAME line (`| / - \`). Only printable + `\r` bytes — the canonical
 * carriage-return-overwrite animation. The FINAL frame (the last `\r`-drawn
 * glyph + " done") is what renders, since each `\r` returns to column 0 and the
 * next frame overwrites the previous in place.
 */
function syntheticSpinner() {
  const label = "Working ";
  const frames = ["|", "/", "-", "\\", "|", "/", "-", "\\"];
  let s = label;
  for (const f of frames) {
    s += `\r${label}${f}`;
  }
  // The terminal frame: settle on a completed line (overwrites the spinner glyph).
  s += `\r${label}done`;
  return s;
}

/**
 * A synthetic alt-screen stream: enter the alternate buffer (DECSET 1049), clear
 * + home, draw a boxed "EDITOR" banner with explicit cursor moves, and STAY in
 * alt (no leave) so `snapshot().alt === true` at capture end — exactly what a
 * full-screen TUI (vim/htop) holds. Uses only CSI cursor-position + the alt-enter
 * escape, all literal + reviewable.
 */
function syntheticAltScreen() {
  const cup = (row, col) => `${ESC}[${row};${col}H`; // 1-based cursor position
  let s = "";
  s += `${ESC}[?1049h`; // enter alternate screen buffer
  s += `${ESC}[2J`; // clear the alt screen
  s += cup(1, 1); // home
  // Draw a small box with an "EDITOR" banner inside.
  s += cup(2, 3) + "+----------------+";
  s += cup(3, 3) + "|     EDITOR     |";
  s += cup(4, 3) + "|  alt-screen ok |";
  s += cup(5, 3) + "+----------------+";
  s += cup(7, 1) + "~"; // a vim-style empty-line tilde
  s += cup(8, 1) + "~";
  // NOTE: deliberately NO `\x1b[?1049l` — the stream STAYS in alt at capture end.
  return s;
}

const SYNTHETIC = {
  spinner: syntheticSpinner,
  altscreen: syntheticAltScreen,
};

// ---------------------------------------------------------------------------
// Golden generation — replay a recorded stream through the emulator + serialize.
// ---------------------------------------------------------------------------

/**
 * Replay `streamBytes` through the project emulator and return the committed
 * `serialize({format:'ansi'})` golden. Imports `terminal-render.js` from the
 * BUILT `dist/` (the script runs after `pnpm build`); falls back to the source
 * via tsx-less dynamic import is NOT attempted — the orchestrator builds first.
 */
async function generateGolden(streamBytes) {
  // Resolve the emulator from the built dist (a sibling of this src tree). The
  // script is committed under src/.../scripts; dist mirrors src/.../terminal-render.js.
  const distModule = resolve(
    HERE,
    "../../../../../dist/tools/builtin/terminal-driver/terminal-render.js",
  );
  const { createSessionEmulator } = await import(pathToFileURL(distModule).href);
  const emu = createSessionEmulator({ cols: 80, rows: 24, scrollback: 1000 });
  await emu.write(streamBytes);
  const golden = emu.snapshot({ format: "ansi" }).screen;
  emu.dispose();
  return golden;
}

// ---------------------------------------------------------------------------
// Real-PTY recording (VPS only) — node-pty via createRequire (the worker idiom).
// ---------------------------------------------------------------------------

/**
 * Spawn `bin argv...` through node-pty, capture raw output for `durationMs`,
 * optionally feed `keys` after a short warm-up, then kill + resolve the captured
 * bytes. node-pty is lazy-loaded HERE (never at module top-level), the same
 * guarded `createRequire` the worker uses — so --synthetic / --golden run with no
 * node-pty present.
 */
function recordPty({ bin, argv, keys, durationMs }) {
  const localRequire = createRequire(import.meta.url);
  const pty = localRequire("node-pty");
  return new Promise((resolvePromise) => {
    const term = pty.spawn(bin, argv, {
      cols: 80,
      rows: 24,
      env: process.env,
    });
    let buf = "";
    term.onData((d) => {
      buf += d;
    });
    // Feed the scripted keys after a brief warm-up so the TUI has drawn first.
    if (keys) {
      setTimeout(() => term.write(keys), 400);
    }
    setTimeout(() => {
      try {
        term.kill();
      } catch {
        /* already exited */
      }
      resolvePromise(buf);
    }, durationMs);
  });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));

  // --golden: replay an existing --in stream → write the --out golden. Reads the
  // stream + writes the golden as `latin1` — the SAME encoding the golden-frame
  // test uses (`readFileSync(..., "latin1")`), so the generated golden is
  // byte-identical to what the test asserts (control bytes round-trip exactly).
  if (flags.golden) {
    const inPath = resolveOut(String(flags.in));
    const outPath = resolveOut(String(flags.out));
    const stream = readFileSync(inPath, "latin1");
    const golden = await generateGolden(stream);
    writeFileSync(outPath, golden, "latin1");
    process.stderr.write(`golden ${outPath} (${golden.length} bytes) from ${inPath}\n`);
    return;
  }

  // --synthetic <name>: write a built-in literal byte stream to --out.
  if (flags.synthetic !== undefined) {
    const name = typeof flags.synthetic === "string" ? flags.synthetic : _[0];
    const make = SYNTHETIC[name];
    if (!make) {
      throw new Error(`unknown synthetic fixture: ${name} (have: ${Object.keys(SYNTHETIC).join(", ")})`);
    }
    const outPath = resolveOut(String(flags.out));
    const bytes = make();
    writeFileSync(outPath, bytes);
    process.stderr.write(`synthetic ${name} → ${outPath} (${bytes.length} bytes)\n`);
    return;
  }

  // Default: real-PTY recording (VPS). Positional command + --args/--keys/--duration.
  const bin = _[0];
  if (!bin) {
    throw new Error(
      "usage: record-fixture.mjs <command> --out <file> [--args \"...\"] [--keys \"...\"] [--duration ms] | --synthetic <name> --out <file> | --golden --in <stream> --out <golden>",
    );
  }
  const argv = flags.args ? decodeEscapes(String(flags.args)).split(/\s+/).filter(Boolean) : [];
  const keys = flags.keys ? decodeEscapes(String(flags.keys)) : undefined;
  const durationMs = flags.duration ? Number(flags.duration) : 2000;
  const outPath = resolveOut(String(flags.out));

  const bytes = await recordPty({ bin, argv, keys, durationMs });
  writeFileSync(outPath, bytes);
  process.stderr.write(`recorded ${bin} → ${outPath} (${bytes.length} bytes, ${durationMs}ms)\n`);
}

main().catch((err) => {
  process.stderr.write(`record-fixture failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
