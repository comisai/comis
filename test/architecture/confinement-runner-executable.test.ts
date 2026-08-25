// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPORT_CAPTURE = fileURLToPath(new URL("../confinement-runner/wave4-report-capture.sh", import.meta.url));
const REPORTER_DIAGNOSTIC = fileURLToPath(
  new URL("../confinement-runner/wave4-reporter-client-diagnostic.go", import.meta.url),
);
const RUNNER = fileURLToPath(new URL("../../scripts/run-confinement-runner.sh", import.meta.url));
const LIVE_GATES = [
  fileURLToPath(new URL("../confinement-runner/run-join-gate.sh", import.meta.url)),
  fileURLToPath(new URL("../confinement-runner/run-e0-journey.sh", import.meta.url)),
  fileURLToPath(new URL("../confinement-runner/run-e0-mechanics-gate.sh", import.meta.url)),
];
const temporaryDirectories: string[] = [];

function scratch(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createCompanionRepository(root: string): string {
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test User"]);
  writeFileSync(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("confinement runner executable fixtures", () => {
  it("holds candidate reports only while the explicit barrier exists", async () => {
    expect(statSync(REPORT_CAPTURE).mode & 0o111).not.toBe(0);
    const root = scratch("confinement-report-");
    const reporter = join(root, "reporter");
    const calls = join(root, "calls");
    writeFileSync(reporter, "#!/bin/bash\nprintf '%s\\n' \"$*\" >> \"$REPORT_CALLS\"\n", { mode: 0o700 });
    chmodSync(reporter, 0o700);
    const env = { ...process.env, WAVE4_REAL_REPORTER: reporter, REPORT_CALLS: calls };

    const direct = spawnSync(REPORT_CAPTURE, ["candidate-complete", "direct"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    expect(direct.status, direct.stderr).toBe(0);
    expect(readFileSync(calls, "utf8")).toContain("candidate-complete direct");

    writeFileSync(join(root, ".wave4-candidate-barrier"), "hold\n");
    const held = spawn(REPORT_CAPTURE, ["candidate-complete", "held"], { cwd: root, env });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(readFileSync(calls, "utf8")).not.toContain("candidate-complete held");
    writeFileSync(join(root, ".wave4-candidate-release"), "release\n");
    const status = await new Promise<number | null>((resolve) => held.once("close", resolve));
    expect(status).toBe(0);
    expect(readFileSync(calls, "utf8")).toContain("candidate-complete held");
  });

  it("passes the exact clean companion revision into the container", () => {
    const root = scratch("confinement-runner-");
    const companion = join(root, "companion");
    const bin = join(root, "bin");
    const capture = join(root, "docker-args");
    mkdirSync(companion);
    mkdirSync(bin);
    const revision = createCompanionRepository(companion);
    writeFileSync(join(bin, "docker"), "#!/bin/bash\nprintf '%s\\n' \"$@\" > \"$DOCKER_CAPTURE\"\n", {
      mode: 0o700,
    });

    const result = spawnSync("bash", [RUNNER, "mechanics"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        COMIS_DEV_CREW_ROOT: companion,
        COMIS_CONFINEMENT_SKIP_BUILD: "1",
        DOCKER_CAPTURE: capture,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(capture, "utf8").split("\n")).toContain(
      `COMIS_DEV_CREW_COMMIT=${revision}`,
    );
  });

  it("makes every live gate verify the mounted companion revision", () => {
    const root = scratch("confinement-gates-");
    const companion = join(root, "companion");
    mkdirSync(companion);
    const revision = createCompanionRepository(companion);
    const env = {
      ...process.env,
      COMIS_CONFINEMENT_DEV_CREW_SOURCE: companion,
      COMIS_CONFINEMENT_COMIS_SOURCE: root,
      COMIS_CONFINEMENT_PREFLIGHT_ONLY: "1",
      COMIS_DEV_CREW_COMMIT: revision,
    };

    for (const gate of LIVE_GATES) {
      const accepted = spawnSync("bash", [gate], { env, encoding: "utf8" });
      expect(accepted.status, `${gate}: ${accepted.stderr}`).toBe(0);
      expect(accepted.stdout).toContain(`companion revision verified: ${revision}`);

      const rejected = spawnSync("bash", [gate], {
        env: { ...env, COMIS_DEV_CREW_COMMIT: "0".repeat(40) },
        encoding: "utf8",
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("does not match");
    }
  });

  it.skipIf(spawnSync("go", ["version"]).status !== 0)(
    "binds the reporter diagnostic to the activated relay identity",
    () => {
      const root = scratch("confinement-diagnostic-");
      const diagnosticDir = join(root, "cmd", "diagnostic");
      const reporterDir = join(root, "internal", "reporter");
      const capture = join(root, "constructor-args");
      mkdirSync(diagnosticDir, { recursive: true });
      mkdirSync(reporterDir, { recursive: true });
      writeFileSync(join(root, "go.mod"), "module github.com/comisai/comis-dev-crew\n\ngo 1.22\n");
      writeFileSync(join(diagnosticDir, "main.go"), readFileSync(REPORTER_DIAGNOSTIC));
      const goImport = ["im", "port"].join("");
      writeFileSync(
        join(reporterDir, "reporter.go"),
        `package reporter

${goImport} (
  "context"
  "os"
  "strings"
  "time"
)

type Client struct{}

func NewMountedRuntimeClient(attachment, target, identity string, _ time.Duration) (*Client, error) {
  return &Client{}, os.WriteFile(os.Getenv("REPORTER_CAPTURE"), []byte(strings.Join([]string{attachment, target, identity}, "\\n")), 0600)
}

func (*Client) Brief(context.Context) (struct{}, error) { return struct{}{}, nil }
`,
      );

      const result = spawnSync("go", ["run", "./cmd/diagnostic"], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          COMIS_EXECUTION_ATTACHMENT: "attachment.sock",
          COMIS_EXECUTION_ATTACHMENT_TARGET_NAME: "target-a",
          COMIS_EXECUTION_ATTACHMENT_IDENTITY: "relay-identity",
          REPORTER_CAPTURE: capture,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("brief=ok");
      expect(readFileSync(capture, "utf8").split("\n")).toEqual([
        "attachment.sock",
        "target-a",
        "relay-identity",
      ]);
      expect(existsSync(capture)).toBe(true);
    },
  );
});
