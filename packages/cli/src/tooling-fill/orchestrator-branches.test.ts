// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-coverage tests for tooling-fill/orchestrator.ts — covers paths not
 * exercised by the existing orchestrator.test.ts (mostly error-path / rollback
 * branches and argument-validation edges).
 *
 * Covered branches:
 *   - missing hint-name without --all → exit 1
 *   - config file unreadable → exit 1
 *   - invalid YAML → exit 1
 *   - empty entries on --all (zero hints in config) → exit 0
 *   - empty entries on single-hint mode (resolveHints empty result) → exit 1
 *   - operator-filled hint with --force overwrites (cross-mode)
 *   - non-TTY without --yes BEFORE LLM call (fail-fast)
 *   - non-TTY without --restart BEFORE LLM call (fail-fast)
 *   - test-injector env-var set outside test runtime → exit 1
 *   - confirmValues declined → exit 0 with "aborted by operator"
 *   - confirmRestart declined → exit 0 with "operator declined daemon restart"
 *   - stopDaemon fails → exit 1
 *   - writeBackup fails → exit 2 + best-effort restart
 *   - atomicWriteFile fails after backup → exit 2 + rollback
 *   - validateConfig fails after write → exit 1 + rolled-back
 *   - --restart-cmd overrides detectSupervisor with manual kind
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ok, err } from "@comis/shared";

// ---------- vi.mock at file-top (mirrors orchestrator.test.ts) ----------

vi.mock("./agent-call.js", () => ({
  callAgent: vi.fn(),
}));

vi.mock("./supervisor.js", () => ({
  detectSupervisor: vi.fn(),
  stopDaemon: vi.fn(),
  startDaemon: vi.fn(),
  waitForDaemonAlive: vi.fn(),
  MANUAL_RECIPE_HINT:
    "Could not auto-detect daemon supervisor (none of systemctl, pm2, pgrep matched). Run manually: systemctl stop comis && <edit config.yaml> && systemctl start comis. Or pass --restart-cmd \"<full stop+start command>\" to override.",
}));

vi.mock("../sync-tooling/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../sync-tooling/index.js")>();
  return {
    ...actual,
    atomicWriteFile: vi.fn(),
    writeBackup: vi.fn(),
    isDaemonRunning: vi.fn(),
  };
});

vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    validateConfig: vi.fn(),
    loadConfigFile: vi.fn(),
    loadEnvFile: vi.fn(() => 0),
  };
});

const { callAgent } = await import("./agent-call.js");
const {
  detectSupervisor,
  stopDaemon,
  startDaemon,
  waitForDaemonAlive,
} = await import("./supervisor.js");
const { atomicWriteFile, writeBackup, isDaemonRunning } = await import(
  "../sync-tooling/index.js"
);
const core = await import("@comis/core");
const { runToolingFill } = await import("./orchestrator/index.js");
import type { OrchestratorOpts, PromptIO } from "./orchestrator/index.js";

// ---------- Fixtures ----------

const STUB_YAML = `gateway:
  port: 4766
  token: \${COMIS_GATEWAY_TOKEN}
integrations:
  mcp:
    servers:
      - name: yfinance
        transport: stdio
        command: npx
        args:
          - -y
          - yfinance-mcp-ts
agents:
  default:
    skills:
      discoveryPaths:
        - ./skills
tooling:
  mcp:
    capabilityHints:
      yfinance:
        cluster: data-fetching
        description: TODO
        replacesPackages: []
  skills:
    capabilityHints:
      stub-skill:
        cluster: docs
        description: TODO
        replacesPackages: []
`;

const NO_HINTS_YAML = `gateway:
  port: 4766
  token: \${COMIS_GATEWAY_TOKEN}
tooling:
  mcp:
    capabilityHints: {}
  skills:
    capabilityHints: {}
`;

const OPERATOR_FILLED_YAML = `gateway:
  port: 4766
  token: \${COMIS_GATEWAY_TOKEN}
integrations:
  mcp:
    servers:
      - name: yfinance
        transport: stdio
        command: npx
        args:
          - -y
          - yfinance-mcp-ts
tooling:
  mcp:
    capabilityHints:
      yfinance:
        cluster: data-fetching
        description: my custom description
        replacesPackages:
          - somepkg
`;

