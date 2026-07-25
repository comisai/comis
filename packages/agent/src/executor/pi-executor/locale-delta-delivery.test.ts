// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createLocaleDeltaDelivery } from "./locale-delta-delivery.js";

describe("createLocaleDeltaDelivery", () => {
  it("forwards live deltas when locale enforcement is disabled", () => {
    const downstream = vi.fn();
    const delivery = createLocaleDeltaDelivery({}, {
      policy: { source: "unset", enforceLocale: false },
      downstream,
    });

    delivery.onDelta("hello", "text");
    delivery.flush("hello");

    expect(downstream).toHaveBeenCalledTimes(1);
    expect(downstream).toHaveBeenCalledWith("hello", "text");
  });

  it("withholds unvalidated deltas and flushes only the corrected final response", () => {
    const downstream = vi.fn();
    const delivery = createLocaleDeltaDelivery({}, {
      policy: { locale: "ar", source: "request", enforceLocale: true },
      downstream,
    });

    delivery.onDelta("Wrong English draft", "text");
    delivery.onDelta("internal reasoning", "thinking");
    expect(downstream).not.toHaveBeenCalled();

    delivery.flush("هذه هي الإجابة النهائية.");
    delivery.flush("must not duplicate");

    expect(downstream).toHaveBeenCalledTimes(1);
    expect(downstream).toHaveBeenCalledWith("هذه هي الإجابة النهائية.", "text");
  });

  it("is wired before bridge delivery and flushed after post-execution finalizes prose", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, "pi-executor.ts"), "utf8");
    const createIndex = source.indexOf("createLocaleDeltaDelivery(");
    const bridgeIndex = source.indexOf("channelOnDelta: localeDeltaDelivery.onDelta");
    const postIndex = source.indexOf("await postExecution(");
    const flushIndex = source.indexOf("localeDeltaDelivery.flush(result.response)");

    expect(createIndex).toBeGreaterThan(0);
    expect(bridgeIndex).toBeGreaterThan(createIndex);
    expect(postIndex).toBeGreaterThan(bridgeIndex);
    expect(flushIndex).toBeGreaterThan(postIndex);
  });
});
