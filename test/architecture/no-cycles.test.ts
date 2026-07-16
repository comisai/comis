// SPDX-License-Identifier: Apache-2.0
/**
 * No-cycles invariants.
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
 * The DIST-MODE madge gate AND `tsc -b --dry` gate (the third belt) live in
 * .github/workflows/ci.yml as post-`pnpm build` CI steps — NOT here, since
 * they require dist/ artifacts.
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
 * BASELINE_INTRA_PACKAGE_CYCLES — pre-existing within-package cycles
 * recorded as an allowlist so the gate is GREEN at landing while still
 * catching ANY new cycle. Entries are removed as the underlying cycles
 * are broken.
 *
 * madge source-mode walks `.ts` import statements (mixed value + type) and
 * reports cycles.
 *
 * Format: each entry is the cycle's MEMBER FILES sorted alphabetically and
 * joined by `|`. The canonicalization is required because madge reports
 * cycles starting from arbitrary entry points (e.g., `[a, b]` vs `[b, a]`),
 * so the matching is order-insensitive but member-set-sensitive. Adding a
 * new file to an existing cycle (or a new file that introduces a different
 * cycle) produces a different canonical key and trips the gate.
 *
 * NOTE on dist-mode parity: dist-mode madge (CI gate) walks `.d.ts` and
 * reports a different cycle set. The two are complementary; this baseline
 * is for source mode only.
 */
const BASELINE_INTRA_PACKAGE_CYCLES: ReadonlySet<string> = new Set([
  "agent/src/bootstrap/sections/tool-descriptions.ts|agent/src/bootstrap/sections/tooling-sections.ts",
  "agent/src/context-engine/types-compaction.ts|agent/src/context-engine/types-core.ts",
  "agent/src/executor/executor-post-execution.ts|agent/src/executor/pi-executor.ts",
  "agent/src/model/oauth-device-code.ts|agent/src/model/oauth-login-runner.ts",
  // oauth-device-code + oauth-login-runner have both an agent-side and a
  // core-side cycle entry. The intra-pair cycle (login-runner's device-code
  // dispatch ↔ device-code's LoginError type-import) is preserved verbatim
  // under both paths until the agent-side source files are deleted.
  "core/src/oauth/oauth-device-code.ts|core/src/oauth/oauth-login-runner.ts",
  // File moves under channels/src/shared/ -> orchestrator/src/{inbound,execution}/
  // preserved the cycles; baseline tracks paths, not behavior.
  "orchestrator/src/execution/execution-deliver.ts|orchestrator/src/execution/execution-pipeline.ts",
  "orchestrator/src/execution/execution-execute.ts|orchestrator/src/execution/execution-pipeline.ts",
  "orchestrator/src/execution/execution-filter.ts|orchestrator/src/execution/execution-pipeline.ts",
  // The former execution-policy body was inlined into execution-pipeline;
  // the corresponding cycle entry (execution-pipeline|execution-policy)
  // is removed — net shrink of 1.
  "orchestrator/src/inbound/inbound-gate.ts|orchestrator/src/inbound/inbound-pipeline.ts",
  // inbound-resolve.ts + inbound-preprocess.ts were merged into
  // resolve-and-preprocess.ts; the two pre-collapse cycle entries
  // (inbound-pipeline|inbound-preprocess and inbound-pipeline|inbound-resolve)
  // became the single entry below.
  "orchestrator/src/inbound/inbound-pipeline.ts|orchestrator/src/inbound/resolve-and-preprocess.ts",
  // inbound-setup.ts + inbound-route.ts were merged into setup-and-route.ts;
  // the two pre-collapse cycle entries (inbound-pipeline|inbound-setup and
  // inbound-pipeline|inbound-route) became the single entry below.
  "orchestrator/src/inbound/inbound-pipeline.ts|orchestrator/src/inbound/setup-and-route.ts",
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
  // sub-agent-runner.ts + sub-agent-result-processor.ts live under
  // @comis/agent/spawn; the intra-pair cycle is preserved verbatim under
  // the path entry below.
  "daemon/src/observability/channel-activity-tracker.ts|daemon/src/observability/index.ts",
  "daemon/src/observability/channel-activity-tracker.ts|daemon/src/observability/index.ts|daemon/src/observability/obs-persistence-wiring.ts",
  "daemon/src/observability/context-pipeline-collector.ts|daemon/src/observability/index.ts",
  "daemon/src/observability/delivery-tracer.ts|daemon/src/observability/index.ts",
  "daemon/src/observability/diagnostic-collector.ts|daemon/src/observability/index.ts",
  "agent/src/spawn/sub-agent-result-processor.ts|agent/src/spawn/sub-agent-runner.ts",
  "gateway/src/oauth/oauth-callback-route.ts|gateway/src/server/hono-server.ts",
  // File moves under skills/src/integrations/ -> skills/src/tools/integrations/
  // preserved the cycles; baseline tracks paths, not behavior.
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

describe("no-cycles -- intra-package via madge (source mode)", () => {
  // The full-workspace madge source scan has exceeded the project's 120s
  // default on a saturated release runner (observed during the v1.0.54
  // npm-publish validation) — give it its own generous ceiling.
  it("packages/*/src introduces no NEW source-level circular import paths beyond the recorded baseline", { timeout: 360_000 }, async () => {
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
          "madge detected NEW source-level circular import paths in packages/*/src that are not in the BASELINE_INTRA_PACKAGE_CYCLES allowlist.",
        violations: newCycles.map((cycle) => ({
          file: "(intra-package cycle)",
          line: 0,
          snippet: cycle.join(" -> "),
        })),
        suggestedFix:
          "Break the cycle by extracting shared types to @comis/core/ports, or by inverting one of the import directions. Type-only imports still count — consider `import type { ... }` to break runtime cycles, but architecture cycles still fail this rule.",
        designRef:
          "madge dual-mode invariant (dist-mode runs in .github/workflows/ci.yml)",
        allowlistRef:
          "BASELINE_INTRA_PACKAGE_CYCLES (shrink-only by convention)",
      }),
    ).toEqual([]);
  });
});

describe("no-cycles -- cross-package via Tarjan SCC", () => {
  it("verifies tsconfig references + package.json @comis/* deps form an acyclic graph via Tarjan SCC", () => {
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
          "Cross-package cycles cause stale-build risks (tsbuildinfo poisoning) and runtime cycles. Break the cycle by extracting shared types to @comis/core/ports OR moving the consumer to a different package.",
        designRef: "target graph is acyclic",
      }),
    ).toEqual([]);
  });
});
