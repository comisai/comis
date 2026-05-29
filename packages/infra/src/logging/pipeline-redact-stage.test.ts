// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the Pino pipeline-mode redact stage.
 *
 * The stage is pure plumbing: feed each newline-delimited log line through
 * `redactSecretsInText` and re-emit it (with newline framing restored) for the
 * downstream file target. `redactSecretsInText`'s redaction correctness is owned
 * by `@comis/observability` (and tested there), so here we mock it to assert the
 * STAGE's own contract:
 *   1. default export builds a writable+readable pipeline stream,
 *   2. every line is fed through the fn and re-emitted with its `\n` restored
 *      (split2's line-parse mode strips it),
 *   3. fail-soft: a throw inside redaction passes the original line through and
 *      never crashes the transport (the Pino "never throw" invariant).
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { redactMock } = vi.hoisted(() => ({
  redactMock: vi.fn((s: string) => s),
}));
vi.mock("@comis/observability", () => ({ redactSecretsInText: redactMock }));

import createPipelineRedactStage from "./pipeline-redact-stage.js";

/** Drive newline-delimited lines through the stage; resolve with the emitted output. */
async function runStage(lines: string[]): Promise<string> {
  const stage = createPipelineRedactStage();
  const out: string[] = [];
  stage.on("data", (chunk: Buffer | string) => out.push(chunk.toString()));
  const done = new Promise<void>((resolve) => stage.on("end", () => resolve()));
  for (const line of lines) stage.write(line);
  stage.end();
  await done;
  return out.join("");
}

describe("createPipelineRedactStage", () => {
  beforeEach(() => {
    redactMock.mockReset();
    redactMock.mockImplementation((s: string) => s);
  });

  it("default export builds a writable+readable stream", () => {
    const stage = createPipelineRedactStage();
    expect(typeof stage.write).toBe("function");
    expect(typeof stage.on).toBe("function");
  });

  it("feeds each line through redactSecretsInText and restores newline framing", async () => {
    redactMock.mockImplementation((s: string) => s.replace("RAW", "[CLEAN]"));
    const out = await runStage(['{"msg":"RAW-value"}\n']);
    // split2 (parse:"lines") strips the trailing newline before the fn sees it…
    expect(redactMock).toHaveBeenCalledWith('{"msg":"RAW-value"}');
    // …and the stage re-appends it around the redacted result.
    expect(out).toBe('{"msg":"[CLEAN]-value"}\n');
  });

  it("passes a line through unchanged when redaction is a no-op", async () => {
    const out = await runStage(['{"msg":"completed"}\n']);
    expect(out).toBe('{"msg":"completed"}\n');
  });

  it("is fail-soft: a throw inside redaction yields the original line, never crashes", async () => {
    redactMock.mockImplementation(() => {
      throw new Error("redact boom");
    });
    const out = await runStage(['{"msg":"keep-me"}\n']);
    expect(out).toBe('{"msg":"keep-me"}\n');
  });
});
