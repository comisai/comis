// SPDX-License-Identifier: Apache-2.0
/**
 * Shared dirty-state tracking utility for form components.
 *
 * Tracks unsaved changes at the field level, provides navigation guards
 * (both in-app and browser tab close), and exposes a clean factory API
 * that any Lit component (or plain JS) can use.
 *
 * Usage:
 *   const tracker = createDirtyTracker();
 *   tracker.attach();          // in connectedCallback
 *   tracker.markDirty("name"); // on field change
 *   tracker.markClean();       // after successful save
 *   tracker.detach();          // in disconnectedCallback
 */

/** Dirty-state tracker interface for form components. */
export interface DirtyTracker {
  /** Whether any tracked fields have changed from their original values. */
  readonly isDirty: boolean;
  /** Mark a specific field as changed. Call on every field edit. */
  markDirty(field?: string): void;
  /** Reset dirty state (call after successful save or on initial load). */
  markClean(): void;
  /**
   * Check if navigation should proceed. If dirty, shows a confirm dialog
   * asking the user to save or discard. Returns true if navigation is allowed.
   */
  confirmNavigation(): boolean;
  /** Attach beforeunload handler to warn on browser tab close. Call in connectedCallback. */
  attach(): void;
  /** Remove beforeunload handler. Call in disconnectedCallback. */
  detach(): void;
  /** Get list of dirty field names (for debugging/display). */
  dirtyFields(): string[];
}

/**
 * Create a dirty-state tracker instance.
 *
 * Factory function pattern matches codebase convention (createCircuitBreaker, createRouter).
 * Pure utility with no framework dependency -- can be used by any component.
 */
export function createDirtyTracker(): DirtyTracker {
  const fields = new Set<string>();

  const beforeUnloadHandler = (e: BeforeUnloadEvent): void => {
    if (fields.size > 0) {
      e.preventDefault();
    }
  };

  return {
    get isDirty() {
      return fields.size > 0;
    },

    markDirty(field = "_default") {
      fields.add(field);
    },

    markClean() {
      fields.clear();
    },

    confirmNavigation() {
      if (fields.size === 0) return true;
      return window.confirm("You have unsaved changes. Discard and leave?");
    },

    attach() {
      window.addEventListener("beforeunload", beforeUnloadHandler);
    },

    detach() {
      window.removeEventListener("beforeunload", beforeUnloadHandler);
    },

    dirtyFields() {
      return [...fields];
    },
  };
}
