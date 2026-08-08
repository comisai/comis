// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  isAuxiliaryStreamCall,
  markAuxiliaryStreamCall,
} from "./auxiliary-stream-call.js";

describe("auxiliary stream call metadata", () => {
  it("marks a copied options object without mutating the caller options", () => {
    const options = { headers: { "x-request-kind": "parent" } };

    const marked = markAuxiliaryStreamCall(options);

    expect(marked).not.toBe(options);
    expect(isAuxiliaryStreamCall(marked)).toBe(true);
    expect(isAuxiliaryStreamCall(options)).toBe(false);
    expect(marked.headers).toEqual(options.headers);
  });

  it("marks an auxiliary call when provider options were initially absent", () => {
    const marked = markAuxiliaryStreamCall(undefined);

    expect(isAuxiliaryStreamCall(marked)).toBe(true);
    expect(isAuxiliaryStreamCall(undefined)).toBe(false);
  });
});
