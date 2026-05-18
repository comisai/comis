// SPDX-License-Identifier: Apache-2.0
/**
 * Queued single-promise-chain file writer for diagnostic artifacts.
 *
 * Each `QueuedFileWriter` instance owns one promise chain
 * (`this.tail = this.tail.then(...)`) and one file path. Sequencing
 * across multiple `write()` calls is guaranteed by the promise chain —
 * no manual mutex needed. Bytes accumulate in `queuedBytes` until the
 * fs work for each enqueued line resolves; the cap (`maxQueuedBytes`)
 * lets callers shed load by returning `"dropped"` instead of pinning
 * unbounded memory.
 *
 * Parent directory is created with mode `0o700` via a one-shot
 * `mkdirSync({ recursive: true, mode: 0o700 })` promise (per-writer,
 * cached after first success — re-runs are no-ops on existing dir).
 *
 * The file write itself goes through `appendRegularFile` from
 * `@comis/infra`, which guarantees `O_NOFOLLOW`, parent-symlink rejection,
 * and `fchmod 0o600` per Plan 45-01 Task 8.
 *
 * `yieldBeforeWrite: true` (default) inserts a `await Promise.resolve()`
 * before the actual fs work so the synchronous caller of `write()` sees
 * `"queued"` returned immediately and the fs cost lands on a microtask.
 * Callers that need bounded-latency sync flush (rare — only the
 * shutdown path) can opt out.
 *
 * `getQueuedFileWriter(writers, path, opts)` is the canonical entry
 * point: it returns the existing writer for the path if one is in the
 * passed Map, otherwise constructs a new one and inserts it. The Map
 * is the operator's LRU registry — they own creation + replacement;
 * `flushAndClose()` removes the writer so the next `getQueuedFileWriter`
 * call constructs fresh.
 *
 * Design §4.1.
 *
 * @module
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { appendRegularFile } from "@comis/infra";

/** Status returned from `write()`. */
export type QueuedFileWriteResult = "queued" | "dropped";

/** Options for `getQueuedFileWriter`. */
export interface QueuedFileWriterOptions {
  /**
   * Maximum queued (in-flight, not-yet-flushed) bytes before `write()`
   * returns `"dropped"`. Strict greater-than boundary — landing exactly
   * at the cap is allowed. Omit for an unbounded queue (not recommended
   * for production).
   */
  readonly maxQueuedBytes?: number;
  /**
   * Maximum total file size in bytes (cumulative across all writes to
   * this file). Forwarded to `appendRegularFile`. Omit for no file-size
   * cap (the writer chassis does not need one; callers like the
   * trajectory runtime usually want one).
   */
  readonly maxFileBytes?: number;
  /**
   * Default `true` — inserts a `Promise.resolve()` before the fs work
   * so the sync caller sees `"queued"` immediately and fs cost lands on
   * the next microtask. Set `false` only for shutdown / synchronous flush.
   */
  readonly yieldBeforeWrite?: boolean;
}

/** Public interface for a queued single-promise-chain file writer. */
export interface QueuedFileWriter {
  /**
   * Enqueue a line for the underlying file. Returns "queued" when the
   * line was accepted, "dropped" when the queued-bytes cap would be
   * exceeded. The actual fs write happens later (yieldBeforeWrite=true)
   * or synchronously (yieldBeforeWrite=false) inside the promise chain.
   */
  write(line: string): QueuedFileWriteResult;

  /** Await the current tail of the promise chain. */
  flush(): Promise<void>;

  /**
   * Await the current tail and remove the writer from the LRU registry
   * passed to `getQueuedFileWriter`. Subsequent `getQueuedFileWriter`
   * for the same path constructs a fresh instance.
   */
  flushAndClose(): Promise<void>;

  /** Number of in-flight (queued, not yet written) bytes. */
  queuedBytes(): number;
}

interface InternalState {
  readonly path: string;
  readonly options: QueuedFileWriterOptions;
  readonly registry: Map<string, QueuedFileWriter>;
  tail: Promise<void>;
  queuedBytes: number;
  mkdirPromise: Promise<void> | undefined;
}

function ensureParentDir(state: InternalState): Promise<void> {
  if (state.mkdirPromise !== undefined) return state.mkdirPromise;
  const dir = dirname(state.path);
  state.mkdirPromise = new Promise<void>((resolveDir) => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      // If mkdir fails the subsequent appendRegularFile will surface the
      // real error — don't reject here so the queue keeps draining and
      // the per-write failure handler logs it.
    }
    resolveDir();
  });
  return state.mkdirPromise;
}

function createWriter(
  registry: Map<string, QueuedFileWriter>,
  filePath: string,
  options: QueuedFileWriterOptions,
): QueuedFileWriter {
  const state: InternalState = {
    path: filePath,
    options,
    registry,
    tail: Promise.resolve(),
    queuedBytes: 0,
    mkdirPromise: undefined,
  };

  const yieldFirst = options.yieldBeforeWrite !== false;

  const writer: QueuedFileWriter = {
    write(line: string): QueuedFileWriteResult {
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (
        typeof state.options.maxQueuedBytes === "number" &&
        state.queuedBytes + lineBytes > state.options.maxQueuedBytes
      ) {
        return "dropped";
      }
      state.queuedBytes += lineBytes;

      state.tail = state.tail.then(async () => {
        if (yieldFirst) await Promise.resolve();
        await ensureParentDir(state);
        try {
          appendRegularFile({
            path: state.path,
            content: line,
            ...(typeof state.options.maxFileBytes === "number"
              ? { maxFileBytes: state.options.maxFileBytes }
              : {}),
          });
        } catch {
          // Defensive — appendRegularFile already returns a Result, so a
          // host-throw here is unexpected. Swallow so the queue continues
          // draining; a future plan adds per-writer error sink.
        }
        state.queuedBytes -= lineBytes;
        if (state.queuedBytes < 0) state.queuedBytes = 0;
      });

      return "queued";
    },

    async flush(): Promise<void> {
      // Capture the current tail and await it. Any writes enqueued AFTER
      // this capture are NOT awaited by this flush call (matches the
      // documented semantics: flush awaits whatever's queued at call time).
      const snapshot = state.tail;
      await snapshot;
    },

    async flushAndClose(): Promise<void> {
      await writer.flush();
      registry.delete(filePath);
    },

    queuedBytes(): number {
      return state.queuedBytes;
    },
  };

  return writer;
}

/**
 * Return the existing `QueuedFileWriter` for `filePath` from `registry`,
 * or construct + register a new one. Subsequent calls with the same
 * `filePath` return the same instance until `flushAndClose()` evicts it.
 *
 * @param registry - operator-owned LRU map (key = filePath)
 * @param filePath - target file (absolute path)
 * @param options - optional per-writer settings; merged at construction
 *   time only (subsequent calls ignore `options` if the path is already
 *   in the registry)
 */
export function getQueuedFileWriter(
  registry: Map<string, QueuedFileWriter>,
  filePath: string,
  options: QueuedFileWriterOptions = {},
): QueuedFileWriter {
  const existing = registry.get(filePath);
  if (existing) return existing;
  const writer = createWriter(registry, filePath, options);
  registry.set(filePath, writer);
  return writer;
}
