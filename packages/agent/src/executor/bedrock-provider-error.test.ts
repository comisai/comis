// SPDX-License-Identifier: Apache-2.0
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ValidationException } from "@aws-sdk/client-bedrock-runtime";
// This test intentionally reaches the pinned dependency helper: the repository
// carries a pnpm patch for this exact vendor boundary and must verify the patch
// still applies when dependency versions change.
import { normalizeProviderError } from "../../../../node_modules/@earendil-works/pi-ai/dist/utils/error-body.js";

describe("Bedrock provider error normalization", () => {
  it("preserves the modeled validation reason when the AWS response body is a stream", async () => {
    const providerError = new ValidationException({
      $metadata: { httpStatusCode: 400 },
      message: "This model does not support tool use.",
    }) as ValidationException & {
      $response: { statusCode: number; body: Readable };
    };
    providerError.$response = {
      statusCode: 400,
      body: Readable.from([]),
    };
    const normalized = normalizeProviderError(providerError);

    expect(normalized).toEqual({
      status: 400,
      body: undefined,
      message: "This model does not support tool use.",
      messageCarriesBody: true,
    });
    expect(JSON.stringify(normalized)).not.toContain("_readableState");
  });
});
