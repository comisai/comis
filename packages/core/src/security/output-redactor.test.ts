// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { redactOutputText } from "./output-redactor.js";

describe("redactOutputText", () => {
  it.each([
    `bearer ${"a".repeat(24)}`,
    `Token ${"b".repeat(24)}`,
    `Basic ${"c".repeat(24)}`,
    `Digest ${"d".repeat(24)}`,
    `123456:${"e".repeat(20)}`,
    `SG.${"f".repeat(24)}`,
    `gho_${"g".repeat(36)}`,
    "postgres://user:password@example.com/database",
    `xoxb-${"s".repeat(32)}`,
    `${"M"}${"d".repeat(23)}.${"e".repeat(6)}.${"f".repeat(27)}`,
    `api_key=${"k".repeat(24)}`,
    "-----BEGIN PRIVATE KEY-----",
  ])("redacts canonical output credential shape %s", (credential) => {
    const result = redactOutputText(`before ${credential} after`);

    expect(result.text).not.toContain(credential);
    expect(result.redactions).toBeGreaterThan(0);
  });

  it("redacts a credential whose prefix crosses a chunk boundary", () => {
    const credential = `123456:${"t".repeat(20)}`;
    const input = `${"x".repeat(16_379)} ${credential} ${"y".repeat(16_399)}`;

    const result = redactOutputText(input);

    expect(result.text).not.toContain(credential);
    expect(result.redactions).toBeGreaterThan(0);
  });

  it.each([
    "PRIVATE KEY",
    "RSA PRIVATE KEY",
    "DSA PRIVATE KEY",
    "EC PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
    "ENCRYPTED PRIVATE KEY",
  ])("redacts the complete %s PEM block instead of only its header", (label) => {
    const body = `${"M".repeat(64)}\r\n${"N".repeat(64)}`;
    const privateKey = `-----BEGIN ${label}-----\r\n${body}\r\n-----END ${label}-----`;

    const result = redactOutputText(`before ${privateKey} after`);

    expect(result.text).toBe("before [REDACTED] after");
    expect(result.text).not.toContain(body);
    expect(result.text).not.toContain(`-----END ${label}-----`);
    expect(result.redactions).toBe(1);
  });

  it("redacts from an unterminated private-key header through the end of the field", () => {
    const body = `${"M".repeat(64)}\n${"N".repeat(64)}`;
    const input = `safe prefix -----BEGIN OPENSSH PRIVATE KEY-----\n${body}\ntrailing secret material`;

    const result = redactOutputText(input);

    expect(result).toEqual({ text: "safe prefix [REDACTED]", redactions: 1 });
  });

  it("fails closed through the end of the field when the private-key footer label mismatches", () => {
    const input = [
      "safe prefix ",
      "-----BEGIN RSA PRIVATE KEY-----",
      "private body",
      "-----END EC PRIVATE KEY-----",
      "must also be removed",
    ].join("\n");

    const result = redactOutputText(input);

    expect(result).toEqual({ text: "safe prefix \n[REDACTED]", redactions: 1 });
  });

  it.each([1_048_576, 1_048_577])(
    "redacts a complete private-key block with a %i-character body",
    (bodyLength) => {
      const body = "M".repeat(bodyLength);
      const privateKey = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;

      const result = redactOutputText(`before ${privateKey} after`);

      expect(result).toEqual({ text: "before [REDACTED] after", redactions: 1 });
    },
  );
});