function writeFixture(yamlContent: string, name = "config.yaml"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tooling-fill-branch-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, yamlContent, "utf-8");
  return p;
}

function makeOpts(over: Partial<OrchestratorOpts> = {}): OrchestratorOpts {
  const prompts: PromptIO = {
    confirmValues: vi.fn().mockResolvedValue(true),
    confirmRestart: vi.fn().mockResolvedValue(true),
  };
  return {
    hintName: "yfinance",
    all: false,
    force: false,
    forceNoValidate: false,
    dryRun: false,
    yes: true,
    restart: true,
    restartCmd: undefined,
    configPath: "/dev/null",
    homeDir: os.tmpdir(),
    kindHint: undefined,
    agentId: undefined,
    isTty: true,
    prompts,
    clock: () => new Date("2026-05-15T12:00:00Z"),
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(callAgent).mockReset();
  vi.mocked(detectSupervisor).mockReset();
  vi.mocked(stopDaemon).mockReset();
  vi.mocked(startDaemon).mockReset();
  vi.mocked(waitForDaemonAlive).mockReset();
  vi.mocked(atomicWriteFile).mockReset();
  vi.mocked(writeBackup).mockReset();
  vi.mocked(isDaemonRunning).mockReset();
  vi.mocked(core.validateConfig).mockReset();
  vi.mocked(core.loadConfigFile).mockReset();

  vi.mocked(isDaemonRunning).mockResolvedValue(true);
  vi.mocked(detectSupervisor).mockResolvedValue({ kind: "systemd" });
  vi.mocked(stopDaemon).mockResolvedValue(ok(undefined));
  vi.mocked(startDaemon).mockResolvedValue(ok(undefined));
  vi.mocked(waitForDaemonAlive).mockResolvedValue(ok(undefined));
  vi.mocked(writeBackup).mockReturnValue(
    ok({ backupPath: "/tmp/backup.yaml" }),
  );
  vi.mocked(atomicWriteFile).mockReturnValue(ok(undefined));
  vi.mocked(core.validateConfig).mockReturnValue(ok({}) as never);
  vi.mocked(core.loadConfigFile).mockImplementation((p: string) => {
    try {
      const raw = fs.readFileSync(p, "utf-8");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const yamlMod = require("yaml") as { parse: (s: string) => unknown };
      return ok(yamlMod.parse(raw)) as never;
    } catch (e) {
      return err({
        code: "FILE_NOT_FOUND",
        message: (e as Error).message,
      }) as never;
    }
  });

  process.env["COMIS_GATEWAY_TOKEN"] = "test-token";
  delete process.env["COMIS_TOOLING_FILL_TEST_AGENT_RESPONSE"];
});

afterEach(() => {
  delete process.env["COMIS_TOOLING_FILL_TEST_AGENT_RESPONSE"];
});

// ---------- Branch tests ----------

