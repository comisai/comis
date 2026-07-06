// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { vi } from "vitest";
import type { ComisLogger } from "@comis/core";
import type { ICreateClientOpts, MatrixClient } from "matrix-js-sdk";
import * as sdk from "matrix-js-sdk";
import { createMatrixPlugin } from "../matrix-plugin.js";
import type { MatrixAdapterDeps } from "../matrix-adapter.js";

const created: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-plugin-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeLogger(): ComisLogger {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as ComisLogger;
}

/** A fake client just rich enough for start()/stop() delegation (auth + /sync). */
class FakeMatrixClient {
  startCalls = 0;
  stopCalls = 0;
  private token: string | null = null;
  readonly store = {
    getSyncToken: (): string | null => this.token,
    setSyncToken: (t: string): void => {
      this.token = t;
    },
  };
  whoami(): Promise<{ user_id: string; device_id: string }> {
    return Promise.resolve({ user_id: "@bot:hs", device_id: "DEV1" });
  }
  on(): this {
    return this;
  }
  startClient(): Promise<void> {
    this.startCalls += 1;
    return Promise.resolve();
  }
  stopClient(): void {
    this.stopCalls += 1;
  }
  getUserId(): string | null {
    return "@bot:hs";
  }
  asClient(): MatrixClient {
    return this as unknown as MatrixClient;
  }
}

function makeDeps(fake: FakeMatrixClient): MatrixAdapterDeps {
  return {
    homeserverUrl: "http://127.0.0.1:8008",
    userId: "@bot:hs",
    accessToken: "token-abc",
    stateDir: tempDir(),
    allowFrom: [],
    allowMode: "allowlist",
    autoJoinOnInvite: true,
    allowPrivateHomeserver: true,
    logger: makeLogger(),
    createClientImpl: ((_opts: ICreateClientOpts): MatrixClient =>
      fake.asClient()) as unknown as typeof sdk.createClient,
  };
}

describe("createMatrixPlugin", () => {
  it("identifies as the matrix channel plugin with a stable id and version", () => {
    const plugin = createMatrixPlugin(makeDeps(new FakeMatrixClient()));

    expect(plugin.channelType).toBe("matrix");
    expect(plugin.id).toBe("channel-matrix");
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.adapter.channelType).toBe("matrix");
  });

  it("declares honest capability literals — nothing not-yet-real is advertised true", () => {
    const plugin = createMatrixPlugin(makeDeps(new FakeMatrixClient()));
    const { features, limits, replyToMetaKey } = plugin.capabilities;

    expect(features.reactions).toBe(true);
    expect(features.editMessages).toBe(false);
    expect(features.deleteMessages).toBe(false);
    expect(features.fetchHistory).toBe(true);
    expect(features.attachments).toBe(false);
    expect(features.typing).toBe(false);
    expect(features.threads).toBe(false);
    expect(features.buttons).toBe("none");
    expect(limits.maxMessageChars).toBe(32768);
    expect(replyToMetaKey).toBe("matrixEventId");
  });

  it("register returns ok without wiring hooks (channel plugins self-manage lifecycle)", () => {
    const plugin = createMatrixPlugin(makeDeps(new FakeMatrixClient()));
    const registered = plugin.register({ registerHook: () => undefined });
    expect(registered.ok).toBe(true);
  });

  it("delegates activate() to adapter.start() and deactivate() to adapter.stop()", async () => {
    const fake = new FakeMatrixClient();
    const plugin = createMatrixPlugin(makeDeps(fake));

    expect(plugin.adapter.getStatus?.().connected).toBe(false);

    const activated = await plugin.activate?.();
    expect(activated?.ok).toBe(true);
    expect(fake.startCalls).toBe(1);
    expect(plugin.adapter.getStatus?.().connected).toBe(true);

    const deactivated = await plugin.deactivate?.();
    expect(deactivated?.ok).toBe(true);
    expect(fake.stopCalls).toBe(1);
    expect(plugin.adapter.getStatus?.().connected).toBe(false);
  });
});
