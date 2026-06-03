// SPDX-License-Identifier: Apache-2.0
/**
 * The per-session terminal-emulator wrapper (spec §2.4 rendering, TR-02).
 *
 * Wraps a REAL `@xterm/headless` `Terminal` into a small pluggable surface the
 * worker stores per session. This is the new source of truth for the `read`
 * snapshot: a stable `cols×rows` character grid, the REAL cursor
 * (`buffer.active.cursorX/cursorY`), and the REAL alt-screen flag
 * (`buffer.active.type === "alternate"`) — REPLACING the P0/P1 raw stdout-ring
 * snapshot. Full-screen TUIs (`vim`/`htop`) draw into a stable grid; the agent
 * must perceive that grid, not a raw byte log.
 *
 * The emulator is extracted into this module (not inlined in the worker) so the
 * worker stays under the 800-line architecture cap — the heavy @xterm
 * integration lives here.
 *
 * §2.4 flush primitive: `@xterm`'s `term.write(data, cb)` is ASYNC-PARSED — the
 * callback fires once the chunk is fully parsed into the buffer. `write` here
 * returns a Promise that resolves on that callback, so the worker can `await`
 * the parse before serializing a SETTLED frame (the "debounce → serialize once
 * stable" discipline — a snapshot taken before the parse completes would lag the
 * bytes). The settle's idle debounce already waits for quiet; awaiting the
 * write-flush guarantees the grid reflects every emitted byte.
 *
 * Architecture invariants: NO module-global mutable state (everything is local to
 * the returned object); NO `@comis/infra` import; NO raw timers / clock / env
 * (the globals gate). A pure, injectable wrapper.
 *
 * @module
 */

import { Terminal } from "@xterm/headless";

// ---------------------------------------------------------------------------
// Construction options + the snapshot shape
// ---------------------------------------------------------------------------

/** Construction options for a per-session emulator. */
export interface SessionEmulatorOptions {
  /** Initial grid width in columns. */
  cols: number;
  /** Initial grid height in rows (the visible viewport). */
  rows: number;
  /**
   * Retained rows ABOVE the viewport (the scrollback depth). Bounds per-session
   * memory to `(rows + scrollback) × cols` cells — @xterm discards older lines
   * past this depth (a ring buffer). Plan 02 reads these for the off-screen
   * `scrollback:N` perception; Plan 04 makes the depth config-driven.
   */
  scrollback: number;
}

/**
 * The rendered grid snapshot — the `{screen,cursor,cols,rows,alt}` subset of the
 * worker's `read` view (the worker adds `alive`). `screen` is the plain visible
 * viewport text by default; `cursor`/`alt` are the REAL emulator state.
 */
export interface EmulatorSnapshot {
  /** The rendered text (plain viewport grid by default). */
  screen: string;
  /** The REAL cursor position (`buffer.active.cursorX/cursorY`). */
  cursor: { x: number; y: number };
  /** The grid width in columns. */
  cols: number;
  /** The grid height in rows. */
  rows: number;
  /** True when the alternate screen buffer is active (a full-screen TUI). */
  alt: boolean;
}

/**
 * The per-session emulator surface the worker drives. `term` is exposed so Plan
 * 02 can `loadAddon` the SerializeAddon against it and Plan 03 can read
 * `buffer.active` for the below-fold predicate.
 */
export interface SessionEmulator {
  /**
   * Feed a chunk into the emulator. Resolves on the §2.4 parse-complete flush
   * (the `@xterm` `write(data, cb)` callback), so the worker can await the parse
   * before serializing a settled frame.
   */
  write(data: string): Promise<void>;
  /** Build the current grid snapshot (real cursor + real alt). */
  snapshot(): EmulatorSnapshot;
  /** Resize the grid; reflows the buffer. */
  resize(cols: number, rows: number): void;
  /** Dispose the underlying Terminal once; a second call is a no-op. */
  dispose(): void;
  /** The underlying @xterm Terminal (Plan 02 loads the addon; Plan 03 reads the buffer). */
  readonly term: Terminal;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct a per-session emulator over a real `@xterm/headless` Terminal.
 *
 * Everything is closure-local on the returned object — no module-global state.
 * `allowProposedApi:true` is required: the SerializeAddon (Plan 02) uses proposed
 * APIs; enabling it here unlocks serialization, NOT any host capability (the
 * Terminal is a PARSER, never an executor — it mutates only its in-memory grid).
 *
 * @param opts - The grid geometry + scrollback depth.
 * @returns The {@link SessionEmulator} surface.
 */
export function createSessionEmulator(opts: SessionEmulatorOptions): SessionEmulator {
  const term = new Terminal({
    cols: opts.cols,
    rows: opts.rows,
    scrollback: opts.scrollback,
    allowProposedApi: true,
  });

  let disposed = false;

  /**
   * Read the visible viewport as plain text. For each viewport row read
   * `getLine(baseY + y)?.translateToString(true)` so the viewport is read
   * correctly even when scrollback has accumulated (the viewport top is `baseY`).
   */
  function readViewport(): string {
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < term.rows; y++) {
      lines.push(buf.getLine(buf.baseY + y)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  }

  return {
    term,

    write(data: string): Promise<void> {
      // The callback is the §2.4 parse-complete flush — resolve on it (NOT on
      // write's synchronous return) so the worker's await genuinely waits for the
      // grid to reflect the bytes.
      return new Promise<void>((resolve) => {
        term.write(data, resolve);
      });
    },

    snapshot(): EmulatorSnapshot {
      const buf = term.buffer.active;
      return {
        screen: readViewport(),
        cursor: { x: buf.cursorX, y: buf.cursorY },
        cols: term.cols,
        rows: term.rows,
        alt: buf.type === "alternate",
      };
    },

    resize(cols: number, rows: number): void {
      term.resize(cols, rows);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      term.dispose();
    },
  };
}