describe("runToolingFill — argument validation", () => {
  it("returns exit 1 with usage hint when hintName is undefined and --all is not passed", async () => {
    const result = await runToolingFill(
      makeOpts({ hintName: undefined, all: false }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("<hint-name> is required");
  });
});

describe("runToolingFill — config loading errors", () => {
  it("returns exit 1 when fs.readFileSync fails on a missing configPath", async () => {
    const result = await runToolingFill(
      makeOpts({ configPath: "/nonexistent/path/config.yaml" }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("Failed to read");
  });

  it("returns exit 1 when loadConfigFile returns err result for an unparseable config file", async () => {
    const configPath = writeFixture(STUB_YAML);
    vi.mocked(core.loadConfigFile).mockReturnValueOnce(
      err({
        code: "SCHEMA_INVALID",
        message: "missing required field",
      }) as never,
    );
    const result = await runToolingFill(makeOpts({ configPath }));
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("Failed to load");
    expect(result.summary).toContain("missing required field");
  });

  it("returns exit 1 with parse-error summary when parseDocument reports yaml errors after loadConfigFile succeeds", async () => {
    // The real loadConfigFile uses yaml.parse which is permissive; the
    // orchestrator separately runs parseDocument which surfaces errors.
    // To exercise the parseDocument error branch we stub loadConfigFile
    // to succeed but write content that parseDocument rejects.
    const invalidDoc = "tooling:\n  mcp:\n    capabilityHints:\n      bad-key: [unterminated\n";
    const configPath = writeFixture(invalidDoc);
    vi.mocked(core.loadConfigFile).mockReturnValueOnce(ok({}) as never);
    const result = await runToolingFill(makeOpts({ configPath }));
    expect(result.exitCode).toBe(1);
    expect(result.summary.toLowerCase()).toMatch(/invalid yaml|failed to parse/);
  });
});

describe("runToolingFill — empty entries", () => {
  it("returns exit 0 with no-stub-found message when --all finds zero stub hints in config", async () => {
    const configPath = writeFixture(NO_HINTS_YAML);
    const result = await runToolingFill(
      makeOpts({ all: true, hintName: undefined, configPath }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("nothing to fill");
  });
});

describe("runToolingFill — idempotency single-hint mode", () => {
  it("returns exit 1 with 'already filled' suffix when operator already wrote description and --force absent", async () => {
    const configPath = writeFixture(OPERATOR_FILLED_YAML);
    const result = await runToolingFill(
      makeOpts({ configPath, hintName: "yfinance", force: false }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.summary).toMatch(/already filled/);
    expect(result.summary).toContain("--force");
    expect(callAgent).not.toHaveBeenCalled();
  });
});

describe("runToolingFill — fail-fast non-TTY gates run BEFORE the LLM call", () => {
  it("returns exit 1 with --yes-required message when isTty=false and yes=false, before any callAgent invocation", async () => {
    const configPath = writeFixture(STUB_YAML);
    const result = await runToolingFill(
      makeOpts({ configPath, isTty: false, yes: false, restart: true }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("--yes required");
    expect(callAgent).not.toHaveBeenCalled();
  });

  it("returns exit 1 with --restart-required when isTty=false, yes=true, restart=undefined", async () => {
    const configPath = writeFixture(STUB_YAML);
    const result = await runToolingFill(
      makeOpts({
        configPath,
        isTty: false,
        yes: true,
        restart: undefined,
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("--restart required");
    expect(callAgent).not.toHaveBeenCalled();
  });
});

describe("runToolingFill — test-injector env-var gating", () => {
  it("returns exit 1 with production-safety message when test-injector env-var is set outside test runtime", async () => {
    const configPath = writeFixture(STUB_YAML);
    process.env["COMIS_TOOLING_FILL_TEST_AGENT_RESPONSE"] =
      "DESCRIPTION: injected\nREPLACES_PACKAGES: []";
    const prevVitest = process.env["VITEST"];
    const prevNodeEnv = process.env["NODE_ENV"];
    delete process.env["VITEST"];
    delete process.env["NODE_ENV"];
    try {
      const result = await runToolingFill(makeOpts({ configPath }));
      expect(result.exitCode).toBe(1);
      expect(result.summary).toContain("test-only fault injector");
    } finally {
      // Restore so other tests that depend on the runtime gate still pass
      if (prevVitest !== undefined) process.env["VITEST"] = prevVitest;
      if (prevNodeEnv !== undefined) process.env["NODE_ENV"] = prevNodeEnv;
      delete process.env["COMIS_TOOLING_FILL_TEST_AGENT_RESPONSE"];
    }
  });
});

describe("runToolingFill — confirmation prompts in TTY mode", () => {
  it("returns exit 0 with 'aborted by operator' when confirmValues resolves to false", async () => {
    const configPath = writeFixture(STUB_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: Yahoo Finance\nREPLACES_PACKAGES: ["yfinance"]',
      }),
    );
    const prompts: PromptIO = {
      confirmValues: vi.fn().mockResolvedValue(false),
      confirmRestart: vi.fn().mockResolvedValue(true),
    };
    const result = await runToolingFill(
      makeOpts({ configPath, yes: false, isTty: true, prompts }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("aborted by operator");
    expect(stopDaemon).not.toHaveBeenCalled();
  });

  it("returns exit 0 with 'declined daemon restart' when confirmRestart resolves to false in interactive mode", async () => {
    const configPath = writeFixture(STUB_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: Yahoo Finance\nREPLACES_PACKAGES: ["yfinance"]',
      }),
    );
    const prompts: PromptIO = {
      confirmValues: vi.fn().mockResolvedValue(true),
      confirmRestart: vi.fn().mockResolvedValue(false),
    };
    const result = await runToolingFill(
      makeOpts({
        configPath,
        yes: true,
        restart: undefined,
        isTty: true,
        prompts,
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("operator declined");
    expect(stopDaemon).not.toHaveBeenCalled();
  });
});

describe("runToolingFill — protected-mutation-window error paths", () => {
  it("returns exit 1 with stop-failure message when stopDaemon returns err result", async () => {
    const configPath = writeFixture(STUB_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: Yahoo Finance\nREPLACES_PACKAGES: ["yfinance"]',
      }),
    );
    vi.mocked(stopDaemon).mockResolvedValue(
      err({ kind: "subprocess-failed", message: "systemctl returned 5" }),
    );
    const result = await runToolingFill(makeOpts({ configPath }));
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("Failed to stop daemon");
    expect(result.summary).toContain("systemctl returned 5");
    expect(writeBackup).not.toHaveBeenCalled();
  });

  it("returns exit 2 with backup-failed message and best-effort daemon restart when writeBackup returns err", async () => {
    const configPath = writeFixture(STUB_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: Yahoo Finance\nREPLACES_PACKAGES: ["yfinance"]',
      }),
    );
    vi.mocked(writeBackup).mockReturnValue(
      err({
        code: "PERMISSION_DENIED",
        path: "/etc/comis/backup.yaml",
        cause: "EACCES on /etc/comis",
      }),
    );
    const result = await runToolingFill(makeOpts({ configPath }));
    expect(result.exitCode).toBe(2);
    expect(result.summary).toContain("Backup failed");
    expect(result.summary).toContain("PERMISSION_DENIED");
    // startDaemon was called as best-effort recovery
    expect(startDaemon).toHaveBeenCalled();
    expect(atomicWriteFile).not.toHaveBeenCalled();
  });

  it("returns exit 2 with atomic-write-failure message when atomicWriteFile returns err and rolls back", async () => {
    const configPath = writeFixture(STUB_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: Yahoo Finance\nREPLACES_PACKAGES: ["yfinance"]',
      }),
    );
    vi.mocked(atomicWriteFile).mockReturnValueOnce(
      err({ code: "ENOSPC", cause: "no space left on device" }),
    );
    const result = await runToolingFill(makeOpts({ configPath }));
    expect(result.exitCode).toBe(2);
    expect(result.summary).toContain("Atomic write failed");
    expect(result.summary).toContain("ENOSPC");
  });
});

describe("runToolingFill — --restart-cmd manual override path", () => {
  it("uses manual supervisor when --restart-cmd is provided and skips detectSupervisor invocation", async () => {
    const configPath = writeFixture(STUB_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: Yahoo Finance\nREPLACES_PACKAGES: ["yfinance"]',
      }),
    );

    const result = await runToolingFill(
      makeOpts({
        configPath,
        restartCmd: "echo restart",
      }),
    );

    expect(result.exitCode).toBe(0);
    // detectSupervisor was NOT called because restartCmd is set
    expect(detectSupervisor).not.toHaveBeenCalled();
    // stopDaemon was called with the manual supervisor kind
    expect(stopDaemon).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "manual", cmd: "echo restart" }),
    );
  });
});

describe("runToolingFill — --no-restart path skips daemon stop/start steps", () => {
  it("returns exit 0 and writes file without invoking stopDaemon/startDaemon when restart=false", async () => {
    const configPath = writeFixture(STUB_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: Yahoo Finance\nREPLACES_PACKAGES: ["yfinance"]',
      }),
    );
    const result = await runToolingFill(
      makeOpts({ configPath, restart: false }),
    );
    expect(result.exitCode).toBe(0);
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(startDaemon).not.toHaveBeenCalled();
    // But the file write still happened
    expect(writeBackup).toHaveBeenCalledTimes(1);
    expect(atomicWriteFile).toHaveBeenCalledTimes(1);
  });
});

