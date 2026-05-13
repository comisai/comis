// SPDX-License-Identifier: Apache-2.0
/**
 * No-cycles invariants (ARCH-BASE-05).
 *
 * Two distinct tests, fired from `pnpm test` (SOURCE MODE only):
 *   1. INTRA-PACKAGE: madge programmatic API walks every packages/*\/src/
 *      directory through `import` statements (resolved via the bespoke
 *      tsconfig.madge.json paths block), reports source-level circular
 *      import paths within a single package OR across package public
 *      surfaces.
 *   2. CROSS-PACKAGE: Tarjan SCC over the directed graph derived from
 *      packages/*\/tsconfig.json `references` UNION packages/*\/package.json
 *      @comis/* `dependencies`. Catches package-level cycles even when
 *      source-level cycles wouldn't materialize (type-only project-ref
 *      cycles).
 *
 * The DIST-MODE madge gate AND `tsc -b --dry` gate (ARCH-BASE-14's third
 * belt) live in .github/workflows/ci.yml as post-`pnpm build` CI steps —
 * NOT here, since they require dist/ artifacts. See Plan 02 Task 3.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import madge from "madge";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findCycles } from "./tarjan-scc.js";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const TSCONFIG_MADGE = resolve(here, "tsconfig.madge.json");

const WORKSPACE_PACKAGES = [
  "shared",
  "core",
  "infra",
  "memory",
  "scheduler",
  "skills",
  "agent",
  "channels",
  "orchestrator",
  "gateway",
  "cli",
  "daemon",
] as const;

/**
 * BASELINE_INTRA_PACKAGE_CYCLES (Phase 27 baseline — 46 entries).
 *
 * madge source-mode walks `.ts` import statements (mixed value + type) and
 * reports cycles. Phase 27 records the CURRENT pre-existing within-package
 * cycle set so the gate is GREEN at landing while still catching ANY new
 * cycle introduced after Phase 27. Wave 3+ phases (and Plan 06's
 * allowlist-shrink coverage if extended in Phase 36) drive this set
 * downward — entries are removed as the underlying cycles are broken.
 *
 * Format: each entry is the cycle's MEMBER FILES sorted alphabetically and
 * joined by `|`. The canonicalization is required because madge reports
 * cycles starting from arbitrary entry points (e.g., `[a, b]` vs `[b, a]`),
 * so the matching is order-insensitive but member-set-sensitive. Adding a
 * new file to an existing cycle (or a new file that introduces a different
 * cycle) produces a different canonical key and trips the gate.
 *
 * NOTE on dist-mode parity: dist-mode madge (CI gate per Plan 02 Task 3)
 * walks `.d.ts` and reports a different cycle set (Plan 02 SUMMARY recorded
 * 20 dist-mode cycles). The two are complementary; this baseline is for
 * source mode only.
 */
