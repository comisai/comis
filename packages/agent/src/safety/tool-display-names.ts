// SPDX-License-Identifier: Apache-2.0
/**
 * Tool display name registry -- maps internal tool identifiers to
 * human-friendly labels for UI, TUI, and log output.
 *
 * Falls back to the raw tool name when no mapping is registered.
 */

/** Built-in tool display names for common operations. */
const BUILTIN_DISPLAY_NAMES: Record<string, string> = {
  read: "Read File",
  edit: "Edit File",
  write: "Write File",
  grep: "Search Files",
  find: "Find Files",
  ls: "List Directory",
  exec: "Run Command",
  process: "Manage Process",
  web_search: "Web Search",
  web_fetch: "Fetch URL",
  apply_patch: "Apply Patch",
  mcp_call: "MCP Tool Call",
};

/**
 * A registry that maps tool identifiers to human-readable display names.
 */
export interface ToolDisplayNames {
  /** Get display name for a tool. Returns toolName if no mapping exists. */
  getDisplayName(toolName: string): string;
  /** Register a display name mapping. */
  register(toolName: string, displayName: string): void;
  /** Register multiple mappings at once. */
  registerAll(mappings: Record<string, string>): void;
  /** Get all registered mappings as a read-only snapshot. */
  getAll(): ReadonlyMap<string, string>;
}

/**
 * Create a tool display name registry with built-in defaults.
 *
 * @param defaults - Optional overrides/additions merged on top of built-in names.
 * @returns A ToolDisplayNames registry instance.
 */
export function createToolDisplayNames(defaults?: Record<string, string>): ToolDisplayNames {
  const map = new Map<string, string>(Object.entries(BUILTIN_DISPLAY_NAMES));

  // Merge caller-provided defaults on top (overrides builtins)
  if (defaults) {
    for (const [key, value] of Object.entries(defaults)) {
      map.set(key, value);
    }
  }

  return {
    getDisplayName(toolName: string): string {
      return map.get(toolName) ?? toolName;
    },

    register(toolName: string, displayName: string): void {
      map.set(toolName, displayName);
    },

    registerAll(mappings: Record<string, string>): void {
      for (const [key, value] of Object.entries(mappings)) {
        map.set(key, value);
      }
    },

    getAll(): ReadonlyMap<string, string> {
      // Return a frozen snapshot -- callers cannot mutate the internal map
      const snapshot = new Map(map);
      return Object.freeze({
        get: (key: string) => snapshot.get(key),
        has: (key: string) => snapshot.has(key),
        forEach: (
          callbackfn: (value: string, key: string, map: ReadonlyMap<string, string>) => void,
        ) => snapshot.forEach(callbackfn as (value: string, key: string, map: Map<string, string>) => void),
        entries: () => snapshot.entries(),
        keys: () => snapshot.keys(),
        values: () => snapshot.values(),
        [Symbol.iterator]: () => snapshot[Symbol.iterator](),
        get size() {
          return snapshot.size;
        },
      }) as ReadonlyMap<string, string>;
    },
  };
}
