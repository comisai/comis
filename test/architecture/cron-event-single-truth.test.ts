// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

const eventContractSource = readFileSync(
  resolve(root, "packages/core/src/event-bus/events-infra.ts"),
  "utf8",
);

const outwardProjectionSource = [
  "packages/gateway/src/web/activity-projection.ts",
  "packages/gateway/src/web/rest-api.ts",
  "packages/gateway/src/web/sse-endpoint.ts",
  "packages/web/src/api/types/common-types.ts",
  "packages/web/src/components/activity-feed.ts",
  "packages/web/src/views/scheduler.ts",
].map((file) => readFileSync(resolve(root, file), "utf8")).join("\n");

const retiredSentinelFiles = [
  "packages/daemon/src/wiring/setup-channels/setup-channels-memory-crons.ts",
  "packages/daemon/src/wiring/setup-channels/setup-channels-memory-crons-wire.ts",
  "packages/daemon/src/wiring/setup-channels/setup-channels-memory-crons-types.ts",
];

describe("cron lifecycle event single-truth contract", () => {
  it("exposes only durable cron start and terminal lifecycle events", () => {
    expect(eventContractSource).toContain('"scheduler:cron_execution_started"');
    expect(eventContractSource).toContain('"scheduler:cron_execution_terminal"');
    expect(eventContractSource).not.toMatch(
      /"scheduler:job_(?:started|completed|result)"/u,
    );
  });

  it("projects the durable lifecycle names through gateway and web surfaces", () => {
    expect(outwardProjectionSource).toContain('"scheduler:cron_execution_started"');
    expect(outwardProjectionSource).toContain('"scheduler:cron_execution_terminal"');
    expect(outwardProjectionSource).not.toMatch(
      /"scheduler:job_(?:started|completed|result)"/u,
    );
  });

  it("removes string-sentinel cron dispatch from daemon production source", () => {
    expect(retiredSentinelFiles.filter((file) => existsSync(resolve(root, file)))).toEqual([]);
  });
});
