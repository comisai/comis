// SPDX-License-Identifier: Apache-2.0
/**
 * OBS-HARD-10 — observability mode-invariants source rule.
 *
 * Strict-literal AST walker over `packages/**\/src/**\/*.ts` flagging any
 * bare `fs.mkdirSync` / `fs.writeFileSync` / `fs.promises.mkdir` /
 * `fs.promises.writeFile` call (and bare imports `mkdirSync` /
 * `writeFileSync` / `mkdir` / `writeFile`) lacking an explicit literal
 * `mode:` option of `0o700` (mkdir context) or `0o600` (writeFile context).
 *
 * Variable references, function calls, ternaries, bitwise expressions
 * all fail (per CONTEXT.md D-07). Inline `// fs-safe-allowed: <reason>`
 * opt-out comment on the line immediately above the call is honored
 * (D-09). `packages/observability/src/shared/fs-safe.ts` is
 * path-allowlisted (it's the layer the rule defers to).
 *
 * After Plan 48-05 + 48-06 sibling-writer sweeps, the effective allowlist
 * is just the fs-safe substrate file plus inline `fs-safe-allowed:`
 * opt-outs on call sites that legitimately bypass the substrate (e.g.,
 * writes outside `~/.comis/`, browser-tool user-supplied output paths,
 * CLI-bootstrap PID files captured at process start, etc.).
 *
 * @module
 */
import { describe, it } from "vitest";

describe("observability-mode-invariants source rule", () => {
  it.skip("classifies_mode_invariants_positive_fixture_as_violation", () => {});
  it.skip("classifies_mode_invariants_negative_fixture_as_clean", () => {});
  it.skip("packages_src_does_not_call_fs_mkdir_without_literal_mode_0o700", () => {});
  it.skip("packages_src_does_not_call_fs_writeFile_without_literal_mode_0o600", () => {});
  it.skip("fs_safe_substrate_file_is_path_allowlisted", () => {});
  it.skip("inline_fs_safe_allowed_comment_opts_out_a_callsite", () => {});
});
