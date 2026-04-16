/**
 * Session-stable latch utility: set-once value with session-scoped reset.
 *
 * Provides a value container that can be set exactly once per session cycle.
 * After setOnce() latches a value, subsequent setOnce() calls return the
 * latched value without overwriting. reset() clears the latch for the next
 * session cycle.
 *
 * Use for any session-scoped value that must not flip mid-session to protect
 * cache stability (e.g., config toggles, provider selection).
 *
 * SessionLatch<T> utility with set-once semantics and session-scoped reset.
 *
 * @module
 */

/**
 * A set-once value container with explicit reset.
 *
 * @typeParam T - The type of the latched value
 */
export interface SessionLatch<T> {
  /** Get the current latched value, or null if not yet set. */
  get(): T | null;
  /** Set the value if not already latched. Returns the latched value (existing or new). */
  setOnce(value: T): T;
  /** Clear the latch, allowing a new value to be set. */
  reset(): void;
}

/**
 * Create a SessionLatch with optional initial value.
 *
 * @param initial - Optional initial value. If provided, the latch starts in the latched state.
 * @returns A SessionLatch<T> instance
 */
export function createSessionLatch<T>(initial: T | null = null): SessionLatch<T> {
  let value: T | null = initial;
  let latched = initial !== null;

  return {
    get: () => value,
    setOnce(newValue: T): T {
      if (!latched) {
        value = newValue;
        latched = true;
      }
      return value!;
    },
    reset(): void {
      value = null;
      latched = false;
    },
  };
}

// ---------------------------------------------------------------------------
// Accumulative latch
// ---------------------------------------------------------------------------

/**
 * Accumulative value container: grows over session lifetime, never shrinks
 * (except on reset). Distinct from SessionLatch<T> which is set-once.
 *
 * Use for values that accumulate during a session (e.g., beta headers
 * that must persist once seen). Accumulative is
 * intentionally separate from SessionLatch<T>.
 *
 * @typeParam T - The type of values to accumulate
 */
export interface AccumulativeLatch<T> {
  /** Get all accumulated values as a read-only set. */
  getAll(): ReadonlySet<T>;
  /** Add a value. Returns true if the value was new, false if already present. */
  add(value: T): boolean;
  /** Check if a value has been accumulated. */
  has(value: T): boolean;
  /** Get the number of accumulated values. */
  size(): number;
  /** Clear all accumulated values. */
  reset(): void;
}

/**
 * Create an AccumulativeLatch that grows over session lifetime.
 *
 * @returns An AccumulativeLatch<T> instance
 */
export function createAccumulativeLatch<T>(): AccumulativeLatch<T> {
  const values = new Set<T>();
  return {
    getAll: () => values,
    add(value: T): boolean {
      if (values.has(value)) return false;
      values.add(value);
      return true;
    },
    has: (value: T) => values.has(value),
    size: () => values.size,
    reset(): void { values.clear(); },
  };
}
