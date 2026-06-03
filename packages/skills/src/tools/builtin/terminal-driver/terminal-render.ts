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
 * Render formats (§2.4, TR-02): `snapshot({format})` returns the plain grid
 * (`text`, default), the ansi-with-SGR serialization (`ansi` via the
 * SerializeAddon's `serialize()`), or an HTML fragment (`html` via
 * `serializeAsHTML()`). `snapshot({scrollback:N})` includes the N retained rows
 * ABOVE the viewport (TR-14 perception beyond the fold). Per §11 the
 * addon-serialize dep is pinned (0.14.0) + golden-frame tested (Plan 05) against
 * churn.
 *
 * TR-14 perception signals: `hasContentBelowFold()` is the "more content below
 * the fold ⇒ NOT settled" rendering signal the settle composes (a still-scrolling
 * frame is not marked idle); `diffSnapshot(prev, next)` is the per-read
 * screen-diff (a changed flag + changed-row range) so the agent / the P5
 * classifier can cheaply see what changed without re-diffing whole grids.
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

import { SerializeAddon } from "@xterm/addon-serialize";
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

/** The render format for `snapshot().screen` (spec §2.4 / §5 `read` formats). */
export type RenderFormat = "text" | "ansi" | "html";

/**
 * Options for {@link SessionEmulator.snapshot}. `format` selects the `screen`
 * encoding (plain grid / ansi-with-SGR / html); `scrollback` is how many retained
 * rows ABOVE the viewport to include (TR-14 perception beyond the fold). Both
 * default to the viewport-only plain grid.
 */
export interface SnapshotOptions {
  /** `text` (plain grid, default) | `ansi` (SGR via serialize) | `html` (serializeAsHTML). */
  format?: RenderFormat;
  /** Retained rows above the viewport to include; `0` (default) = viewport only. */
  scrollback?: number;
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
  /**
   * Build the current grid snapshot (real cursor + real alt). `opts.format`
   * selects the `screen` encoding (text/ansi/html via the SerializeAddon);
   * `opts.scrollback` includes off-screen rows above the viewport (TR-14).
   */
  snapshot(opts?: SnapshotOptions): EmulatorSnapshot;
  /** Resize the grid; reflows the buffer. */
  resize(cols: number, rows: number): void;
  /**
   * True when buffer lines exist BELOW the displayed viewport bottom — the §2.4 /
   * TR-14 "more content below the fold" signal the settle composes (a below-fold
   * frame is NOT settled). False at the bottom, on short output, and on the
   * alternate buffer (alt apps own the full screen, no scrollback below).
   */
  hasContentBelowFold(): boolean;
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

  // The SerializeAddon backs the `ansi`/`html` formats (Plan 02). Loaded once at
  // construction; `serialize()`/`serializeAsHTML()` read the buffer on demand.
  // Pinned 0.14.0 + golden-frame tested (Plan 05) against addon churn (§11).
  const serializeAddon = new SerializeAddon();
  term.loadAddon(serializeAddon);

  let disposed = false;

