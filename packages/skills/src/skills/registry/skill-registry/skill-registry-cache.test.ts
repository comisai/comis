// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for discovery enrichment: stamping `source: "imported"` from the
 * provenance store.
 *
 * A matched skill is demoted to the imported trust tier EXPLICITLY (the
 * `learned` precedent) — advisory DOWNWARD only: an unmatched skill keeps its
 * path-derived source, and an empty lookup never elevates one. The SDK-source
 * mapping carries `learned` + `imported` through (the latent omission fix).
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SkillsConfig, TypedEventBus } from "@comis/core";
import { createSkillRegistry } from "./index.js";
import type { SdkSkill } from "./skill-registry-types.js";

function mockBus(): TypedEventBus {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as unknown as TypedEventBus;
}

const auditCtx = { agentId: "agent-1", tenantId: "t1", userId: "system" };

function makeConfig(discoveryPaths: string[]): SkillsConfig {
  return {
    discoveryPaths,
    promptSkills: { maxBodyLength: 20_000, enableDynamicContext: false, maxAutoInject: 3 },
  } as unknown as SkillsConfig;
}

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "registry-enrich-"));
}

function writePromptSkill(dir: string, name: string, description: string): void {
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: "${description}"\ntype: prompt\n---\n\n# ${name}\n`,
    "utf-8",
  );
}

describe("discovery enrichment — source:imported", () => {
  it("stamps a provenance-matched skill source:imported, leaving an unmatched skill's path-derived source", () => {
    const dir = mkTmp();
    writePromptSkill(dir, "imported-me", "an imported skill");
    writePromptSkill(dir, "plain-one", "a path-derived skill");

    const importedLookup = (): ReadonlySet<string> => new Set(["imported-me"]);
    const registry = createSkillRegistry(makeConfig([dir]), mockBus(), auditCtx, undefined, undefined, importedLookup);
    registry.init();

    const descs = registry.getPromptSkillDescriptions();
    const byName = new Map(descs.map((d) => [d.name, d.source]));
    expect(byName.get("imported-me")).toBe("imported");
    // Advisory downward: an unmatched skill keeps its path-derived source (single
    // discovery path ⇒ "bundled"), never elevated by the store.
    expect(byName.get("plain-one")).toBe("bundled");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an empty lookup never elevates (absence keeps the path-derived source)", () => {
    const dir = mkTmp();
    writePromptSkill(dir, "solo", "a skill");

    const registry = createSkillRegistry(makeConfig([dir]), mockBus(), auditCtx, undefined, undefined, () => new Set<string>());
    registry.init();

    expect(registry.getPromptSkillDescriptions().find((d) => d.name === "solo")?.source).toBe("bundled");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the SDK-source mapping carries learned + imported through", () => {
    const registry = createSkillRegistry(makeConfig([]), mockBus(), auditCtx);
    const sdk = (name: string, source: string): SdkSkill => ({
      name,
      description: `${name} desc`,
      filePath: `/nonexistent/${name}/SKILL.md`,
      baseDir: `/nonexistent/${name}`,
      source,
      disableModelInvocation: false,
    });
    registry.initFromSdkSkills([
      sdk("b", "bundled"),
      sdk("l", "local"),
      sdk("le", "learned"),
      sdk("im", "imported"),
      sdk("w", "something-else"),
    ]);

    const bySource = new Map(registry.getAllMetadata().map((m) => [m.name, m.source]));
    expect(bySource.get("b")).toBe("bundled");
    expect(bySource.get("l")).toBe("local");
    expect(bySource.get("le")).toBe("learned");
    expect(bySource.get("im")).toBe("imported");
    expect(bySource.get("w")).toBe("workspace");
  });
});
