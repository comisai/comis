// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const runnerRoot = resolve(repoRoot, "test/confinement-runner");
const dockerignorePath = resolve(repoRoot, ".dockerignore");
const dockerfilePath = resolve(runnerRoot, "Dockerfile");
const containerGatePath = resolve(runnerRoot, "run-spike-gate.sh");
const joinGatePath = resolve(runnerRoot, "run-join-gate.sh");
const mechanicsGatePath = resolve(runnerRoot, "run-e0-mechanics-gate.sh");
const journeyObservationPath = resolve(runnerRoot, "run-e0-journey.sh");
const launcherPath = resolve(runnerRoot, "wave4-codex-launcher.sh");
const journeyLauncherPath = resolve(runnerRoot, "e0-codex-launcher.sh");
const reporterCapturePath = resolve(runnerRoot, "wave4-report-capture.sh");
const reporterClientDiagnosticPath = resolve(runnerRoot, "wave4-reporter-client-diagnostic.go");
const joinScenarioPath = resolve(repoRoot, "test/live/scenarios/capability-service/wave4-join.test.ts");
const mechanicsScenarioPath = resolve(repoRoot, "test/live/scenarios/capability-service/e0-mechanics.test.ts");
const journeyScenarioPath = resolve(repoRoot, "test/live/scenarios/capability-service/e0-journey.test.ts");
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
    expect(runner).toContain("target=/home/comis/.comis/models");
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

    expect(runner).toMatch(/spike \| join \| mechanics \| observe \| shell/u);
    expect(joinGate).toContain('readonly DEV_CREW_COMMIT="602c8dd1b438f761cf0747373fe9b7551af3e021"');
    expect(joinGate).toContain('git -C "${DEV_CREW_SOURCE}" archive "${DEV_CREW_COMMIT}"');
    expect(joinGate).toContain("COMIS_LIVE=1");
    expect(joinGate).toContain("wave4-join.test.ts");
  });

  it("runs deterministic E0 mechanics from a separate exact clean companion archive", () => {
    const runner = source(hostRunnerPath);
    const mechanicsGate = source(mechanicsGatePath);
    const scenario = source(mechanicsScenarioPath);

    expect(runner).toMatch(/spike \| join \| mechanics \| observe \| shell/u);
    expect(mechanicsGate).toMatch(/readonly DEV_CREW_COMMIT="[a-f0-9]{40}"/u);
    expect(mechanicsGate).toContain('git -C "${DEV_CREW_SOURCE}" archive "${DEV_CREW_COMMIT}"');
    expect(mechanicsGate).toContain("COMIS_E0_MECHANICS=1");
    expect(mechanicsGate).toContain("e0-mechanics.test.ts");
    expect(mechanicsGate).toContain("E0_MECHANICS_GATE_PASS");
    expect(mechanicsGate).not.toContain("COMIS_E0_FULL");
    expect(mechanicsGate).not.toContain("COMIS_E0_JOURNEY");
    expect(mechanicsGate).not.toContain("CODEX_HOME");
    expect(scenario).toContain("wave4-join.test.js");
    expect(scenario).toContain('workerProfileId: "fixture-worker"');
    expect(scenario).toContain('"--fixture-worker"');
    expect(scenario).toContain('"--fixture-artifact", "report.md"');
    expect(scenario).not.toContain('tool: "terminal_session_create"');
    expect(scenario).toContain("RESTART_DAEMON_AND_SERVICE_MID_FLIGHT");
    expect(scenario).toContain("FORGE_TRUTH_HELD_BEFORE_RELEASE");
    expect(scenario).toContain("EXACTLY_ONCE_SHIP_AND_SCOUT_DELIVERY");
    expect(scenario).toContain("CLEANUP_HOLD_REFUSED");
    expect(scenario).toContain("DIRTY_WORKTREE_CLEANUP_REFUSED");
    expect(scenario).toContain("FINAL_CLEANUP_COMPLETED");
    expect(source(joinScenarioPath)).toContain('arguments_.push("--candidate-config", input.candidateConfig)');
    expect(source(joinScenarioPath)).toContain("const candidateConfig = createCandidateConfig(scratch);");
    expect(source(joinScenarioPath)).toContain('      "evidence",');
  });

  it("keeps real Codex ship completion explicitly observation only", () => {
    const dockerfile = source(dockerfilePath);
    const dockerignore = source(dockerignorePath);
    const launcher = source(journeyLauncherPath);
    const scenario = source(journeyScenarioPath);
    const observation = source(journeyObservationPath);
    const runner = source(hostRunnerPath);

    expect(dockerfile).toContain("COPY --chmod=0755 test/confinement-runner/e0-codex-launcher.sh");
    expect(dockerignore).toContain("!test/confinement-runner/e0-codex-launcher.sh");
    expect(dockerfile).toContain("/usr/local/bin/e0-codex-launcher");
    expect(launcher).toContain("devcrew-report decision");
    expect(launcher).toContain("devcrew-report resolved");
    expect(launcher).toContain("devcrew-report paused");
    expect(scenario).toContain('["ship", "pull_request"]');
    expect(scenario).toContain('["scout", "report"]');
    expect(scenario).toContain("RESTART_DAEMON_AND_SERVICE_MID_FLIGHT");
    expect(scenario).not.toContain("RESTART_DAEMON_AND_SERVICE_AFTER_DELIVERY");
    expect(scenario).toContain("process.env[CONTROL_SECRET_NAME] = CONTROL_SECRET");
    expect(scenario).toContain('process.env[PROVIDER_SECRET_NAME] = "fixture-provider-key"');
    expect(scenario).toContain('normalizedMessage(`/attention ${attention.attentionId} ${E0_DECISION_ANSWER}`)');
    expect(scenario).toContain('status === "response_pending"');
    expect(scenario).toContain('status === "resolved"');
    expect(scenario).toContain("handback_task");
    expect(scenario).toContain("task_cleanup_holds");
    expect(scenario).toContain("DIRTY_WORKTREE_CLEANUP_REFUSED");
    expect(scenario).toContain("cleanup_task");
    expect(scenario).toContain("NETWORK_CONFINEMENT_NOT_PROVEN");
    expect(runner).toContain('if [[ "${mode}" == "observe" ]]');
    expect(observation).toContain("COMIS_E0_OBSERVE=1");
    expect(observation).toContain("E0_CODEX_JOURNEY_OBSERVATION_COMPLETE");
    expect(observation).not.toContain("GATE_PASS");
  });

  it("installs a fixed real-Codex wrapper outside both source mounts", () => {
    const dockerfile = source(dockerfilePath);
    const launcher = source(launcherPath);

    expect(dockerfile).toContain("COPY --chmod=0755 test/confinement-runner/wave4-codex-launcher.sh");
    expect(dockerfile).toContain("/usr/local/bin/wave4-codex-launcher");
    expect(launcher).toContain("/usr/local/bin/codex");
    expect(launcher).toContain("COMIS_EXECUTION_ATTACHMENT");
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
    expect(launcher).toContain('export COMIS_EXECUTION_ATTACHMENT_TARGET_NAME="${own_attachment##*/}"');
  });

  it("uses one authenticated catalog model for the profile and real workers", () => {
    const launcher = source(launcherPath);
    const scenario = source(joinScenarioPath);

    expect(launcher).toContain('--model "${COMIS_WAVE4_CODEX_MODEL:-gpt-5.5}"');
    expect(scenario).toContain('COMIS_WAVE4_CODEX_MODEL"] ?? "gpt-5.5"');
  });

  it("keeps the real Codex workspace sandbox inside the enclosing bubblewrap jail", () => {
    const launcher = source(launcherPath);
    const scenario = source(joinScenarioPath);

    expect(launcher).toContain("--sandbox workspace-write");
    expect(launcher).toContain("sandbox_workspace_write.network_access=true");
    expect(launcher).not.toContain("--sandbox danger-full-access");
    expect(scenario).toContain('filesystem: "workspace"');
    expect(scenario).toContain("siblingReadBlocked: true, siblingWriteBlocked: true, siblingAttachmentAbsent: true");
  });

  it("exposes only the read-only Codex auth file to each jail", () => {
    const scenario = source(joinScenarioPath);

    expect(scenario).toContain('credentialPaths: ["~/.codex/auth.json", "/home/comis/.wave4-tools"]');
    expect(scenario).not.toContain('credentialPaths: ["~/.codex",');
  });

  it("gives real workers the bounded report-grade join budget", () => {
    const scenario = source(joinScenarioPath);

    expect(scenario).toContain("const REAL_WORKER_JOIN_TIMEOUT_MS = 180_000;");
    expect(scenario).toContain("}, REAL_WORKER_JOIN_TIMEOUT_MS, `joined working state;");
  });

  it("surfaces durable launch acknowledgement evidence on a failed join", () => {
    const dockerignore = source(dockerignorePath);
    const dockerfile = source(dockerfilePath);
    const launcher = source(launcherPath);
    const reporterCapture = source(reporterCapturePath);
    const reporterClientDiagnostic = source(reporterClientDiagnosticPath);
    const scenario = source(joinScenarioPath);

    expect(dockerfile).toContain("wave4-report-capture.sh");
    expect(dockerignore).toContain("!test/confinement-runner/wave4-report-capture.sh");
    expect(dockerignore).toContain("!test/confinement-runner/wave4-reporter-client-diagnostic.go");
    expect(dockerfile).toContain("wave4-reporter-client-diagnostic.go");
    expect(launcher).toContain("/usr/local/lib/wave4");
    expect(launcher).toContain(".wave4-client-diagnostic.log");
    expect(reporterCapture).toContain(".wave4-reporter.log");
    expect(reporterClientDiagnostic).toContain("client.Brief");
    expect(scenario).toContain("clientDiagnostic");
    expect(scenario).toContain("reporterDiagnostic");
    expect(scenario).toContain("failedJoinDurableDiagnostic");
    expect(scenario).toContain("task_launch_acknowledgements");
    expect(scenario).toContain("operation_replay_conflicts");
  });
});
