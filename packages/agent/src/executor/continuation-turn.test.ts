// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { runContinuationTurn } from "./continuation-turn.js";
import { allowProviderDispatch } from "./provider-dispatch.js";
import { err } from "@comis/shared";

const executorDir = dirname(fileURLToPath(import.meta.url));
const idleContinuationSources = [
  "prompt-runner/output-escalation.ts",
  "prompt-runner/retry-loop.ts",
  "prompt-runner/interactive-silent-recovery.ts",
  "prompt-runner/response-locale-enforcement.ts",
  "post-batch-continuation.ts",
  "narrate-nudge.ts",
].map((file) => readFileSync(resolve(executorDir, file), "utf8"));

describe("idle continuation turn", () => {
  it("starts and awaits a real model turn without expanding directives", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);

    await runContinuationTurn({ prompt }, "Rewrite the final response.", allowProviderDispatch);

    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith("Rewrite the final response.", {
      expandPromptTemplates: false,
      source: "extension",
    });
  });

  it("blocks continuation provider dispatch when terminal admission is denied", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    const denied = await runContinuationTurn(
      { prompt },
      "Rewrite the final response.",
      () => err(new Error("run is terminal")),
    );

    expect(denied.ok).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("keeps post-prompt recovery paths off the queue-only follow-up API", () => {
    for (const source of idleContinuationSources) {
      expect(source).not.toMatch(/session\.followUp\(/);
      expect(source).toContain("runContinuationTurn");
    }
  });
});
