// SPDX-License-Identifier: Apache-2.0
/**
 * Pino redact transport tests.
 *
 * Smoke tests verifying the default-export `Transform` correctly
 * filters JSON log lines through `redactSecretsInText`. Pino itself is
 * NOT spawned in these unit tests (the worker-thread resolution path is
 * validated separately by the integration suite via the infra shim).
 *
 * @module
 */

import { Transform } from "node:stream";
import { describe, it, expect } from "vitest";
import pinoRedactTransport from "./pino-redact-transport.js";

describe("pino-redact-transport — default export shape", () => {
  it("default export is a function returning a Transform stream", () => {
    const out = pinoRedactTransport();
    expect(out).toBeInstanceOf(Transform);
  });

  it("returned Transform filters credentials inside a JSON-line chunk", async () => {
    const transform = pinoRedactTransport();

    const collected: string[] = [];
    transform.on("data", (chunk: Buffer) => {
      collected.push(chunk.toString("utf8"));
    });

    const input =
      '{"level":"info","msg":"call","authorization":"Bearer sk-1234567890abcdef"}\n';
    transform.write(input);
    transform.end();

    await new Promise<void>((resolve) => transform.on("end", () => resolve()));

    const out = collected.join("");
    expect(out.includes("sk-1234567890abcdef")).toBe(false);
    expect(out.includes('"level":"info"')).toBe(true);
  });

  it("passes through a chunk without credentials unchanged", async () => {
    const transform = pinoRedactTransport();

    const collected: string[] = [];
    transform.on("data", (chunk: Buffer) => {
      collected.push(chunk.toString("utf8"));
    });

    const input = '{"level":"info","msg":"completed"}\n';
    transform.write(input);
    transform.end();

    await new Promise<void>((resolve) => transform.on("end", () => resolve()));

    expect(collected.join("")).toBe(input);
  });

  it("preserves trailing newlines (Pino JSON-line framing)", async () => {
    const transform = pinoRedactTransport();
    const collected: string[] = [];
    transform.on("data", (chunk: Buffer) => collected.push(chunk.toString("utf8")));

    transform.write('{"msg":"a"}\n');
    transform.end();
    await new Promise<void>((resolve) => transform.on("end", () => resolve()));

    expect(collected.join("").endsWith("\n")).toBe(true);
  });
});
