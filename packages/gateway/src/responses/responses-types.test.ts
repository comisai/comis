// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  ResponseRequestSchema,
  createSequenceCounter,
} from "./responses-types.js";

describe("ResponseRequestSchema", () => {
  it("accepts a valid string input", () => {
    const result = ResponseRequestSchema.safeParse({
      model: "gpt-4",
      input: "Hello, world!",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe("gpt-4");
      expect(result.data.input).toBe("Hello, world!");
      expect(result.data.stream).toBe(false); // default
    }
  });

  it("accepts a valid messages array input", () => {
    const result = ResponseRequestSchema.safeParse({
      model: "gpt-4",
      input: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hi there" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Array.isArray(result.data.input)).toBe(true);
      expect((result.data.input as Array<{ role: string }>).length).toBe(2);
    }
  });

  it("accepts stream:true", () => {
    const result = ResponseRequestSchema.safeParse({
      model: "gpt-4",
      input: "Hello",
      stream: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stream).toBe(true);
    }
  });

  it("accepts optional temperature", () => {
    const result = ResponseRequestSchema.safeParse({
      model: "gpt-4",
      input: "Hello",
      temperature: 0.7,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.temperature).toBe(0.7);
    }
  });

  it("accepts optional max_output_tokens", () => {
    const result = ResponseRequestSchema.safeParse({
      model: "gpt-4",
      input: "Hello",
      max_output_tokens: 1024,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_output_tokens).toBe(1024);
    }
  });

  it("rejects missing model", () => {
    const result = ResponseRequestSchema.safeParse({
      input: "Hello",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty model string", () => {
    const result = ResponseRequestSchema.safeParse({
      model: "",
      input: "Hello",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing input", () => {
    const result = ResponseRequestSchema.safeParse({
      model: "gpt-4",
    });
    expect(result.success).toBe(false);
  });

  it("rejects temperature below 0", () => {
    const result = ResponseRequestSchema.safeParse({
      model: "gpt-4",
      input: "Hello",
      temperature: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects temperature above 2", () => {
    const result = ResponseRequestSchema.safeParse({
      model: "gpt-4",
      input: "Hello",
      temperature: 3,
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields (strictObject)", () => {
    const result = ResponseRequestSchema.safeParse({
      model: "gpt-4",
      input: "Hello",
      unknown_field: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("createSequenceCounter", () => {
  it("starts at 0", () => {
    const counter = createSequenceCounter();
    expect(counter.next()).toBe(0);
  });

  it("increments monotonically", () => {
    const counter = createSequenceCounter();
    const values: number[] = [];
    for (let i = 0; i < 10; i++) {
      values.push(counter.next());
    }
    expect(values).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("creates independent counters", () => {
    const counter1 = createSequenceCounter();
    const counter2 = createSequenceCounter();
    counter1.next();
    counter1.next();
    expect(counter2.next()).toBe(0);
    expect(counter1.next()).toBe(2);
  });
});
