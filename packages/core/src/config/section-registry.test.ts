// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  SECTION_REGISTRY,
  registerContributionSections,
} from "./section-registry.js";

describe("contribution config section registration", () => {
  it("registers contribution namespaces through the consolidated section registry", () => {
    const schema = z.strictObject({ enabled: z.boolean().default(false) });
    const result = registerContributionSections([{
      contributionId: "example.echo",
      namespace: "echo",
      schema,
      schemaSerializable: true,
      fieldMetadataVisible: true,
    }]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.echo).toMatchObject({
      schema,
      schemaSerializable: true,
      fieldMetadataVisible: true,
      owner: { kind: "contribution", contributionId: "example.echo" },
    });
    expect(SECTION_REGISTRY.echo).toBeUndefined();
  });

  it("rejects a contribution namespace that collides with kernel config", () => {
    const result = registerContributionSections([{
      contributionId: "example.memory",
      namespace: "memory",
      schema: z.object({}),
      schemaSerializable: true,
      fieldMetadataVisible: true,
    }]);

    expect(result).toMatchObject({ ok: false });
  });

  it("rejects duplicate contribution namespaces transactionally", () => {
    const registration = {
      namespace: "echo",
      schema: z.object({}),
      schemaSerializable: true,
      fieldMetadataVisible: true,
    } as const;
    const result = registerContributionSections([
      { ...registration, contributionId: "example.echo-a" },
      { ...registration, contributionId: "example.echo-b" },
    ]);

    expect(result).toMatchObject({ ok: false });
    expect(SECTION_REGISTRY.echo).toBeUndefined();
  });
});