const BASELINE_INTRA_PACKAGE_CYCLES: ReadonlySet<string> = new Set([
  "agent/src/bootstrap/sections/tool-descriptions.ts|agent/src/bootstrap/sections/tooling-sections.ts",
  "agent/src/context-engine/types-compaction.ts|agent/src/context-engine/types-core.ts",
  "agent/src/executor/executor-post-execution.ts|agent/src/executor/pi-executor.ts",
  "agent/src/model/oauth-device-code.ts|agent/src/model/oauth-login-runner.ts",
  // Phase 35 Plan 35-03 (WEB-CONTRACTS-02 D-01 #2) relocated oauth-device-code +
  // oauth-login-runner from @comis/agent to @comis/core. The intra-pair cycle
  // (login-runner's device-code dispatch ↔ device-code's LoginError type-import)
  // is preserved verbatim under the new core path. The agent-side cycle entry
  // above stays live until Plan 35-04 deletes the agent source files.
  "core/src/oauth/oauth-device-code.ts|core/src/oauth/oauth-login-runner.ts",
  // Phase 32 commit 3: paths retargeted channels/src/shared/ -> orchestrator/src/{inbound,execution}/
  // (file moves preserved the cycles; baseline tracks paths, not behavior).
  "orchestrator/src/execution/execution-deliver.ts|orchestrator/src/execution/execution-pipeline.ts",
  "orchestrator/src/execution/execution-execute.ts|orchestrator/src/execution/execution-pipeline.ts",
  "orchestrator/src/execution/execution-filter.ts|orchestrator/src/execution/execution-pipeline.ts",
  "orchestrator/src/execution/execution-pipeline.ts|orchestrator/src/execution/execution-policy.ts",
  "orchestrator/src/inbound/inbound-gate.ts|orchestrator/src/inbound/inbound-pipeline.ts",
  "orchestrator/src/inbound/inbound-pipeline.ts|orchestrator/src/inbound/inbound-preprocess.ts",
  "orchestrator/src/inbound/inbound-pipeline.ts|orchestrator/src/inbound/inbound-resolve.ts",
  "orchestrator/src/inbound/inbound-pipeline.ts|orchestrator/src/inbound/inbound-route.ts",
  "orchestrator/src/inbound/inbound-pipeline.ts|orchestrator/src/inbound/inbound-setup.ts",
  "channels/src/slack/media-handler.ts|channels/src/slack/message-mapper.ts",
  "channels/src/whatsapp/media-handler.ts|channels/src/whatsapp/message-mapper.ts",
  "cli/src/wizard/index.ts|cli/src/wizard/steps/00-welcome.ts",
  "cli/src/wizard/index.ts|cli/src/wizard/steps/01-detect-existing.ts",
  "cli/src/wizard/index.ts|cli/src/wizard/steps/02-flow-select.ts",
  "cli/src/wizard/index.ts|cli/src/wizard/steps/03-provider.ts",
  "cli/src/wizard/index.ts|cli/src/wizard/steps/04-credentials.ts",
  "cli/src/wizard/index.ts|cli/src/wizard/steps/05-agent.ts",
  "cli/src/wizard/index.ts|cli/src/wizard/steps/06-channels.ts",
  "cli/src/wizard/index.ts|cli/src/wizard/steps/07-gateway.ts",
  "cli/src/wizard/index.ts|cli/src/wizard/steps/08-workspace.ts",
  "cli/src/wizard/index.ts|cli/src/wizard/steps/08b-tool-providers.ts",
  "cli/src/wizard/index.ts|cli/src/wizard/steps/09-review.ts",
  "cli/src/wizard/index.ts|cli/src/wizard/steps/10-write-config.ts",
  "cli/src/wizard/index.ts|cli/src/wizard/steps/11-daemon-start.ts",
  "cli/src/wizard/index.ts|cli/src/wizard/steps/12-finish.ts",
  "core/src/config/include-resolver.ts|core/src/config/layered.ts|core/src/config/loader.ts",
  "core/src/ports/channel-plugin.ts|core/src/ports/channel.ts",
  // Phase 32 commit 11 (ORCH-EXT-11) moved announcement-batcher.ts +
  // announcement-dead-letter.ts from daemon to @comis/orchestrator; the
  // three legacy daemon-side cycle entries that referenced them are
  // no longer reproducible (the source files do not exist), removed here.
  // Phase 34 plan 01 (DAEMON-API-01) moved sub-agent-runner.ts +
  // sub-agent-result-processor.ts to @comis/agent/spawn; the intra-pair
  // cycle is preserved verbatim under the new path (entry below).
  "daemon/src/observability/channel-activity-tracker.ts|daemon/src/observability/index.ts",
  "daemon/src/observability/channel-activity-tracker.ts|daemon/src/observability/index.ts|daemon/src/observability/obs-persistence-wiring.ts",
  "daemon/src/observability/context-pipeline-collector.ts|daemon/src/observability/index.ts",
  "daemon/src/observability/delivery-tracer.ts|daemon/src/observability/index.ts",
  "daemon/src/observability/diagnostic-collector.ts|daemon/src/observability/index.ts",
  // Phase 34 plan 01 (DAEMON-API-01) replaces the prior
  // "daemon/src/sub-agent-result-processor.ts|daemon/src/sub-agent-runner.ts"
  // entry with the new @comis/agent/spawn path-pair below.
  "agent/src/spawn/sub-agent-result-processor.ts|agent/src/spawn/sub-agent-runner.ts",
  "gateway/src/oauth/oauth-callback-route.ts|gateway/src/server/hono-server.ts",
  // Phase 33: paths retargeted skills/src/integrations/ -> skills/src/tools/integrations/
  // (file moves preserved the cycles; baseline tracks paths, not behavior).
  "skills/src/tools/integrations/media-handler-audio.ts|skills/src/tools/integrations/media-handler-factory.ts|skills/src/tools/integrations/media-preprocessor.ts",
  "skills/src/tools/integrations/media-handler-audio.ts|skills/src/tools/integrations/media-preprocessor.ts",
  "skills/src/tools/integrations/media-handler-document.ts|skills/src/tools/integrations/media-preprocessor.ts",
  "skills/src/tools/integrations/media-handler-image.ts|skills/src/tools/integrations/media-preprocessor.ts",
  "skills/src/tools/integrations/media-handler-video.ts|skills/src/tools/integrations/media-preprocessor.ts",
]);

