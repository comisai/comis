// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { err } from "@comis/shared";
import {
  allowProviderDispatch,
  dispatchProviderPrompt,
  resolveProviderDispatchGuard,
} from "./provider-dispatch.js";

describe("provider dispatch guard", () => {
  it("does not invoke the provider after terminal admission denial", async () => {
    const provider = vi.fn().mockResolvedValue("unused");

    await expect(dispatchProviderPrompt(
      () => err(new Error("run is terminal")),
      provider,
    )).rejects.toThrow("run is terminal");
    expect(provider).not.toHaveBeenCalled();
  });

  it("resolves an absent execution guard to explicit admission", async () => {
    const provider = vi.fn().mockResolvedValue("accepted");
    const guard = resolveProviderDispatchGuard(undefined);

    await expect(dispatchProviderPrompt(guard, provider)).resolves.toBe("accepted");
    expect(guard).toBe(allowProviderDispatch);
  });
});