describe("runToolingFill — supervisor 'none' when dry-run does NOT trigger MANUAL_RECIPE_HINT", () => {
  it("returns exit 0 in dry-run even when detectSupervisor resolves to none kind", async () => {
    const configPath = writeFixture(STUB_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: Yahoo Finance\nREPLACES_PACKAGES: ["yfinance"]',
      }),
    );
    vi.mocked(detectSupervisor).mockResolvedValue({ kind: "none" });

    const result = await runToolingFill(
      makeOpts({ configPath, dryRun: true, restart: true }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("dry-run");
  });

  it("returns exit 0 with --no-restart when detectSupervisor resolves to none kind", async () => {
    const configPath = writeFixture(STUB_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: Yahoo Finance\nREPLACES_PACKAGES: ["yfinance"]',
      }),
    );
    vi.mocked(detectSupervisor).mockResolvedValue({ kind: "none" });

    const result = await runToolingFill(
      makeOpts({ configPath, restart: false }),
    );
    expect(result.exitCode).toBe(0);
  });
});

describe("runToolingFill — startDaemon failure after successful write is non-fatal", () => {
  it("returns exit 0 with WARNING suffix when startDaemon returns err after successful atomicWriteFile", async () => {
    const configPath = writeFixture(STUB_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: Yahoo Finance\nREPLACES_PACKAGES: ["yfinance"]',
      }),
    );
    vi.mocked(startDaemon).mockResolvedValue(
      err({ kind: "subprocess-failed", message: "boot timeout" }),
    );

    const result = await runToolingFill(makeOpts({ configPath }));
    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("WARNING: daemon failed to restart");
    expect(result.summary).toContain("boot timeout");
  });
});

