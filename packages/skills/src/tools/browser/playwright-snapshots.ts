// SPDX-License-Identifier: Apache-2.0
/**
 * Accessibility snapshot generation.
 *
 * Takes accessibility snapshots of web pages using Playwright's
 * ariaSnapshot() API, producing text representations with element
 * references (e.g., "e12: button 'Submit'") that agents use to
 * decide what to interact with.
 *
 * Supports "role" format (ariaSnapshot + ref annotation) and
 * filtering options (interactive-only, compact, selector scoping).
 *
 * Ported from Comis browser/pw-role-snapshot.ts +
 * pw-tools-core.snapshot.ts, simplified without frame handling
 * or label/image overlay mode.
 *
 * @module
 */

import type { Page } from "playwright-core";
import {
  ensurePageState,
  storeRoleRefs,
} from "./playwright-session.js";

// ── Types ────────────────────────────────────────────────────────────

export type RoleRef = {
  role: string;
  name?: string;
  nth?: number;
};

export type RoleRefMap = Record<string, RoleRef>;

export type SnapshotOptions = {
  /** Only include interactive elements. */
  interactive?: boolean;
  /** Maximum depth in the tree. */
  maxDepth?: number;
  /** Remove unnamed structural elements and empty branches. */
  compact?: boolean;
  /** CSS selector to scope the snapshot to a subtree. */
  selector?: string;
  /** Maximum characters before truncation. */
  maxChars?: number;
};

export type SnapshotResult = {
  snapshot: string;
  refs: RoleRefMap;
  url: string;
  title: string;
  truncated?: boolean;
  stats: { lines: number; chars: number; refs: number; interactive: number };
};

// ── Role Classification ──────────────────────────────────────────────

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "treeitem",
]);

const CONTENT_ROLES = new Set([
  "heading",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "listitem",
  "article",
  "region",
  "main",
  "navigation",
]);

const STRUCTURAL_ROLES = new Set([
  "generic",
  "group",
  "list",
  "table",
  "row",
  "rowgroup",
  "grid",
  "treegrid",
  "menu",
  "menubar",
  "toolbar",
  "tablist",
  "tree",
  "directory",
  "document",
  "application",
  "presentation",
  "none",
]);

// ── Snapshot Building ────────────────────────────────────────────────

function getIndentLevel(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? Math.floor(match[1].length / 2) : 0;
}

type RoleNameTracker = {
  counts: Map<string, number>;
  refsByKey: Map<string, string[]>;
  getKey: (role: string, name?: string) => string;
  getNextIndex: (role: string, name?: string) => number;
  trackRef: (role: string, name: string | undefined, ref: string) => void;
  getDuplicateKeys: () => Set<string>;
};

function createRoleNameTracker(): RoleNameTracker {
  const counts = new Map<string, number>();
  const refsByKey = new Map<string, string[]>();
  return {
    counts,
    refsByKey,
    getKey(role: string, name?: string) {
      return `${role}:${name ?? ""}`;
    },
    getNextIndex(role: string, name?: string) {
      const key = this.getKey(role, name);
      const current = counts.get(key) ?? 0;
      counts.set(key, current + 1);
      return current;
    },
    trackRef(role: string, name: string | undefined, ref: string) {
      const key = this.getKey(role, name);
      const list = refsByKey.get(key) ?? [];
      list.push(ref);
      refsByKey.set(key, list);
    },
    getDuplicateKeys() {
      const out = new Set<string>();
      for (const [key, refs] of refsByKey) {
        if (refs.length > 1) out.add(key);
      }
      return out;
    },
  };
}

function removeNthFromNonDuplicates(
  refs: RoleRefMap,
  tracker: RoleNameTracker,
): void {
  const duplicates = tracker.getDuplicateKeys();
  for (const [ref, data] of Object.entries(refs)) {
    const key = tracker.getKey(data.role, data.name);
    if (!duplicates.has(key)) {
      delete refs[ref]?.nth;
    }
  }
}

function compactTree(tree: string): string {
  const lines = tree.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.includes("[ref=")) {
      result.push(line);
      continue;
    }
    if (line.includes(":") && !line.trimEnd().endsWith(":")) {
      result.push(line);
      continue;
    }

    const currentIndent = getIndentLevel(line);
    let hasRelevantChildren = false;
    for (let j = i + 1; j < lines.length; j += 1) {
      const childIndent = getIndentLevel(lines[j]!);
      if (childIndent <= currentIndent) break;
      if (lines[j]?.includes("[ref=")) {
        hasRelevantChildren = true;
        break;
      }
    }
    if (hasRelevantChildren) result.push(line);
  }

  return result.join("\n");
}

