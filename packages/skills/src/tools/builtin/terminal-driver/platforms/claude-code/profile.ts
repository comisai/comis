// SPDX-License-Identifier: Apache-2.0
/**
 * The `claude-code` platform profile (Layer 2) — paired with
 * `packages/daemon/bundled-skills/claude-code/SKILL.md` by the shared `id` + `platformVersion`.
 *
 * Phase 167: the render transform — the FINDING-3 dim-autocomplete ghost-strip, RELOCATED here out
 * of the agnostic `terminal-render.ts` (RENDER-01). Perception (Phase 168) and dialogs (Phase 169)
 * follow in later phases.
 *
 * @module
 */

import type { EmulatorSnapshot, RenderCell } from "../../terminal-render.js";
import type { TerminalPlatformProfile } from "../terminal-platform-profile.js";

/**
 * Render one terminal row to text while STRIPPING the dim autocomplete ghost-text (FINDING-3,
 * live VPS 2026-06-17). Claude Code shows a DIM suggestion in its composer (e.g. `commit this`);
 * the plain-text `read()` capture can't convey the dim styling, so the driving model can't tell
 * the suggestion from real queued input — it halts to ask about it and drops later steps. On the
 * cursor's row, a cell at column `>= cursorX` that is DIM is autocomplete (real input is NON-dim
 * and at/left of the cursor), so it is omitted; everything else (the non-dim prompt, real input,
 * dim cells LEFT of the cursor) is kept. Trailing whitespace is trimmed to match
 * `translateToString(true)`. Pure + total. Applied to the cursor row REGARDLESS of the alt-screen
 * flag (the tmux backend's `tmux attach` renders in the alt screen, so the flag can't gate it);
 * the (also-dim) status bar on other rows is never touched.
 *
 * Relocated VERBATIM from `terminal-render.ts` (v2.26 RENDER-01) — the engine no longer carries it.
 */
export function stripGhostFromRow(cells: readonly RenderCell[], cursorX: number): string {
  let out = "";
  for (let x = 0; x < cells.length; x++) {
    const c = cells[x];
    if (c.width === 0) continue; // wide-char trailing / combining slot — translateToString skips it
    if (x >= cursorX && c.dim) continue; // the dim autocomplete ghost-text right of the cursor
    out += c.chars.length > 0 ? c.chars : " ";
  }
  return out.replace(/\s+$/u, "");
}

/**
 * The `claude-code` `transformSnapshot`: re-render the cursor row of the plain-text snapshot with
 * the ghost-strip applied, using the viewport cell grid (`snap.grid`) for the dim attributes the
 * flattened `screen` string has lost. A no-op when `snap.grid` is absent (the engine populates it
 * only for text-format snapshots) — so ansi/html reads and the agnostic path are untouched (INV-1).
 *
 * The cursor row's index WITHIN `screen` accounts for any scrollback rows the engine prepended:
 * `screen` carries `(lines.length - rows)` scrollback rows before the viewport, so the cursor's
 * viewport row `cursor.y` sits at `screen` line `(lines.length - rows) + cursor.y`.
 */
function transformSnapshot(snap: EmulatorSnapshot): EmulatorSnapshot {
  const grid = snap.grid;
  if (grid === undefined) return snap; // no cell grid (ansi/html / agnostic) — identity
  const cursorRowCells = grid[snap.cursor.y];
  if (cursorRowCells === undefined) return snap;
  const lines = snap.screen.split("\n");
  const viewportStart = lines.length - snap.rows; // scrollback rows precede the viewport, if any
  const cursorLineIdx = viewportStart + snap.cursor.y;
  if (cursorLineIdx < 0 || cursorLineIdx >= lines.length) return snap;
  lines[cursorLineIdx] = stripGhostFromRow(cursorRowCells, snap.cursor.x);
  return { ...snap, screen: lines.join("\n") };
}

