// SPDX-License-Identifier: Apache-2.0
/**
 * The pure named-key grammar behind `send_key`.
 *
 * Turns a `send_key` chord (`"C-c"`, `"Up"`, `"S-Tab"`, `"M-x"`) into the exact
 * control/escape byte sequence a PTY consumes. This is a standalone,
 * host-independent, fully unit-testable module with ZERO runtime dependencies —
 * the worker imports it to encode the `send_key` frame.
 *
 * A wrong byte for a key is an invisible, load-bearing bug (the agent thinks it
 * pressed Ctrl-C; the program sees garbage). The mapping is encoded once, here,
 * with the exact-byte RED test asserting every sequence.
 *
 * Non-obvious sequences (xterm defaults):
 *   - `S-Tab` = CSI Z (back-tab, `ESC [ Z`).
 *   - `C-{a..z}` = `0x01..0x1a` (the ASCII control range: lowercased letter code
 *     minus `0x60`); `C-[` = ESC (`0x1b`, the canonical ESC alias).
 *   - `F1`-`F4` = SS3 (`ESC O P..S`); `F5`+ = `CSI n ~` (e.g. `ESC [ 15 ~`).
 *   - `M-`/`A-` (Alt/Meta) prefixes ESC (`0x1b`) before the base key's bytes.
 *
 * Purity: no timers, no wall-clock, no env, no `@comis/infra`. The only runtime
 * surface is `throwToolError("invalid_value", …)` for the unknown-key rejection
 * — parity with the rest of the tool layer.
 *
 * @module
 */

import { throwToolError } from "../../../platform-tools/tool-helpers.js";

// ---------------------------------------------------------------------------
// The literal named-key -> byte table (frozen const; no module-global mutable state)
// ---------------------------------------------------------------------------

/**
 * Exact-case named keys mapped to their xterm-default byte string. A frozen
 * literal const — there is no runtime mutation path (wrong bytes are caught by
 * the exact-byte RED test, not a runtime threat).
 */
const NAMED_KEY_BYTES: Readonly<Record<string, string>> = Object.freeze({
  // Literals.
  Enter: "\r", // \x0d
  Tab: "\t", // \x09
  Escape: "\x1b",
  Esc: "\x1b",
  Backspace: "\x7f",
  Space: " ", // \x20
  // Arrows (CSI) + back-tab (CSI Z).
  Up: "\x1b[A",
  Down: "\x1b[B",
  Right: "\x1b[C",
  Left: "\x1b[D",
  "S-Tab": "\x1b[Z",
  // Navigation.
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  Delete: "\x1b[3~",
  Insert: "\x1b[2~",
  // Function keys: F1-F4 = SS3 (ESC O P..S); F5+ = CSI n ~.
  F1: "\x1bOP",
  F2: "\x1bOQ",
  F3: "\x1bOR",
  F4: "\x1bOS",
  F5: "\x1b[15~",
  F6: "\x1b[17~",
  F7: "\x1b[18~",
  F8: "\x1b[19~",
  F9: "\x1b[20~",
  F10: "\x1b[21~",
  F11: "\x1b[23~",
  F12: "\x1b[24~",
});

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

/** Matches a control chord `C-<letter>` or `C-[` (the ESC alias). */
const CONTROL_RE = /^C-([a-zA-Z[])$/;

/** Matches an Alt/Meta-prefixed chord `M-<rest>` or `A-<rest>` (rest is recursed). */
const ALT_RE = /^(?:M|A)-(.+)$/;

/** A single printable ASCII char (0x20..0x7e) — passes through verbatim. */
function isSinglePrintable(key: string): boolean {
  if (key.length !== 1) return false;
  const code = key.charCodeAt(0);
  return code >= 0x20 && code <= 0x7e;
}

/**
 * Encode one named key (or chord component) to its byte sequence.
 *
 * Resolution order:
 *   1. An exact entry in the literal table.
 *   2. A control chord `C-<letter>` / `C-[` → the ASCII control byte
 *      (`String.fromCharCode(lower - 0x60)`; `C-[` → ESC).
 *   3. An Alt/Meta chord `M-<rest>` / `A-<rest>` → `ESC` + `encodeNamedKey(rest)`
 *      (recurse so `M-Up`, `M-c`, `M-C-c` work; the remainder must itself resolve
 *      to a known key or a single printable — a multi-char unknown remainder
 *      throws, blocking arbitrary multi-byte sequence crafting).
 *   4. A single printable ASCII char → itself.
 *   5. Otherwise → a typed `invalid_value` rejection — NEVER a silent
 *      empty-string no-op.
 *
 * @param key - The named key or chord component.
 * @returns The exact byte string the PTY consumes.
 * @throws via `throwToolError("invalid_value", …)` for an unrecognized key name.
 */
export function encodeNamedKey(key: string): string {
  const literal = NAMED_KEY_BYTES[key];
  if (literal !== undefined) return literal;

  const control = CONTROL_RE.exec(key);
  if (control !== null) {
    const ch = control[1];
    if (ch === "[") return "\x1b"; // C-[ is the canonical ESC alias.
    const lower = ch.toLowerCase();
    return String.fromCharCode(lower.charCodeAt(0) - 0x60); // C-a..C-z -> 0x01..0x1a
  }

  const alt = ALT_RE.exec(key);
  if (alt !== null) {
    // Prefix ESC, then recurse on the remainder (which must itself resolve).
    return "\x1b" + encodeNamedKey(alt[1]);
  }

  if (isSinglePrintable(key)) return key;

  throwToolError("invalid_value", `unknown key name: ${key}`, {
    hint: "use a named key (Up, C-c, S-Tab, F1...) or a single printable character",
  });
}

/**
 * Encode a `keys[]` chord array to the concatenation of each key's bytes, in
 * array order (e.g. `["Up","Enter"]` → `"\x1b[A\r"`). An unknown key inside the
 * array propagates the `invalid_value` throw.
 *
 * @param keys - The chord array from `SendKeyParams.keys`.
 * @returns The concatenated byte string.
 */
export function encodeKeyChord(keys: string[]): string {
  return keys.map(encodeNamedKey).join("");
}