/**
 * Canonicalize a madge cycle (an array of file paths) into a sortable,
 * order-insensitive key for matching against BASELINE_INTRA_PACKAGE_CYCLES.
 */
function canonicalizeCycle(cycle: readonly string[]): string {
  return [...cycle].sort().join("|");
}

describe("no-cycles -- intra-package via madge (ARCH-BASE-05, source mode)", () => {
  it("packages/*/src introduces no NEW source-level circular import paths beyond the Phase 27 baseline", async () => {
    const rootPaths = WORKSPACE_PACKAGES.map((p) =>
      resolve(REPO_ROOT, `packages/${p}/src`),
    );
    const result = await madge(rootPaths, {
      tsConfig: TSCONFIG_MADGE,
      fileExtensions: ["ts"],
      detectiveOptions: {
        ts: {
          skipTypeImports: false,
          mixedImports: true,
        },
      },
    });
    const cycles = result.circular();
    const newCycles = cycles.filter(
      (c) => !BASELINE_INTRA_PACKAGE_CYCLES.has(canonicalizeCycle(c)),
    );
    expect(
      newCycles,
      formatViolations({
        description:
          "madge detected NEW source-level circular import paths in packages/*/src that are not in the Phase 27 BASELINE_INTRA_PACKAGE_CYCLES allowlist.",
        violations: newCycles.map((cycle) => ({
          file: "(intra-package cycle)",
          line: 0,
          snippet: cycle.join(" -> "),
        })),
        suggestedFix:
          "Break the cycle by extracting shared types to @comis/core/ports, or by inverting one of the import directions. Type-only imports still count — consider `import type { ... }` to break runtime cycles, but architecture cycles still fail this rule.",
        designRef:
          "design §2.2 / §4.4 step 5a (madge dual-mode invariant; dist-mode lives in .github/workflows/ci.yml per Plan 02 Task 3)",
        allowlistRef:
          "BASELINE_INTRA_PACKAGE_CYCLES (Phase 27 baseline — 46 entries; shrink-only by convention)",
      }),
    ).toEqual([]);
  });
});

describe("no-cycles -- cross-package via Tarjan SCC (ARCH-BASE-05)", () => {
  it("tsconfig refs + package.json @comis/* deps form an acyclic graph", () => {
    const nodes = new Set<string>(WORKSPACE_PACKAGES);
    const edges = new Map<string, Set<string>>();

    for (const pkg of WORKSPACE_PACKAGES) {
      const tsconfig = JSON.parse(
        readFileSync(
          resolve(REPO_ROOT, `packages/${pkg}/tsconfig.json`),
          "utf8",
        ),
      ) as {
        references?: Array<{ path?: string }>;
      };
      const pkgJson = JSON.parse(
        readFileSync(
          resolve(REPO_ROOT, `packages/${pkg}/package.json`),
          "utf8",
        ),
      ) as {
        dependencies?: Record<string, string>;
      };
      const refs = (tsconfig.references ?? [])
        .map((r) => r.path ?? "")
        .filter((p) => p.startsWith("../"))
        .map((p) => p.slice("../".length));
      const deps = Object.keys(pkgJson.dependencies ?? {})
        .filter((k) => k.startsWith("@comis/"))
        .map((k) => k.slice("@comis/".length));
      const out = new Set<string>([
        ...refs.filter((d) =>
          (WORKSPACE_PACKAGES as readonly string[]).includes(d),
        ),
        ...deps.filter((d) =>
          (WORKSPACE_PACKAGES as readonly string[]).includes(d),
        ),
      ]);
      edges.set(pkg, out);
    }

    // findCycles returns SCCs of size > 1 OR self-loops.
    const cycles = findCycles<string>(nodes, edges);
    expect(
      cycles,
      formatViolations({
        description:
          "Cross-package cycles detected in tsconfig refs + package.json @comis/* deps.",
        violations: cycles.map((cycle) => ({
          file: "(cross-package cycle)",
          line: 0,
          snippet: cycle.join(" -> "),
        })),
        suggestedFix:
          "Cross-package cycles cause stale-build risks (tsbuildinfo poisoning per RES-PIT-2) and runtime cycles. Break the cycle by extracting shared types to @comis/core/ports OR moving the consumer to a different package.",
        designRef: "design §2.2 (target graph is acyclic) / RES-PIT-2",
      }),
    ).toEqual([]);
  });
});
