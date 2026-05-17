// SPDX-License-Identifier: Apache-2.0
/**
 * Umbrella namespace smoke test for the `comisai` package barrel.
 *
 * Asserts shape parity between the umbrella's 12 namespace re-exports and
 * each underlying `@comis/<pkg>` barrel — for every namespace we check (a)
 * the export is a namespace object, (b) it has a stable sentinel property,
 * and (c) the sentinel is identity-equal (`===`) to the same property on
 * the direct `@comis/<pkg>` import. Identity equality is the key guard:
 * the only way a future PR could break it is by replacing the
 * `export * from "@comis/<pkg>"` pattern with a hand-written wrapper,
 * which would also be the kind of regression that breaks downstream
 * consumers of `npm install -g comisai`.
 *
 * Catches `prepack.js` bundling regressions and silent re-export shadowing.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import * as comis from "./index.js";

import * as directShared from "@comis/shared";
import * as directCore from "@comis/core";
import * as directInfra from "@comis/infra";
import * as directMemory from "@comis/memory";
import * as directGateway from "@comis/gateway";
import * as directSkills from "@comis/skills";
import * as directScheduler from "@comis/scheduler";
import * as directAgent from "@comis/agent";
import * as directChannels from "@comis/channels";
import * as directOrchestrator from "@comis/orchestrator";
import * as directCli from "@comis/cli";
import * as directDaemon from "@comis/daemon";

describe("comisai umbrella namespace re-exports — shape matches sub-package barrels", () => {
  it("exposes namespace 'shared' whose sentinel 'ok' is identity-equal to @comis/shared.ok", () => {
    expect(typeof comis.shared).toBe("object");
    expect(comis.shared).toHaveProperty("ok");
    expect((comis.shared as Record<string, unknown>).ok).toBe(
      (directShared as Record<string, unknown>).ok,
    );
  });

  it("exposes namespace 'core' whose sentinel 'safePath' is identity-equal to @comis/core.safePath", () => {
    expect(typeof comis.core).toBe("object");
    expect(comis.core).toHaveProperty("safePath");
    expect((comis.core as Record<string, unknown>).safePath).toBe(
      (directCore as Record<string, unknown>).safePath,
    );
  });

  it("exposes namespace 'infra' whose sentinel 'createSystemClock' is identity-equal to @comis/infra.createSystemClock", () => {
    expect(typeof comis.infra).toBe("object");
    expect(comis.infra).toHaveProperty("createSystemClock");
    expect((comis.infra as Record<string, unknown>).createSystemClock).toBe(
      (directInfra as Record<string, unknown>).createSystemClock,
    );
  });

  it("exposes namespace 'memory' whose sentinel 'createSessionStore' is identity-equal to @comis/memory.createSessionStore", () => {
    expect(typeof comis.memory).toBe("object");
    expect(comis.memory).toHaveProperty("createSessionStore");
    expect((comis.memory as Record<string, unknown>).createSessionStore).toBe(
      (directMemory as Record<string, unknown>).createSessionStore,
    );
  });

  it("exposes namespace 'gateway' whose sentinel 'createGatewayServer' is identity-equal to @comis/gateway.createGatewayServer", () => {
    expect(typeof comis.gateway).toBe("object");
    expect(comis.gateway).toHaveProperty("createGatewayServer");
    expect((comis.gateway as Record<string, unknown>).createGatewayServer).toBe(
      (directGateway as Record<string, unknown>).createGatewayServer,
    );
  });

  it("exposes namespace 'skills' whose sentinel 'createSkillRegistry' is identity-equal to @comis/skills.createSkillRegistry", () => {
    expect(typeof comis.skills).toBe("object");
    expect(comis.skills).toHaveProperty("createSkillRegistry");
    expect((comis.skills as Record<string, unknown>).createSkillRegistry).toBe(
      (directSkills as Record<string, unknown>).createSkillRegistry,
    );
  });

  it("exposes namespace 'scheduler' whose sentinel 'computeNextRunAtMs' is identity-equal to @comis/scheduler.computeNextRunAtMs", () => {
    expect(typeof comis.scheduler).toBe("object");
    expect(comis.scheduler).toHaveProperty("computeNextRunAtMs");
    expect((comis.scheduler as Record<string, unknown>).computeNextRunAtMs).toBe(
      (directScheduler as Record<string, unknown>).computeNextRunAtMs,
    );
  });

  it("exposes namespace 'agent' whose sentinel 'createCircuitBreaker' is identity-equal to @comis/agent.createCircuitBreaker", () => {
    expect(typeof comis.agent).toBe("object");
    expect(comis.agent).toHaveProperty("createCircuitBreaker");
    expect((comis.agent as Record<string, unknown>).createCircuitBreaker).toBe(
      (directAgent as Record<string, unknown>).createCircuitBreaker,
    );
  });

  it("exposes namespace 'channels' whose sentinel 'createTelegramAdapter' is identity-equal to @comis/channels.createTelegramAdapter", () => {
    expect(typeof comis.channels).toBe("object");
    expect(comis.channels).toHaveProperty("createTelegramAdapter");
    expect((comis.channels as Record<string, unknown>).createTelegramAdapter).toBe(
      (directChannels as Record<string, unknown>).createTelegramAdapter,
    );
  });

  it("exposes namespace 'orchestrator' whose sentinel 'createChannelManager' is identity-equal to @comis/orchestrator.createChannelManager", () => {
    expect(typeof comis.orchestrator).toBe("object");
    expect(comis.orchestrator).toHaveProperty("createChannelManager");
    expect((comis.orchestrator as Record<string, unknown>).createChannelManager).toBe(
      (directOrchestrator as Record<string, unknown>).createChannelManager,
    );
  });

  it("exposes namespace 'cli' whose sentinel 'withClient' is identity-equal to @comis/cli.withClient", () => {
    expect(typeof comis.cli).toBe("object");
    expect(comis.cli).toHaveProperty("withClient");
    expect((comis.cli as Record<string, unknown>).withClient).toBe(
      (directCli as Record<string, unknown>).withClient,
    );
  });

  it("exposes namespace 'daemon' whose sentinel 'main' is identity-equal to @comis/daemon.main", () => {
    expect(typeof comis.daemon).toBe("object");
    expect(comis.daemon).toHaveProperty("main");
    expect((comis.daemon as Record<string, unknown>).main).toBe(
      (directDaemon as Record<string, unknown>).main,
    );
  });

  it("exports exactly 12 namespace re-exports — no silent additions, no silent deletions", () => {
    const names = Object.keys(comis).sort();
    expect(names).toEqual([
      "agent",
      "channels",
      "cli",
      "core",
      "daemon",
      "gateway",
      "infra",
      "memory",
      "orchestrator",
      "scheduler",
      "shared",
      "skills",
    ]);
    expect(names.length).toBe(12);
  });
});