  /**
   * Read the grid as plain text. The viewport rows are
   * `getLine(baseY + y)?.translateToString(true)` for `y` in `0..rows-1` (read
   * via `baseY` so the viewport is correct even when scrollback has accumulated).
   * When `scrollback > 0`, the off-screen rows ABOVE the viewport
   * (`max(0, baseY - scrollback) .. baseY - 1`) are prepended (TR-14 perception).
   */
  function readText(scrollback: number): string {
    const buf = term.buffer.active;
    const lines: string[] = [];
    if (scrollback > 0) {
      const from = Math.max(0, buf.baseY - scrollback);
      for (let i = from; i < buf.baseY; i++) {
        lines.push(buf.getLine(i)?.translateToString(true) ?? "");
      }
    }
    for (let y = 0; y < term.rows; y++) {
      lines.push(buf.getLine(buf.baseY + y)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  }

  /**
   * Encode the `screen` for the requested format. `ansi` → `serialize()` (SGR
   * preserved); `html` → `serializeAsHTML()`; `text` → the plain grid. The
   * SerializeAddon's `scrollback` option includes off-screen rows for ansi/html
   * (both call shapes are valid — `serializeAsHTML` options are `Partial<>`).
   */
  function renderScreen(format: RenderFormat, scrollback: number): string {
    if (format === "ansi") {
      return serializeAddon.serialize(scrollback > 0 ? { scrollback } : {});
    }
    if (format === "html") {
      return serializeAddon.serializeAsHTML(scrollback > 0 ? { scrollback } : {});
    }
    return readText(scrollback);
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

    snapshot(opts?: SnapshotOptions): EmulatorSnapshot {
      const buf = term.buffer.active;
      const format = opts?.format ?? "text";
      const scrollback = opts?.scrollback ?? 0;
      return {
        screen: renderScreen(format, scrollback),
        cursor: { x: buf.cursorX, y: buf.cursorY },
        cols: term.cols,
        rows: term.rows,
        alt: buf.type === "alternate",
      };
    },

    resize(cols: number, rows: number): void {
      term.resize(cols, rows);
    },

    hasContentBelowFold(): boolean {
      // `viewportY` is the DISPLAYED viewport-top line index (it tracks scroll);
      // `length` is the total buffer lines. Content sits below the displayed fold
      // when the displayed `rows` rows do not reach the buffer bottom. (NOTE: we
      // use `viewportY`, NOT `baseY` — in @xterm/headless `baseY` is the
      // cursor-anchored bottom-viewport index and does NOT move when the display
      // scrolls up, so `baseY + rows` always equals `length` after settled output
      // and would never detect a below-fold frame.) On the alternate buffer the
      // app owns the full screen with no scrollback below, so `viewportY` is 0 and
      // `length === rows` ⇒ correctly false.
      const buf = term.buffer.active;
      return buf.viewportY + term.rows < buf.length;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      term.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Screen-diff (the per-read changed-region signal, TR-14)
// ---------------------------------------------------------------------------

/** The screen-diff between two snapshots: a changed flag + the changed-row range. */
export interface SnapshotDiff {
  /** Whether the `screen` text differs between the two snapshots. */
  changed: boolean;
  /** First differing line index (0-based), or `-1` when unchanged. */
  firstChangedRow: number;
  /** Last differing line index (0-based), or `-1` when unchanged. */
  lastChangedRow: number;
}

/**
 * Diff two snapshots' `screen` text line-by-line (TR-14). A pure helper (no
 * emulator access) so the worker can cheaply compare two snapshots and tell the
 * agent / the P5 classifier "did anything change" without re-diffing whole grids.
 *
 * `prev === undefined` ⇒ `changed:true` over the full range (the first read).
 * Otherwise the line arrays are compared: `changed` is true when they differ;
 * `firstChangedRow`/`lastChangedRow` bound the differing lines (both `-1` when
 * unchanged). Lines present in only one snapshot count as changed (the longer
 * array's extra indices extend the range).
 *
 * @param prev - The previous snapshot, or `undefined` for the first read.
 * @param next - The current snapshot.
 * @returns The {@link SnapshotDiff}.
 */
export function diffSnapshot(
  prev: EmulatorSnapshot | undefined,
  next: EmulatorSnapshot,
): SnapshotDiff {
  const nextLines = next.screen.split("\n");
  if (prev === undefined) {
    return { changed: true, firstChangedRow: 0, lastChangedRow: Math.max(0, nextLines.length - 1) };
  }
  const prevLines = prev.screen.split("\n");
  const max = Math.max(prevLines.length, nextLines.length);
  let first = -1;
  let last = -1;
  for (let i = 0; i < max; i++) {
    if (prevLines[i] !== nextLines[i]) {
      if (first === -1) first = i;
      last = i;
    }
  }
  return { changed: first !== -1, firstChangedRow: first, lastChangedRow: last };
}

// ---------------------------------------------------------------------------
// read-result assembly (kept here so the worker stays under the 800-line cap)
// ---------------------------------------------------------------------------

/**
 * The worker's `read` reply view (H-1): the rendered grid + real cursor + real
 * alt-screen flag (P2/121), serialized from the per-session emulator. The raw
 * stdout ring is retained only as the emulator-absent / degraded fallback (NOT a
 * dual path on the live backend). `alive` reflects whether the backend runs.
 */
export interface ReadResult {
  screen: string;
  cursor: { x: number; y: number };
  cols: number;
  rows: number;
  alt: boolean;
  alive: boolean;
}

/**
 * Parse the `read` frame params into {@link SnapshotOptions}. `format` is
 * validated to one of `text|ansi|html` (anything else → `text`); `scrollback` is
 * a non-negative number (anything else → `0`). Kept here so the worker stays
 * under the 800-line cap. `includeAltBuffer` is ignored for now — alt is captured
 * by default per §2.4; an explicit alt-exclude is not in TR-02/14 scope.
 *
 * @param params - The decoded read-frame params (`frame.params`).
 * @returns The validated `{format, scrollback}` snapshot options.
 */
export function readSnapshotParams(params: Record<string, unknown>): SnapshotOptions {
  const rawFormat = params["format"];
  const format: RenderFormat =
    rawFormat === "ansi" || rawFormat === "html" || rawFormat === "text" ? rawFormat : "text";
  const rawScrollback = params["scrollback"];
  const scrollback =
    typeof rawScrollback === "number" && rawScrollback > 0 ? rawScrollback : 0;
  return { format, scrollback };
}

/** The session geometry/liveness the worker pairs with a snapshot to build a read view. */
export interface ReadResultContext {
  /** The raw stdout ring — the emulator-absent / degraded fallback view. */
  ring: string;
  /** The session's recorded column count (fallback when no snapshot). */
  cols: number;
  /** The session's recorded row count (fallback when no snapshot). */
  rows: number;
  /** Whether the backend is still alive. */
  alive: boolean;
}

/**
 * Assemble the worker's `read` reply from an emulator snapshot + the session
 * context. When `snap` is present (the live emulator-backed path) it is the SOLE
 * source for `screen`/`cursor`/`cols`/`rows`/`alt`; when absent (emulator not
 * constructed) the raw `ring` + recorded geometry + `{0,0}` cursor is the
 * degraded fallback — NOT a dual path on the live backend. `alive` always comes
 * from the session context.
 *
 * @param snap - The emulator snapshot, or `undefined` when no emulator exists.
 * @param ctx - The session ring/geometry/liveness fallback.
 * @returns The `{screen,cursor,cols,rows,alt,alive}` read view.
 */
export function buildReadResult(
  snap: EmulatorSnapshot | undefined,
  ctx: ReadResultContext,
): ReadResult {
  return {
    screen: snap?.screen ?? ctx.ring,
    cursor: snap?.cursor ?? { x: 0, y: 0 },
    cols: snap?.cols ?? ctx.cols,
    rows: snap?.rows ?? ctx.rows,
    alt: snap?.alt ?? false,
    alive: ctx.alive,
  };
}
