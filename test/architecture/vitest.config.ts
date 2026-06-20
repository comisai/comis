// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packagesRoot = resolve(here, "../../packages");

export default defineConfig({
  // Scoped alias: `@comis/core` + `@comis/observability` + `@comis/skills`
  // + `@comis/skills/platform-tools`.
  // The contract-registry architecture tests (api-contracts-bidirectional,
  // api-contracts-allowlist, contract-internal-fields) need the COMPILED
  // runtime values — the actual API_CONTRACTS Map, the frozen
  // INTERNAL_FIELD_NAMES tuple — not source AST. The
  // trajectory-event-types-known.test.ts also needs the compiled
  // TRAJECTORY_BRIDGE_MAPPING from @comis/observability for the same
  // reason — the bridge mapping is the runtime closed set. `@comis/skills`
  // is included for the same reason: the mcp-prespawn-allowlist test pins
  // the runtime MCP_STDIO_BUILTIN_ENV_ALLOWLIST constant value, not its AST.
  //
  // Vite's resolve.alias matches by string prefix when the key is a
  // string, so `@comis/skills/platform-tools` would resolve to
  // `skills/dist/skills/index.js/platform-tools` (ENOTDIR) unless we
  // register the subpath explicitly. The alias array form below uses regex
  // `find:` patterns to match each subpath exactly.
  //
  // Routing these specific packages to dist/ leaves every other
  // architecture test reading packages/*/src/ via source-grep +
  // ts.createSourceFile (invariant: don't mask source-only changes
  // through alias-routed dist/ reads).
  resolve: {
    alias: [
      { find: /^@comis\/skills\/platform-tools$/, replacement: resolve(packagesRoot, "skills/dist/platform-tools/index.js") },
      { find: /^@comis\/skills\/tools$/, replacement: resolve(packagesRoot, "skills/dist/tools/index.js") },
      { find: /^@comis\/skills$/, replacement: resolve(packagesRoot, "skills/dist/skills/index.js") },
      { find: /^@comis\/core$/, replacement: resolve(packagesRoot, "core/dist/index.js") },
      { find: /^@comis\/observability$/, replacement: resolve(packagesRoot, "observability/dist/index.js") },
      // AUDIT-04 (176-03): audit-metadata-content-free.test.ts drives the REAL
      // obs_audit_events store + the security-audit.jsonl writer (the compiled
      // runtime values createObservabilityStore/initSchema/appendAuditJsonl), not
      // their AST — the planted-value invariant must hold against actual
      // persistence. Same rationale as @comis/core/@comis/observability above.
      { find: /^@comis\/memory$/, replacement: resolve(packagesRoot, "memory/dist/index.js") },
    ],
  },
  test: {
    name: "architecture",
    include: ["**/*.test.ts"],
    pool: "threads",
    // Architecture tests scan the whole packages/*/src tree, parse ASTs, and
    // invoke madge across 1200+ files. 30s was borderline on warm runners and
    // tipped over on slow ones (globals/no-cycles/log-payload-checker all
    // exceeded it in CI run 26003385575). Raise to 120s — generous but bounded.
    testTimeout: 120_000,
    passWithNoTests: true,
  },
});
