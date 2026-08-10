// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const runnerRoot = resolve(repoRoot, "test/confinement-runner");
const dockerfilePath = resolve(runnerRoot, "Dockerfile");
const containerGatePath = resolve(runnerRoot, "run-spike-gate.sh");
const joinGatePath = resolve(runnerRoot, "run-join-gate.sh");
const launcherPath = resolve(runnerRoot, "wave4-codex-launcher.sh");
const joinScenarioPath = resolve(repoRoot, "test/live/scenarios/capability-service/wave4-join.test.ts");
const hostRunnerPath = resolve(repoRoot, "scripts/run-confinement-runner.sh");

function source(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

describe("capability-service Linux confinement runner", () => {
  it("pins every worker and jail dependency required by the live join", () => {
    const dockerfile = source(dockerfilePath);

    expect(dockerfile).toContain("node:22-bookworm@sha256:");
    expect(dockerfile).toContain("GO_VERSION=1.26.5");
    expect(dockerfile).toContain("go1.26.5.linux-amd64.tar.gz");
    expect(dockerfile).toContain("go1.26.5.linux-arm64.tar.gz");
    expect(dockerfile).toContain("pnpm@10.34.5");
    expect(dockerfile).toContain("@openai/codex@0.147.0");
    expect(dockerfile).toMatch(/apt-get install[\s\S]*bubblewrap/u);
    expect(dockerfile).toMatch(/apt-get install[\s\S]*tmux/u);
    expect(dockerfile).toContain("USER comis");
  });

  it("mounts both source authorities read-write and Codex authentication read-only", () => {
    const runner = source(hostRunnerPath);

    expect(runner).toContain("target=/workspace/comis-dev-crew");
    expect(runner).toContain("target=/workspace/comis");
    expect(runner).toContain("target=/home/comis/.codex/auth.json,readonly");
    expect(runner).not.toMatch(/source=\/[^,]*,target=\/,(?:,|\s)/u);
  });

  it("uses the bounded Docker privilege proven necessary for nested bwrap", () => {
    const runner = source(hostRunnerPath);
    const gate = source(containerGatePath);

    expect(runner).toContain("--privileged");
    expect(runner).not.toContain("--user root");
    expect(runner).not.toContain("unsafeDisableSandbox");
    expect(gate).toContain('test "$(id -u)" -ne 0');
    expect(gate).toContain("bwrap --unshare-all");
    expect(gate).toContain("BWRAP_CONFINEMENT_OK");
  });

  it("runs every Linux suite and the wave-four separate-process proof", () => {
    const gate = source(containerGatePath);

    expect(gate).toContain("pnpm install --frozen-lockfile");
    expect(gate).toContain("pnpm build");
    expect(gate).toContain("*.linux.test.ts");
    expect(gate).toContain(
      "packages/skills/src/tools/builtin/terminal-driver/terminal-worker-fork.linux.test.ts",
    );
  });

  it("runs the live join from an exact clean companion archive", () => {
    const runner = source(hostRunnerPath);
    const joinGate = source(joinGatePath);

    expect(runner).toMatch(/spike \| join \| shell/u);
    expect(joinGate).toContain('readonly DEV_CREW_COMMIT="eb499e6d3c8ee74cefd9a187a488ce49ebe4e645"');
    expect(joinGate).toContain('git -C "${DEV_CREW_SOURCE}" archive "${DEV_CREW_COMMIT}"');
    expect(joinGate).toContain("COMIS_LIVE=1");
    expect(joinGate).toContain("wave4-join.test.ts");
  });

  it("installs a fixed real-Codex wrapper outside both source mounts", () => {
    const dockerfile = source(dockerfilePath);
    const launcher = source(launcherPath);

    expect(dockerfile).toContain("COPY --chmod=0755 test/confinement-runner/wave4-codex-launcher.sh");
    expect(dockerfile).toContain("/usr/local/bin/wave4-codex-launcher");
    expect(launcher).toContain("/usr/local/bin/codex");
    expect(launcher).toContain("DEV_CREW_ATTACHMENT");
    expect(launcher).toContain("devcrew-report acknowledge");
    expect(launcher).toContain("devcrew-report brief");
  });

  it("keeps the launcher alive until managed binding activation completes", () => {
    const launcher = source(launcherPath);
    const barrierOffset = launcher.indexOf('[[ -f "${START_FILE}" ]] && break');
    const attachmentOffset = launcher.indexOf("find /run/comis/attachments");

    expect(barrierOffset).toBeGreaterThan(-1);
    expect(attachmentOffset).toBeGreaterThan(barrierOffset);
  });

  it("validates the protected bind mount without trusting find file types", () => {
    const launcher = source(launcherPath);

    expect(launcher).not.toMatch(/find \/run\/comis\/attachments[^\n]*-type s/u);
    expect(launcher).toContain('test -S "${attachments[0]}"');
  });

  it("uses one authenticated catalog model for the profile and real workers", () => {
    const launcher = source(launcherPath);
    const scenario = source(joinScenarioPath);

    expect(launcher).toContain('--model "${COMIS_WAVE4_CODEX_MODEL:-gpt-5.5}"');
    expect(scenario).toContain('COMIS_WAVE4_CODEX_MODEL"] ?? "gpt-5.5"');
  });

  it("exposes only the read-only Codex auth file to each jail", () => {
    const scenario = source(joinScenarioPath);

    expect(scenario).toContain('credentialPaths: ["~/.codex/auth.json", "/home/comis/.wave4-tools"]');
    expect(scenario).not.toContain('credentialPaths: ["~/.codex",');
  });
});
