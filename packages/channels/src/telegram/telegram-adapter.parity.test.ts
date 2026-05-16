// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks: minimal grammy + transformer mocks so createTelegramAdapter can run
// without network. Mirrors telegram-adapter.test.ts patterns but stripped to
// just what the structural snapshots require.
// ---------------------------------------------------------------------------

vi.mock("grammy", () => {
  class MockBot {
    api = {
      config: { use: vi.fn() },
    };
    on = vi.fn();
  }
  return {
    Bot: MockBot,
    InputFile: class MockInputFile {
      constructor(public source: unknown) {}
    },
  };
});

vi.mock("@grammyjs/auto-retry", () => ({
  autoRetry: vi.fn(() => "auto-retry-transformer"),
}));

vi.mock("@grammyjs/files", () => ({
  hydrateFiles: vi.fn(() => "hydrate-files-transformer"),
}));

vi.mock("@grammyjs/runner", () => ({
  run: vi.fn(() => ({ isRunning: vi.fn(() => true), stop: vi.fn() })),
}));

vi.mock("./credential-validator.js", () => ({
  validateBotToken: vi.fn(),
  validateWebhookSecret: vi.fn(),
}));

vi.mock("./message-mapper.js", () => ({
  mapGrammyToNormalized: vi.fn(),
}));

vi.mock("./voice-sender.js", () => ({
  createTelegramVoiceSender: vi.fn(() => ({ sendVoice: vi.fn() })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { stableStringify } from "../../../../test/support/stable-stringify.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import {
  createTelegramAdapter,
  type TelegramAdapterDeps,
  type TelegramAdapterHandle,
} from "./telegram-adapter.js";

/**
 * Phase 43 parity protection for FILE-SPLIT-12.
 *
 * Locks the byte-identical structural surface of telegram-adapter.ts BEFORE
 * the Phase 43 split refactor lands (Plan 43-04, Task 1). Post-split (Task 2)
 * the same module surface must reproduce these snapshots byte-identical.
 *
 * Runtime behavior (real grammy interactions: start/stop/sendMessage round
 * trips) is covered by:
 *   - packages/channels/src/telegram/telegram-adapter.test.ts (63 it-blocks
 *     against mocked grammy)
 *   - pnpm test:integration channels-telegram-roundtrip.test.ts (real-network
 *     integration suite per FILE-SPLIT-18)
 *
 * This snapshot scope is LIMITED to structural surface:
 *   (a) public exported symbol names
 *   (b) factory-returned handle's method-name shape
 *   (c) typeof checks on each handle method (function vs accessor)
 *   (d) handle.channelType + handle.channelId initial values
 *   (e) getStatus() initial-snapshot output BEFORE start() is called
 *
 * Per FILE-SPLIT-17 + Phase 42 OQ-5 (progressive deletion), this file +
 * its `__snapshots__/` neighbor are DELETED in the same commit as the
 * source-file split (Task 2) once the post-split modules reproduce the
 * structural snapshots byte-identical and the existing 63-it-block
 * telegram-adapter.test.ts proves out against the new barrel.
 */

function makeDeps(overrides?: Partial<TelegramAdapterDeps>): TelegramAdapterDeps {
  return {
    botToken: "123456:ABC-DEF",
    logger: createMockLogger(),
    ...overrides,
  };
}

describe("telegram-adapter parity (FILE-SPLIT-12)", () => {
  describe("public API surface", () => {
    it("exports the expected named symbols", () => {
      const exports = {
        createTelegramAdapter,
      };
      expect(stableStringify(Object.keys(exports).sort())).toMatchSnapshot();
    });
  });

  describe("behavior matrix: representative structural inputs", () => {
    it("createTelegramAdapter: returns handle with the expected method-name shape", () => {
      const handle: TelegramAdapterHandle = createTelegramAdapter(makeDeps());
      const keys = Object.keys(handle).sort();
      expect(stableStringify(keys)).toMatchSnapshot();
    });

    it("createTelegramAdapter: each handle member has the expected typeof signature", () => {
      const handle: TelegramAdapterHandle = createTelegramAdapter(makeDeps());
      const shape: Record<string, string> = {};
      for (const k of Object.keys(handle).sort()) {
        shape[k] = typeof (handle as unknown as Record<string, unknown>)[k];
      }
      expect(stableStringify(shape)).toMatchSnapshot();
    });

    it("createTelegramAdapter: channelType getter returns 'telegram'", () => {
      const handle = createTelegramAdapter(makeDeps());
      expect(stableStringify({ channelType: handle.channelType })).toMatchSnapshot();
    });

    it("createTelegramAdapter: channelId getter returns 'telegram-pending' before start()", () => {
      const handle = createTelegramAdapter(makeDeps());
      expect(stableStringify({ channelId: handle.channelId })).toMatchSnapshot();
    });

    it("createTelegramAdapter: getStatus() returns expected initial-disconnected snapshot before start()", () => {
      const handle = createTelegramAdapter(makeDeps());
      const status = handle.getStatus();
      // Strip non-deterministic fields (none expected pre-start, but defensive).
      expect(stableStringify(status)).toMatchSnapshot();
    });
  });
});
