// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createBoundedServiceStderr } from "./service-stderr-buffer.js";

describe("bounded live-service stderr diagnostics", () => {
  it("retains the newest complete diagnostic bytes within the configured limit", () => {
    const stderr = createBoundedServiceStderr(8);

    stderr.append(Buffer.from("older"));
    stderr.append(Buffer.from("newest"));

    expect(stderr.text()).toBe("[5 earlier stderr bytes omitted]\nrestnewest");
  });

  it("bounds one oversized chunk without retaining its discarded prefix", () => {
    const stderr = createBoundedServiceStderr(4);

    stderr.append(Buffer.from("0123456789"));

    expect(stderr.text()).toBe("[6 earlier stderr bytes omitted]\n6789");
  });

  it("returns the full diagnostic when no bytes were discarded", () => {
    const stderr = createBoundedServiceStderr(16);

    stderr.append(Buffer.from("first"));
    stderr.append(Buffer.from("-second"));

    expect(stderr.text()).toBe("first-second");
  });
});
