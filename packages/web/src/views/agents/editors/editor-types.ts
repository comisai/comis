// SPDX-License-Identifier: Apache-2.0
/**
 * Shared types and constants for agent editor sub-components.
 *
 * Extracted from agent-editor.ts to enable independent sub-editor files
 * that all reference the same form shape and event protocol.
 */

/** Flat form state used by the agent editor shell and all sub-editors. */
export type EditorForm = Record<string, unknown>;

/** Detail payload carried by the `field-change` CustomEvent dispatched by sub-editors. */
export interface FieldChangeDetail {
  key: string;
  value: unknown;
}

/** Shape returned by models.list RPC (unfiltered). */
export interface CatalogProvider {
  name: string;
  modelCount: number;
  models: Array<{ modelId: string; displayName: string }>;
}

/** Built-in tool names for the Skills section checkboxes (matches BuiltinToolsSchema). */
export const BUILTIN_TOOLS = [
  "read", "write", "edit", "grep", "find", "ls",
  "exec", "process", "webSearch", "webFetch", "browser",
] as const;

/** Builtin tools enabled per tool policy profile (maps profile -> config keys). */
export const PROFILE_BUILTIN_TOOLS: Record<string, Record<string, boolean>> = {
  minimal: {
    read: true, write: true, edit: false, grep: false, find: false,
    ls: false, exec: false, process: false, webSearch: false, webFetch: false, browser: false,
  },
  coding: {
    read: true, write: true, edit: true, grep: true, find: true,
    ls: true, exec: true, process: true, webSearch: false, webFetch: false, browser: false,
  },
  messaging: {
    read: false, write: false, edit: false, grep: false, find: false,
    ls: false, exec: false, process: false, webSearch: false, webFetch: false, browser: false,
  },
  supervisor: {
    read: false, write: false, edit: false, grep: false, find: false,
    ls: false, exec: false, process: false, webSearch: false, webFetch: false, browser: false,
  },
  full: {
    read: true, write: true, edit: true, grep: true, find: true,
    ls: true, exec: true, process: true, webSearch: true, webFetch: true, browser: false,
  },
};
