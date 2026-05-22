// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import chalk from "chalk";

// Mock @clack/prompts before importing the confirm helper so the helper
// resolves to the mocked module.
vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: vi.fn((v: unknown) => typeof v === "symbol"),
}));

import * as p from "@clack/prompts";
import { confirm } from "./confirm.js";

describe("confirm", () => {
  let originalChalkLevel: number;

  beforeEach(() => {
    vi.mocked(p.confirm).mockReset();
    vi.mocked(p.isCancel).mockReset();
    // Default isCancel impl mirrors the production shape:
    vi.mocked(p.isCancel).mockImplementation(
      (v: unknown) => typeof v === "symbol",
    );
    // Force chalk to emit ANSI escape codes regardless of TTY detection —
    // Vitest runs in a no-TTY worker, where chalk.level defaults to 0 and
    // chalk.yellow("X") returns the bare string "X". We need level >= 1 to
    // assert on the ANSI styling produced by the production helper.
    originalChalkLevel = chalk.level;
    chalk.level = 1;
  });

  afterEach(() => {
    vi.clearAllMocks();
    chalk.level = originalChalkLevel as 0 | 1 | 2 | 3;
  });

  it("returns true when p.confirm resolves true", async () => {
    vi.mocked(p.confirm).mockResolvedValue(true);
    await expect(confirm({ message: "ok?" })).resolves.toBe(true);
  });

  it("returns false when p.confirm resolves false", async () => {
    vi.mocked(p.confirm).mockResolvedValue(false);
    await expect(confirm({ message: "ok?" })).resolves.toBe(false);
  });

  it("returns false when user cancels (Symbol return value)", async () => {
    vi.mocked(p.confirm).mockResolvedValue(
      Symbol("cancel") as unknown as boolean,
    );
    await expect(confirm({ message: "ok?" })).resolves.toBe(false);
  });

  it("passes initialValue: true when default option is true", async () => {
    vi.mocked(p.confirm).mockResolvedValue(true);
    await confirm({ message: "ok?", default: true });
    expect(p.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: true }),
    );
  });

  it("passes initialValue: false when default option is omitted", async () => {
    vi.mocked(p.confirm).mockResolvedValue(false);
    await confirm({ message: "ok?" });
    expect(p.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: false }),
    );
  });

  it("wraps the message in chalk.yellow styling (ANSI escape present)", async () => {
    vi.mocked(p.confirm).mockResolvedValue(true);
    await confirm({ message: "Delete?" });
    const call = vi.mocked(p.confirm).mock.calls[0]?.[0];
    expect(call?.message).toContain("Delete?");
    // chalk.yellow emits an ANSI escape sequence: ESC (\x1b) + "[" + digits + "m".
    // Yellow's foreground code is 33m; the helper wraps the message in
    // chalk.yellow so the produced string starts with "\x1b[33m".
    expect(call?.message).toMatch(/\x1b\[\d+m/);
  });
});
