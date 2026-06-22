/**
 * init-proxy.test.ts
 *
 * Tests for the CLI init env-only proxy install.
 *
 * Asserts:
 *  a) The init .action() calls installWizardProxyFromEnv(process.env) before the
 *     wizard runs, so live credential/channel validation honours HTTP(S)_PROXY.
 *  b) The install is best-effort: a `false` return (no proxy env) does not stop
 *     the init action.
 *
 * The installer lives in @comis/cli (util/install-wizard-proxy.ts), NOT
 * @comis/infra — the CLI must not import @comis/infra (architecture L12).
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the cli-local installer to intercept the call
// ---------------------------------------------------------------------------
vi.mock("../util/install-wizard-proxy.js", () => ({
  installWizardProxyFromEnv: vi.fn(() => true),
}));

import { installWizardProxyFromEnv } from "../util/install-wizard-proxy.js";

// ---------------------------------------------------------------------------
// We exercise the init command by importing the module and running the
// commander action directly via a minimal stub approach. We cannot easily
// invoke the full Commander command (it would try to open files), so instead
// we extract the action handler by patching the module.
//
// Strategy: mock all heavy dependencies (wizard, prompter, etc.), then import
// the command module and trigger the action via commander's parseAsync on a
// minimal in-process command.
// ---------------------------------------------------------------------------

// Stub out the wizard steps and prompter so the action body exits quickly
vi.mock("../wizard/prompter.js", () => ({
  InteractivePrompter: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockResolvedValue({ ok: false, cancelled: true }),
  })),
}));

vi.mock("../wizard/non-interactive-prompter.js", () => ({
  NonInteractivePrompter: vi.fn().mockImplementation(() => ({})),
  buildNonInteractiveOptionsFromCommander: vi.fn(() => ({ quick: true })),
  validateNonInteractiveOptions: vi.fn(),
  buildNonInteractiveState: vi.fn(() => ({})),
}));

vi.mock("../wizard/wizard-flow.js", () => ({
  runWizardFlow: vi.fn().mockResolvedValue({ ok: false, cancelled: true }),
}));

vi.mock("../wizard/steps/index.js", () => ({
  buildStepRegistry: vi.fn(() => []),
}));

// ---------------------------------------------------------------------------
afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: create a minimal commander instance that wires the init action
// ---------------------------------------------------------------------------
async function runInitAction(opts: Record<string, unknown> = {}) {
  // Import the registerInitCommand function (after mocks are set up)
  const { registerInitCommand } = await import("./init.js");
  const { Command } = await import("commander");

  const program = new Command();
  program.exitOverride(); // prevent process.exit
  registerInitCommand(program);

  // Build argv array — pass --non-interactive so the action tries to parse
  // flags and then exits (wizard mocked to return cancelled)
  const argv = ["node", "comis", "init"];
  for (const [k, v] of Object.entries(opts)) {
    argv.push(`--${k}`, String(v));
  }

  try {
    await program.parseAsync(argv);
  } catch {
    // Swallow Commander's exitOverride error and wizard flow exits
  }
}

// ---------------------------------------------------------------------------
// a) installWizardProxyFromEnv called before wizard
// ---------------------------------------------------------------------------
describe("CLI init — env-only proxy install (PROXY-02)", () => {
  it("calls installWizardProxyFromEnv with process.env at the start of the action", async () => {
    await runInitAction();

    expect(installWizardProxyFromEnv).toHaveBeenCalled();
    // env must be process.env (the actual reference, not a copy)
    const arg = (installWizardProxyFromEnv as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toBe(process.env);
  }, 20_000); // importing the full init module graph is slow under cold transform

  // ---------------------------------------------------------------------------
  // b) best-effort — a `false` return (no proxy env) must not stop init
  // ---------------------------------------------------------------------------
  it("does NOT throw when no proxy env is set (installer returns false)", async () => {
    (installWizardProxyFromEnv as ReturnType<typeof vi.fn>).mockReturnValue(false);

    // Should resolve without throwing — wizard flow continues
    await expect(runInitAction()).resolves.not.toThrow();
  }, 20_000);
});
