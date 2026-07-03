// SPDX-License-Identifier: Apache-2.0
/**
 * GLOBAL SHIP GATE — transparency-suite-green checklist as an
 * executable assertion.
 *
 * This is the terminal lightweight gate. It does NOT re-run the
 * whole suite — that is `pnpm validate`'s job (build && test && lint:security
 * && cycles). Instead it asserts the transparency ANCHORS are still in
 * place, so a future PR that silently removes the transparency-label coverage
 * gate script, the core/observability ⊀ channels boundary lock, the 47-tool
 * registry-parity lock, one of the 10 channel plugins, or the golden
 * fixtures fails THIS test loudly (deterministic, cheap — fs/JSON reads only,
 * no runtime path).
 *
 * Why a checklist-as-test (not a full-suite shell-out): the ship gate is
 * the UNION of existing automated gates + a written security sign-off; no
 * single executable "ship-gate test" is mandated. The
 * transparency-label-coverage gate (`pnpm test:transparency`) already runs
 * under the normal `pnpm test` (it is a `.test.ts` under `packages/skills/`),
 * so this file deliberately omits a fragile shell-out and instead pins that the
 * script IS wired + the anchor files exist. Keeping it free of a child-process
 * spawn also keeps it immune to the known macOS-only O_NOFOLLOW failures
 * elsewhere (session-index / embedding-cache-sqlite) — Linux CI is the
 * authoritative green for the full suite.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/** Read + parse the root package.json once (used by the script-wiring assertion). */
function readRootPackageJson(): { scripts?: Record<string, string> } {
  return JSON.parse(
    readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
}

describe("global ship gate — transparency anchors are present", () => {
  it("wires the pnpm test:transparency coverage gate script pointing at the registry walk", () => {
    const { scripts } = readRootPackageJson();
    const script = scripts?.["test:transparency"];
    expect(
      script,
      "root package.json must expose a `test:transparency` script (the transparency-label coverage gate)",
    ).toBeTruthy();
    // The script must run the live-registry coverage gate, not a stale path.
    expect(
      script,
      "`test:transparency` must point at the transparency-label-coverage gate test",
    ).toContain("transparency-label-coverage");
    // Sanity: the file it points at actually exists on disk.
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          "packages/skills/src/__tests__/transparency-label-coverage.test.ts",
        ),
      ),
      "the transparency-label coverage gate file packages/skills/src/__tests__/transparency-label-coverage.test.ts must exist",
    ).toBe(true);
  });

  it("keeps the core + observability not-importing-channels boundary gate file present", () => {
    const boundaryGate = resolve(
      REPO_ROOT,
      "test/architecture/observability-package-isolation.test.ts",
    );
    expect(
      existsSync(boundaryGate),
      "the core/observability ⊀ channels boundary lock (observability-package-isolation.test.ts) must exist",
    ).toBe(true);
    // It must still contain the renderer-port-in-core lock that mechanically
    // enforces the 'no core/ or observability/ → channels/' rule.
    const src = readFileSync(boundaryGate, "utf8");
    expect(
      src,
      "the boundary gate must still assert neither core nor observability imports @comis/channels",
    ).toMatch(/@comis\/channels/);
  });

  it("keeps the 47-tool registry parity lock file present (label/metadata additions must not change the descriptor set)", () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          "packages/skills/src/__tests__/tool-registry-parity.test.ts",
        ),
      ),
      "the tool-registry-parity lock must exist — it pins the descriptor set so transparency label/suppress additions cannot silently change it",
    ).toBe(true);
  });

  it("confirms all 10 channel plugins are present for the extended-ChannelCapability compile", () => {
    const PLUGINS = [
      "discord",
      "echo",
      "email",
      "imessage",
      "irc",
      "line",
      "signal",
      "slack",
      "telegram",
      "whatsapp",
    ] as const;
    const missing = PLUGINS.filter(
      (ch) =>
        !existsSync(
          resolve(REPO_ROOT, `packages/channels/src/${ch}/${ch}-plugin.ts`),
        ),
    );
    expect(
      missing,
      `every channel plugin must be present (extended ChannelCapability.features compiles across all 10); missing: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("confirms each of the 10 channels has at least one golden fixture (S*.expected.json)", () => {
    const CHANNELS = [
      "discord",
      "echo",
      "email",
      "imessage",
      "irc",
      "line",
      "signal",
      "slack",
      "telegram",
      "whatsapp",
    ] as const;
    // Each channel keeps a per-channel golden-fixture directory with at least
    // one `S*.expected.json` cell. We do NOT enumerate every S-cell here —
    // which cells apply is channel-shape-dependent (e.g. email is DigestOnly
    // and has no S1; some channels have no S8 by design). A wholly-missing or
    // wholly-empty fixture directory is the regression this catches; the
    // channels architecture test owns the full ✓-cell coverage lock.
    const channelsWithoutAnyFixture = CHANNELS.filter((ch) => {
      const dir = resolve(
        REPO_ROOT,
        `packages/channels/src/__tests__/__fixtures__/${ch}`,
      );
      if (!existsSync(dir)) return true;
      return !readdirSync(dir).some(
        (f) => /^S\d+\.expected\.json$/.test(f),
      );
    });
    expect(
      channelsWithoutAnyFixture,
      `every channel must keep its golden fixtures (at least one S*.expected.json); channels missing all golden fixtures: ${channelsWithoutAnyFixture.join(", ")}`,
    ).toEqual([]);
  });
});
