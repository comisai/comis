// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const targetPath = resolve(
  repoRoot,
  "test/live/self-driving/targets/devcrew-multi-project-development.md",
);
const targetIndexPath = resolve(repoRoot, "test/live/self-driving/targets/README.md");
const target = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
const targetIndex = readFileSync(targetIndexPath, "utf8");

interface CampaignProject {
  readonly id: string;
  readonly role: "backend" | "frontend" | "shared" | "worker";
  readonly root: string;
}

interface CampaignWorkItem {
  readonly id: string;
  readonly project: string;
  readonly kind: "feature" | "bug_fix" | "refactor" | "test_backfill" | "dependency_update";
  readonly wave: number;
  readonly profile: "codex-reviewed" | "claude-reviewed";
  readonly dependsOn: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly validationProfile: string;
}

interface CampaignManifest {
  readonly schemaVersion: number;
  readonly systemUnderTest: string;
  readonly rig: string;
  readonly repositoryModel: string;
  readonly maxConcurrentWorkers: number;
  readonly projects: readonly CampaignProject[];
  readonly workItems: readonly CampaignWorkItem[];
  readonly requiredFaults: readonly string[];
}

function readManifest(): CampaignManifest {
  const match = target.match(
    /<!-- devcrew-campaign-manifest:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- devcrew-campaign-manifest:end -->/u,
  );
  expect(match?.[1], "machine-readable DevCrew campaign manifest").toBeDefined();
  return JSON.parse(match?.[1] ?? "{}") as CampaignManifest;
}

function assertAcyclic(workItems: readonly CampaignWorkItem[]): void {
  const dependencies = new Map(workItems.map((item) => [item.id, item.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    expect(visiting.has(id), `dependency cycle at ${id}`).toBe(false);
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      expect(dependencies.has(dependency), `${id} dependency ${dependency}`).toBe(true);
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const item of workItems) visit(item.id);
}

describe("Comis DevCrew multi-project live target", () => {
  it("ships a discoverable target for the Comis and DevCrew integration", () => {
    expect(existsSync(targetPath)).toBe(true);
    expect(targetIndex).toContain("`devcrew-multi-project-development.md`");
    expect(target).toContain("Comis ↔ comis-dev-crew");
    expect(target).toContain("`comis-dev` SSH alias");
  });

  it("pins the honest E0 topology and a bounded concurrent portfolio", () => {
    const manifest = readManifest();

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.systemUnderTest).toBe("comis+comis-dev-crew");
    expect(manifest.rig).toBe("comis-dev");
    expect(manifest.repositoryModel).toBe("single-disposable-monorepo");
    expect(manifest.maxConcurrentWorkers).toBeGreaterThanOrEqual(2);
    expect(manifest.maxConcurrentWorkers).toBeLessThanOrEqual(4);
    expect(manifest.projects).toHaveLength(4);
    expect(new Set(manifest.projects.map((project) => project.id)).size).toBe(4);
    expect(new Set(manifest.projects.map((project) => project.role))).toEqual(
      new Set(["backend", "frontend", "shared", "worker"]),
    );
    expect(new Set(manifest.projects.map((project) => project.root)).size).toBe(4);

    expect(target).toContain("E0 does not provide a cross-repository dependency scheduler");
    expect(target).toContain("Comis liaison owns the portfolio plan");
  });

  it("covers realistic development work with valid dependency waves", () => {
    const manifest = readManifest();
    const projectIds = new Set(manifest.projects.map((project) => project.id));
    const workKinds = new Set(manifest.workItems.map((item) => item.kind));

    expect(manifest.workItems.length).toBeGreaterThanOrEqual(8);
    expect(workKinds).toEqual(
      new Set(["feature", "bug_fix", "refactor", "test_backfill", "dependency_update"]),
    );
    expect(new Set(manifest.workItems.map((item) => item.id)).size).toBe(manifest.workItems.length);
    expect(new Set(manifest.workItems.map((item) => item.profile))).toEqual(
      new Set(["codex-reviewed", "claude-reviewed"]),
    );

    for (const item of manifest.workItems) {
      expect(projectIds.has(item.project), item.id).toBe(true);
      expect(item.allowedPaths.length, item.id).toBeGreaterThan(0);
      expect(item.validationProfile.length, item.id).toBeGreaterThan(0);
      for (const allowedPath of item.allowedPaths) {
        expect(allowedPath.startsWith("/"), `${item.id}:${allowedPath}`).toBe(false);
        expect(allowedPath.includes(".."), `${item.id}:${allowedPath}`).toBe(false);
      }
    }
    assertAcyclic(manifest.workItems);

    const waves = new Map<number, CampaignWorkItem[]>();
    for (const item of manifest.workItems) {
      const wave = waves.get(item.wave) ?? [];
      wave.push(item);
      waves.set(item.wave, wave);
    }
    expect(waves.size).toBeGreaterThanOrEqual(3);
    for (const [wave, items] of waves) {
      expect(items.length, `wave ${wave}`).toBeLessThanOrEqual(manifest.maxConcurrentWorkers);
    }
    const parallelRoles = new Set(
      (waves.get(1) ?? []).map(
        (item) => manifest.projects.find((project) => project.id === item.project)?.role,
      ),
    );
    expect(parallelRoles.has("backend")).toBe(true);
    expect(parallelRoles.has("frontend")).toBe(true);
  });

  it("requires concurrency, recovery, validation, and cleanup failure oracles", () => {
    const manifest = readManifest();
    expect(new Set(manifest.requiredFaults)).toEqual(new Set([
      "concurrency_ceiling",
      "worker_exit_without_report",
      "required_validation_red",
      "restart_with_pending_outbox",
      "stale_forge_head",
      "dirty_cleanup_refusal",
    ]));

    for (const heading of [
      "## Ground-truth requirements",
      "## Concurrency plan and oracles",
      "## Failure-injection matrix",
      "## Cross-project integration oracle",
      "## Cyber-abuse classification",
      "## Completion bar",
    ]) {
      expect(target).toContain(heading);
    }
    expect(target).toContain("overlap interval");
    expect(target).toContain("zero false successes");
    expect(target).toContain("NOT-RUN: provider cyber-abuse safety suspension");
  });
});
