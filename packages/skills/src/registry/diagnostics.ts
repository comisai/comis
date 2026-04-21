// SPDX-License-Identifier: Apache-2.0
/**
 * Diagnostic types for skill discovery.
 *
 * Provides structured diagnostics for collision handling, warnings, and errors
 * that occur during filesystem skill discovery. Used by discoverSkills() to
 * report issues without throwing exceptions.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Details of a name collision between two skill files. */
export interface ResourceCollision {
  readonly resourceType: "skill";
  readonly name: string;
  readonly winnerPath: string;
  readonly loserPath: string;
}

/** A diagnostic emitted during discovery (warning, error, or collision). */
export interface ResourceDiagnostic {
  readonly type: "warning" | "error" | "collision";
  readonly message: string;
  readonly path?: string;
  readonly collision?: ResourceCollision;
}