function processLine(
  line: string,
  refs: RoleRefMap,
  options: SnapshotOptions,
  tracker: RoleNameTracker,
  nextRef: () => string,
): string | null {
  const depth = getIndentLevel(line);
  if (options.maxDepth !== undefined && depth > options.maxDepth) return null;

  const match = line.match(/^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/);
  if (!match) return options.interactive ? null : line;

  const [, prefix, roleRaw, name, suffix] = match;
  if (roleRaw!.startsWith("/")) return options.interactive ? null : line;

  const role = roleRaw!.toLowerCase();
  const isInteractive = INTERACTIVE_ROLES.has(role);
  const isContent = CONTENT_ROLES.has(role);
  const isStructural = STRUCTURAL_ROLES.has(role);

  if (options.interactive && !isInteractive) return null;
  if (options.compact && isStructural && !name) return null;

  const shouldHaveRef = isInteractive || (isContent && Boolean(name));
  if (!shouldHaveRef) return line;

  const ref = nextRef();
  const nth = tracker.getNextIndex(role, name);
  tracker.trackRef(role, name, ref);
  refs[ref] = { role, name, nth };

  let enhanced = `${prefix}${roleRaw}`;
  if (name) enhanced += ` "${name}"`;
  enhanced += ` [ref=${ref}]`;
  if (nth > 0) enhanced += ` [nth=${nth}]`;
  if (suffix) enhanced += suffix;
  return enhanced;
}

function buildRoleSnapshotFromAriaSnapshot(
  ariaSnapshot: string,
  options: SnapshotOptions = {},
): { snapshot: string; refs: RoleRefMap } {
  const lines = ariaSnapshot.split("\n");
  const refs: RoleRefMap = {};
  const tracker = createRoleNameTracker();

  let counter = 0;
  const nextRef = () => {
    counter += 1;
    return `e${counter}`;
  };

  if (options.interactive) {
    const result: string[] = [];
    for (const line of lines) {
      const depth = getIndentLevel(line);
      if (options.maxDepth !== undefined && depth > options.maxDepth) continue;

      const match = line.match(/^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/);
      if (!match) continue;
      const [, , roleRaw, name, suffix] = match;
      if (roleRaw!.startsWith("/")) continue;

      const role = roleRaw!.toLowerCase();
      if (!INTERACTIVE_ROLES.has(role)) continue;

      const ref = nextRef();
      const nth = tracker.getNextIndex(role, name);
      tracker.trackRef(role, name, ref);
      refs[ref] = { role, name, nth };

      let enhanced = `- ${roleRaw}`;
      if (name) enhanced += ` "${name}"`;
      enhanced += ` [ref=${ref}]`;
      if (nth > 0) enhanced += ` [nth=${nth}]`;
      if (suffix!.includes("[")) enhanced += suffix;
      result.push(enhanced);
    }

    removeNthFromNonDuplicates(refs, tracker);
    return {
      snapshot: result.join("\n") || "(no interactive elements)",
      refs,
    };
  }

  const result: string[] = [];
  for (const line of lines) {
    const processed = processLine(line, refs, options, tracker, nextRef);
    if (processed !== null) result.push(processed);
  }

  removeNthFromNonDuplicates(refs, tracker);
  const tree = result.join("\n") || "(empty)";
  return {
    snapshot: options.compact ? compactTree(tree) : tree,
    refs,
  };
}

function getSnapshotStats(
  snapshot: string,
  refs: RoleRefMap,
): SnapshotResult["stats"] {
  const interactive = Object.values(refs).filter((r) =>
    INTERACTIVE_ROLES.has(r.role),
  ).length;
  return {
    lines: snapshot.split("\n").length,
    chars: snapshot.length,
    refs: Object.keys(refs).length,
    interactive,
  };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Take an accessibility snapshot of a page.
 *
 * Uses Playwright's ariaSnapshot() to produce a structured text
 * representation of the page's accessibility tree, annotated with
 * element refs (e.g., [ref=e12]) for use in subsequent actions.
 *
 * @param page - Playwright Page instance
 * @param options - Snapshot options (interactive, compact, selector, maxChars)
 * @returns Snapshot text, ref map, and page metadata
 */
export async function takeSnapshot(
  page: Page,
  options: SnapshotOptions = {},
): Promise<SnapshotResult> {
  ensurePageState(page);

  const selector = options.selector?.trim() || "";
  const locator = selector
    ? page.locator(selector)
    : page.locator(":root");

  const ariaSnapshot = await locator.ariaSnapshot();
  const built = buildRoleSnapshotFromAriaSnapshot(
    String(ariaSnapshot ?? ""),
    options,
  );

  let { snapshot } = built;
  let truncated = false;

  if (
    options.maxChars &&
    options.maxChars > 0 &&
    snapshot.length > options.maxChars
  ) {
    snapshot = `${snapshot.slice(0, options.maxChars)}\n\n[...TRUNCATED - page too large]`;
    truncated = true;
  }

  // Store role refs on the page for subsequent action resolution
  storeRoleRefs(page, built.refs, "role");

  const url = page.url();
  const title = await page.title().catch(() => "");

  return {
    snapshot,
    refs: built.refs,
    url,
    title,
    ...(truncated ? { truncated } : {}),
    stats: getSnapshotStats(snapshot, built.refs),
  };
}
