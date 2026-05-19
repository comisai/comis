// SPDX-License-Identifier: Apache-2.0
/**
 * Suspicious-caller heuristics for config-audit records.
 *
 * Each `detectSuspicious(...)` call returns an array of zero or more
 * `SuspiciousFlag` literals. The empty array is the "looks normal"
 * outcome. Flags are NOT exhaustive — the heuristics catch the most
 * common adversarial shapes (wrong-binary, off-script, sandboxed
 * caller); more flags can be added by extending the union in
 * `types.ts` and the closed switch here.
 *
 * Three heuristics, all stateless:
 *
 *   1. `unknown-binary` — argv[0] is not `node` / `comis` / `deno`
 *      / `bun` (with optional `.exe` suffix on Windows). The regex
 *      anchors at `/` or `^` to handle both basename and absolute
 *      path forms.
 *
 *   2. `non-comis-argv` — none of the first N argv elements contains
 *      the literal substring `"comis"`. Catches a `node evil.js`
 *      caller that bypassed the comis CLI entirely.
 *
 *   3. `permission-restricted-caller` — `execArgv` contains
 *      `--permission` (Node 20+ permission model). A caller running
 *      under explicit permission-restriction is more interesting for
 *      audit forensics; even legitimate uses (CI/CD) benefit from
 *      the flag.
 *
 * The heuristics intentionally err on the side of false-positives —
 * audit-log operators want to see suspicious patterns even when the
 * caller is benign. The flags are ADDITIVE; they never cause a
 * write to be rejected.
 *
 * @module
 */

import type { SuspiciousFlag } from "./types.js";

/** Input shape for `detectSuspicious`. */
export interface SuspiciousInput {
  /** Argv to inspect (typically `process.argv` or the redacted version). */
  readonly argv: readonly string[];
  /** ExecArgv (`process.execArgv`) — Node-level flags. */
  readonly execArgv: readonly string[];
}

/**
 * Pattern matching the canonical Node/Comis runtimes at the
 * basename slot. The regex anchors at `/` or start-of-string so an
 * absolute-path argv0 (`/usr/local/bin/node`) matches. The optional
 * `.exe` suffix handles Windows.
 */
const RUNTIME_BINARY_PATTERN = /(?:^|\/)(node|comis|deno|bun)(?:\.exe)?$/;

/**
 * Detect suspicious caller heuristics for a config-audit record.
 *
 * @param input - argv + execArgv tuple.
 * @returns array of `SuspiciousFlag` literals (possibly empty).
 */
export function detectSuspicious(input: SuspiciousInput): SuspiciousFlag[] {
  const flags: SuspiciousFlag[] = [];

  // Heuristic 1: unknown-binary.
  const argv0 = input.argv[0];
  if (typeof argv0 !== "string" || !RUNTIME_BINARY_PATTERN.test(argv0)) {
    flags.push("unknown-binary");
  }

  // Heuristic 2: non-comis-argv.
  const anyHasComis = input.argv.some(
    (arg) => typeof arg === "string" && arg.toLowerCase().includes("comis"),
  );
  if (!anyHasComis) {
    flags.push("non-comis-argv");
  }

  // Heuristic 3: permission-restricted-caller.
  const hasPermissionFlag = input.execArgv.some(
    (arg) =>
      typeof arg === "string" &&
      (arg === "--permission" || arg.startsWith("--permission=")),
  );
  if (hasPermissionFlag) {
    flags.push("permission-restricted-caller");
  }

  return flags;
}
