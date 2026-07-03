// SPDX-License-Identifier: Apache-2.0
/**
 * The `TerminalPlatformProfile` interface — Layer 2 of the 3-layer model:
 * the read-side perception/render tuning for a first-class TUI (Claude Code, Codex, …),
 * selected by the operator-declared `allowId`.
 *
 * READ-SIDE ONLY: a profile transforms what we *perceive* (the post-jail emulator
 * snapshot) and how we *classify* it. It NEVER widens the bwrap jail, the env, or the launch —
 * those stay operator-controlled Layer 3. Selection is by `allowId` (operator-declared in the
 * allowlist), so the driven program cannot choose its own profile (no content-sniffing).
 *
 * Declarative-first: perception + dialogs are DATA (pattern lists), reviewable and testable
 * as data. `transformSnapshot` is the SINGLE code escape hatch — render needs cell-level access
 * (the ghost-strip reads `RenderCell.dim`). The agnostic default (no profile) keeps
 * the generic behavior byte-identical.
 *
 * LEAF + type-only deps: this module type-imports the render snapshot/cell shapes from the
 * sibling engine leaf (`terminal-render.ts`) and value-imports NOTHING — the registry composes it.
 *
 * @module
 */

import type { EmulatorSnapshot } from "../terminal-render.js";

/**
 * A safe auto-answer keystroke — RAW text fragments that the auto-answer path joins
 * (`keys.join("")`) and sends via `send_text`, EXACTLY like the canned `["\r"]` Enter the
 * operator-hintPattern path already sends (the woken turn does not name-key-encode these).
 * E.g. `["\r"]` to accept a default (Enter), `["2", "\r"]` for choice-2-then-Enter. Consumed by
 * the auto-answer path. (NOT the named-key `send_key` vocabulary — that path is not used by the
 * auto-answer.)
 */
export type KeySpec = readonly string[];

/**
 * Perception patterns the classifier consumes INSTEAD of hardcoding platform special-cases.
 * Each is additive: present ⇒ refine/override the generic heuristics; absent ⇒ generic only.
 * All patterns are hot-path (run per read/settle frame) ⇒ ReDoS-guarded at registry load
 * (`assertSafeProfilePatterns`).
 */
export interface PlatformPerception {
  /** The "input is awaited" affordance — Claude's `❯`-box composer ; Codex composer. */
  readonly promptAffordance?: readonly RegExp[];
  /** The "the CLI is working" line — Claude spinner glyph+gerund ; Codex `Working (Ns)`. */
  readonly workingLine?: readonly RegExp[];
  /** A picker/menu is open — Claude 2.1 full-screen menus ; the `/model` picker ; `Select Model`. */
  readonly menuOrPicker?: readonly RegExp[];
  /** A turn ended — Claude `✻ Cooked for Ns` / `⏺ Done` ; Codex composer-return. */
  readonly turnEnd?: readonly RegExp[];
}

/**
 * A known dialog + its SAFE auto-answer keystroke. The operator's safe-only auto-answer policy
 * still gates these (a profile proposes; the operator policy disposes). `destructive` entries are
 * NEVER auto-answered — they escalate to a human.
 */
export interface PlatformDialog {
  /** A stable label — `"trust-gate" | "permission-prompt" | "approval-overlay"`. */
  readonly name: string;
  /** The detection pattern (hot-path ⇒ ReDoS-guarded). */
  readonly detect: RegExp;
  /** The safe answer chord (omitted ⇒ detection-only; the policy still gates the send). */
  readonly safeAnswer?: KeySpec;
  /** `true` ⇒ escalate, never auto-answer (the safety floor). */
  readonly destructive?: boolean;
}

/**
 * A read-side per-platform perception/render profile. `undefined` from the registry ⇒ the agnostic
 * default. Selected by `allowId` exact-match; paired with the bundled SKILL.md by a shared
 * `id` + a shared `platformVersion` (drift-guarded at build time).
 */
export interface TerminalPlatformProfile {
  /** Conceptual pairing id (matches the bundled SKILL.md name): `"claude-code" | "codex" | …`. */
  readonly id: string;

  /**
   * The operator-declared allowIds this profile applies to (the create allowlist entry's id).
   * Selection is by allowId ONLY — operator-controlled, unspoofable by the driven program.
   * Exact-string membership; a load-time uniqueness check forbids one allowId mapping to >1 profile.
   */
  readonly allowIds: readonly string[];

  /**
   * The version this profile is paired with — MUST equal the bundled SKILL.md frontmatter
   * `version` (enforced by a build-time architecture test; never a runtime gate).
   */
  readonly platformVersion: string;

  /**
   * READ-SIDE render transform on the agnostic emulator snapshot (post-jail; pure; total).
   * Default (no profile) = identity. The Claude ghost-strip is the `claude-code` profile's
   * transform. The transform reads `snap.grid` (the viewport cell grid, present for
   * text-format snapshots) when it needs cell-level attributes; it must no-op when `grid` is absent.
   */
  readonly transformSnapshot?: (snap: EmulatorSnapshot) => EmulatorSnapshot;

  /** Perception patterns the classifier consumes. */
  readonly perception?: PlatformPerception;

  /** Known dialogs + safe answers the dialog-detector/auto-answer consume. */
  readonly dialogs?: readonly PlatformDialog[];
}