/**
 * The `claude-code` profile. `allowIds` claims the documented operator id (`claude`, per
 * `docs/agent-tools/terminal-driver.mdx`) + the `claude-code` alias. `platformVersion` MUST track
 * the bundled SKILL.md `version` (drift-guarded by the architecture test).
 */
export const claudeCodeProfile: TerminalPlatformProfile = {
  id: "claude-code",
  allowIds: ["claude", "claude-code"],
  platformVersion: "1.1.5",
  transformSnapshot,
  // CLASSIFY-01 (Phase 168): Claude Code perception signatures the classifier consumes (layered on
  // the generic structural detection). All anchored + ReDoS-safe (the registry guard enforces at load).
  perception: {
    // The composer input caret — Claude's `❯ ` prompt box (the LIVE-02 idle-`❯` awaiting-input cue).
    promptAffordance: [/(?:^|\s)❯\s/u],
    // The working spinner: a SPINNER GLYPH (not the generic `·` middot — review WR-02, it over-matches
    // prose `· Building`) + a gerund (e.g. `✻ Crunching`), or the `(esc to interrupt)` hint Claude
    // renders while busy — a settled-but-RECENT frame showing this is mid-work, not a prompt.
    workingLine: [/[✢✳✶✻✽]\s+\w+ing\b/u, /\(esc to interrupt\)/iu],
    // Pickers/menus: the `/model` picker, a dismiss affordance, or a `❯`/`›` selector on an
    // enumerated option — the D5 fix for the v2.11 full-screen menu → awaiting-input misread.
    menuOrPicker: [/Select\s+(?:a\s+)?Model/iu, /\bEsc to (?:cancel|exit|go back)\b/iu, /(?:^|\s)[›❯]\s+\d+[.)]/u],
    // A completed-action bullet. POPULATED (the §6-v2 structured-perception field) but NOT routed into
    // the classifier's awaiting-input branch: `⏺` is Claude's per-tool-action bullet (`⏺ Read(…)`), so
    // feeding it would over-fire awaiting-input on a mid-turn tool-use pause (review WR-01). The idle
    // `❯` composer (promptAffordance) is the real awaiting-input cue.
    turnEnd: [/⏺\s+\S/u],
  },
  // DIALOG-01 (Phase 169): Claude's interactive dialogs + their SAFE answer. The operator safe-only
  // policy + the escalate-always veto STILL gate these (a profile proposes; the policy disposes) — a
  // screen carrying an auth/destructive/approval cue escalates regardless. safeAnswer is RAW text
  // (Enter), sent via send_text exactly like the canned hintPattern answer.
  dialogs: [
    {
      // The first-launch trust gate. Benign — the operator launched Claude in their own workspace;
      // Enter accepts the pre-selected "trust" option. NOT destructive. The phrasing has changed
      // across Claude Code versions, so match all known forms (ReDoS-safe — bounded char class):
      //   pre-2.1:  "Do you trust the files in this folder?"
      //   >= 2.1.x: "Quick safety check: Is this a project you created or one you trust?"
      //             with option "1. Yes, I trust this folder"
      // (webhook-claude-cli-tdd-20260630: a stale regex matching only the pre-2.1 wording stalled a
      // driven claude 2.1.196 session at the gate — auto-answer never fired.)
      name: "trust-gate",
      detect: /trust the files in this folder|is this a project you[^\n]{0,80}trust|yes, i trust this folder/iu,
      safeAnswer: ["\r"],
      destructive: false,
    },
    {
      // A standard permission prompt ("Do you want to proceed?"). Enter accepts the default; a
      // DESTRUCTIVE action on the same screen (delete/overwrite/…) is caught by the escalate-always
      // veto and escalated regardless. NOT inherently destructive.
      name: "permission-prompt",
      detect: /Do you want to proceed\?/iu,
      safeAnswer: ["\r"],
      destructive: false,
    },
  ],
};
