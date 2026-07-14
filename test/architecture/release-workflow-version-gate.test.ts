import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const repoRoot = resolve(__dirname, "..", "..");
const scriptPath = join(repoRoot, ".github", "scripts", "verify-release-tag.mjs");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

describe("release workflows reject tags that disagree with the package version", () => {
  it("the shared gate accepts the current package tag and rejects a mismatched tag", () => {
    const version = JSON.parse(read("packages/comis/package.json")) as { version: string };
    expect(() => execFileSync("node", [scriptPath, `v${version.version}`], { cwd: repoRoot })).not.toThrow();

    const mismatch = spawnSync("node", [scriptPath, "v0.0.0"], { cwd: repoRoot, encoding: "utf8" });
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toMatch(/does not match.*package version/i);
  });

  it("the npm workflow runs the shared gate before publishing", () => {
    const source = read(".github/workflows/npm-publish.yml");
    const gate = source.indexOf("node .github/scripts/verify-release-tag.mjs");
    const publication = source.indexOf("pnpm publish");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(publication);
  });

  it("every Docker publishing job has an exact dependency on the version preflight", () => {
    const workflow = parseYaml(read(".github/workflows/dockerhub-release.yml")) as {
      jobs: Record<string, { needs?: string | string[]; steps?: Array<{ run?: string; uses?: string }> }>;
    };
    expect(
      workflow.jobs.preflight.steps?.some((step) =>
        step.run?.includes("node .github/scripts/verify-release-tag.mjs"),
      ),
    ).toBe(true);
    expect(workflow.jobs.build.needs).toBe("preflight");
    expect(workflow.jobs["build-web"].needs).toBe("preflight");

    const ghcrWorkflow = parseYaml(read(".github/workflows/docker-release.yml")) as {
      jobs: Record<string, { needs?: string | string[]; steps?: Array<{ run?: string; uses?: string }> }>;
    };
    expect(
      ghcrWorkflow.jobs.preflight.steps?.some((step) =>
        step.run?.includes("node .github/scripts/verify-release-tag.mjs"),
      ),
    ).toBe(true);
    expect(ghcrWorkflow.jobs.build.needs).toBe("preflight");
    expect(ghcrWorkflow.jobs["build-web"].needs).toBe("preflight");
  });

  it("creates the GitHub release only after Docker artifacts and npm publishing succeed", () => {
    expect(existsSync(join(repoRoot, ".github", "workflows", "release.yml"))).toBe(false);
    const workflow = parseYaml(read(".github/workflows/dockerhub-release.yml")) as {
      jobs: Record<string, { needs?: string | string[]; steps?: Array<{ name?: string; run?: string; uses?: string }> }>;
    };
    const releaseJob = workflow.jobs["github-release"];
    expect(releaseJob.needs).toEqual(expect.arrayContaining([
      "merge-default",
      "merge-slim",
      "build-web",
    ]));
    const waitIndex = releaseJob.steps?.findIndex((step) =>
      step.name?.toLowerCase().includes("npm publish"),
    ) ?? -1;
    const publishIndex = releaseJob.steps?.findIndex((step) =>
      step.uses?.startsWith("softprops/action-gh-release@"),
    ) ?? -1;
    expect(waitIndex).toBeGreaterThanOrEqual(0);
    expect(releaseJob.steps?.[waitIndex]?.run).toContain("npm-publish.yml");
    expect(releaseJob.steps?.[waitIndex]?.run).toContain("docker-release.yml");
    expect(releaseJob.steps?.[waitIndex]?.run).toContain("GITHUB_REF_NAME");
    expect(releaseJob.steps?.[waitIndex]?.run).toMatch(/head_branch\s*==\s*\$ref/);
    expect(releaseJob.steps?.[waitIndex]?.run).toMatch(/conclusion[^\n]*success|success[^\n]*conclusion/i);
    expect(publishIndex).toBeGreaterThan(waitIndex);
  });
});
