// SPDX-License-Identifier: Apache-2.0
/**
 * Pino pipeline-mode redact stage.
 *
 * Wraps `redactSecretsInText` in a `pino-abstract-transport` pipeline-compatible
 * transport. Use as `pipeline: [{ target: "@comis/infra/dist/logging/pipeline-redact-stage.js" }]`
 * on a pino file target — the stage runs upstream of the target and scrubs every
 * log line before it is written to disk.
 *
 * IMPORTANT: `enablePipelining: true` is required. Without it, pino sends the
 * raw bytes to the target in parallel (not upstream), so redaction has no effect.
 *
 * `parse: "lines"` ensures the fn receives raw newline-delimited strings rather
 * than parsed JSON objects (split2's default). This is required because the
 * pipeline stage must re-emit strings (not objects) for the downstream file
 * transport to write them verbatim.
 *
 * @module
 */
import type { Transform } from "node:stream";
import build from "pino-abstract-transport";
import { redactSecretsInText } from "@comis/observability";

export default function createPipelineRedactStage(_opts?: unknown): Transform {
  // pino-abstract-transport@3.0.0 runtime supports async-generator return
  // values in the fn callback when enablePipelining is true (see index.js:118
  // — `Duplex.from({ writable: stream, readable: res })`). However, the
  // bundled .d.ts types (vintage 0.4.0) only declare the Transform-returning
  // overload, so we cast via unknown to satisfy tsc while preserving the
  // correct runtime behaviour.
  //
  // parse: "lines" is critical: without it, split2 parses each line as JSON
  // before passing it to the fn. The async generator must re-yield strings
  // (not objects) so the downstream file target can write them verbatim.
  return build(
    (source: Transform & build.OnUnknown) =>
      (async function* () {
        for await (const line of source as AsyncIterable<unknown>) {
          // parse:"lines" guarantees string delivery (split2 always emits strings
          // in line-parse mode). The ternary fallback is a defensive no-op.
          const lineStr = line as string;
          try {
            // Re-append "\n" stripped by split2's line-parse mode.
            // Without this, every yielded value is written back-to-back with no
            // delimiter, producing one concatenated unparseable blob.
            yield redactSecretsInText(lineStr) + "\n";
          } catch {
            // Pino transport invariant: never throw. If redaction itself errors,
            // pass the line through unmodified so the log is never lost.
            yield lineStr + "\n";
          }
        }
      })() as unknown as Transform & build.OnUnknown,
    { enablePipelining: true, parse: "lines" },
  ) as unknown as Transform;
}