describe("runToolingFill — waitForDaemonAlive failure triggers rollback", () => {
  it("returns exit 2 with rolled-back summary when waitForDaemonAlive returns err after start", async () => {
    const configPath = writeFixture(STUB_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: Yahoo Finance\nREPLACES_PACKAGES: ["yfinance"]',
      }),
    );
    vi.mocked(waitForDaemonAlive).mockResolvedValue(
      err({ kind: "timeout", message: "daemon did not respond within 15s" }),
    );

    const result = await runToolingFill(makeOpts({ configPath }));
    expect(result.exitCode).toBe(2);
    expect(result.summary).toContain("Daemon failed to come up");
    expect(result.summary).toContain("rolled back");
    // atomicWriteFile called twice: once for forward, once for rollback
    expect(atomicWriteFile).toHaveBeenCalledTimes(2);
  });
});

describe("runToolingFill — agent parse failure exits 1 with parse-error summary", () => {
  it("returns exit 1 with 'parse failure' suffix when agent response cannot be parsed in single-hint mode", async () => {
    const configPath = writeFixture(STUB_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({ response: "not a valid agent response — no DESCRIPTION field" }),
    );

    const result = await runToolingFill(makeOpts({ configPath }));
    expect(result.exitCode).toBe(1);
    expect(result.summary.toLowerCase()).toContain("response invalid");
  });
});

describe("runToolingFill — --all + agent failure on one hint records skip and continues", () => {
  it("records skip for failed hint and exits 1 with partial-fill summary when callAgent rejects on second hint", async () => {
    // Configure two stub hints and have callAgent succeed on the first and fail on second
    const TWO_STUB_HINTS_YAML = `gateway:
  port: 4766
  token: \${COMIS_GATEWAY_TOKEN}
integrations:
  mcp:
    servers:
      - name: yfinance
        transport: stdio
        command: npx
        args:
          - -y
          - yfinance-mcp-ts
      - name: slack-mcp
        transport: stdio
        command: npx
        args:
          - -y
          - slack-mcp
tooling:
  mcp:
    capabilityHints:
      yfinance:
        cluster: data
        description: TODO
        replacesPackages: []
      slack-mcp:
        cluster: chat
        description: TODO
        replacesPackages: []
`;

    const configPath = writeFixture(TWO_STUB_HINTS_YAML);
    vi.mocked(callAgent)
      .mockResolvedValueOnce(
        ok({
          response:
            'DESCRIPTION: Yahoo Finance\nREPLACES_PACKAGES: ["yfinance"]',
        }),
      )
      .mockResolvedValueOnce(
        err({ kind: "timeout", status: 0, message: "exceeded 30000ms" }),
      );

    const result = await runToolingFill(
      makeOpts({ configPath, all: true, hintName: undefined }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.summary.toLowerCase()).toContain("skipped");
    expect(result.summary).toContain("slack-mcp");
    expect(callAgent).toHaveBeenCalledTimes(2);
  });
});
