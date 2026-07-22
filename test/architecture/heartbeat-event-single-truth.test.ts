// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
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
  "packages/web/src/api/types/heartbeat-types.ts",
  "packages/web/src/components/activity-feed.ts",
  "packages/web/src/views/agents/agent-detail.ts",
  "packages/web/src/views/scheduler.ts",
].map((file) => readFileSync(resolve(root, file), "utf8")).join("\n");

const schedulerDocumentationSource = [
  "docs/developer-guide/event-bus.mdx",
  "docs/developer-guide/contributing.mdx",
  "docs/reference/http-gateway.mdx",
].map((file) => readFileSync(resolve(root, file), "utf8")).join("\n");

const HEARTBEAT_WAKE_EVENTS = [
  "scheduler:heartbeat_wake_admitted",
  "scheduler:heartbeat_wake_deferred",
  "scheduler:heartbeat_wake_terminal",
] as const;

const RETIRED_HEARTBEAT_EVENTS =
  /"?scheduler:heartbeat_(?:check|delivered)"?/u;

describe("heartbeat lifecycle event single-truth contract", () => {
  it("exposes only correlated heartbeat wake lifecycle events", () => {
    for (const event of HEARTBEAT_WAKE_EVENTS) {
      expect(eventContractSource).toContain(`"${event}"`);
    }
    expect(eventContractSource).not.toMatch(RETIRED_HEARTBEAT_EVENTS);
  });

  it("projects every correlated heartbeat wake event outward", () => {
    for (const event of HEARTBEAT_WAKE_EVENTS) {
      expect(outwardProjectionSource).toContain(`"${event}"`);
    }
    expect(outwardProjectionSource).not.toMatch(RETIRED_HEARTBEAT_EVENTS);
  });

  it("documents correlated heartbeat wake events without retired names", () => {
    for (const event of HEARTBEAT_WAKE_EVENTS) {
      expect(schedulerDocumentationSource).toContain(`scheduler:${event.split(":")[1]}`);
    }
    expect(schedulerDocumentationSource).not.toMatch(RETIRED_HEARTBEAT_EVENTS);
  });
});
