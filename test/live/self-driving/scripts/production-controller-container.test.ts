import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "production-replay-controller.sh");
const DOCKERFILE = resolve(HERE, "Dockerfile.production-replay-controller");

describe("production replay controller container", () => {
  it("uses one pinned Linux runtime with the required controller toolchain", () => {
    const dockerfile = readFileSync(DOCKERFILE, "utf8");

    expect(dockerfile).toContain(
      "FROM mirror.gcr.io/library/ubuntu@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90",
    );
    expect(dockerfile).toMatch(/apt-get install[^\n]*nodejs[^\n]*openssh-client[^\n]*python3/u);
    expect(dockerfile).toContain("USER 65532:65532");
    expect(dockerfile).toContain("ENTRYPOINT [\"/usr/bin/node\", \"/opt/comis-replay-controller/controller.mjs\"]");
    expect(dockerfile).toContain("sha256sum -c -");
    expect(dockerfile).not.toMatch(/(?:COPY|ADD)\s+.*(?:\.live-env|\.ssh|known_hosts|id_rsa|id_ed25519)/u);
  });

  it("builds a content-bound bundle and mounts only explicit controller inputs", () => {
    const runner = readFileSync(RUNNER, "utf8");
    const syntax = spawnSync("bash", ["-n", RUNNER], { encoding: "utf8" });

    expect(syntax.status, syntax.stderr).toBe(0);
    expect(runner).toContain("pnpm exec esbuild");
    expect(runner).toContain("--bundle");
    expect(runner).toContain("--alias:@comis/shared=");
    expect(runner).toContain("CONTROLLER_SHA256");
    expect(runner).toContain("comis-production-replay-controller-v1");
    expect(runner).toContain("/var/lib/comis-replay-controller");
    expect(runner).toContain("/controller/profile.env:ro");
    expect(runner).toContain("/controller/install.sh:ro");
    expect(runner).toContain("/home/comis-replay-controller/.ssh/config:ro");
    expect(runner).toContain("/home/comis-replay-controller/.ssh/known_hosts:ro");
    expect(runner).toContain("/run/comis-replay-controller/ssh-agent.sock");
    expect(runner).not.toMatch(/(?:^|\s)(?:source|\.)\s+.*\.live-env/mu);
    expect(runner).not.toContain("docker.sock");
  });

  it("runs without ambient privilege or host exposure and preserves signal forwarding", () => {
    const runner = readFileSync(RUNNER, "utf8");

    for (const required of [
      "--read-only",
      "--cap-drop=ALL",
      "no-new-privileges:true",
      "--pids-limit=128",
      "--memory=1073741824",
      "--user=65532:65532",
      "--init",
      "--network=bridge",
    ]) {
      expect(runner).toContain(required);
    }
    expect(runner).toContain('docker_pid="$!"');
    expect(runner).toContain('wait "$docker_pid"');
    expect(runner).toContain('kill -0 "$docker_pid"');
    expect(runner).not.toContain("--privileged");
    expect(runner).not.toContain("--network=host");
    expect(runner).not.toMatch(/(?:^|\s)-(?:p|P)(?:\s|$)/mu);
  });

  it("refuses caller path overrides and validates every mounted authority file", () => {
    const runner = readFileSync(RUNNER, "utf8");

    expect(runner).toContain('"--env"|"--installer"');
    expect(runner).toContain("COMIS_REPLAY_SSH_CONFIG");
    expect(runner).toContain("COMIS_REPLAY_KNOWN_HOSTS");
    expect(runner).toContain("SSH_AUTH_SOCK");
    expect(runner).toContain("-L");
    expect(runner).toContain("stat -c");
    expect(runner).toContain("chmod 0600");
  });
});
