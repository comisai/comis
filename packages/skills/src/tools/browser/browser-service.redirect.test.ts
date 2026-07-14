// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const runtime = vi.hoisted(() => ({
  page: undefined as Page | undefined,
}));

vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    validateUrl: vi.fn(async (rawUrl: string) => {
      const url = new URL(rawUrl);
      if (url.pathname.includes("private")) {
        return {
          ok: false as const,
          error: new Error("Blocked: destination is private"),
        };
      }
      return {
        ok: true as const,
        value: { hostname: url.hostname, ip: "93.184.216.34", url },
      };
    }),
  };
});

vi.mock("./playwright-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./playwright-session.js")>();
  return {
    ...actual,
    getPage: vi.fn(async () => {
      if (!runtime.page) throw new Error("Browser page is not initialized");
      return runtime.page;
    }),
    getTargetId: vi.fn(async () => "redirect-test-page"),
  };
});

import { createBrowserService } from "./browser-service.js";

const bundledChromium = chromium.executablePath();
const browserExecutable = [
  bundledChromium,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((candidate) => existsSync(candidate));

describe.runIf(browserExecutable)("BrowserService redirect network policy", () => {
  let browser: Browser;
  let context: BrowserContext;
  let server: Server;
  let udpServer: UdpSocket;
  let origin: string;
  let udpOrigin: string;
  let privateEndpointHits = 0;
  let middleEndpointHits = 0;
  let startEndpointHits = 0;
  let workerSocketHits = 0;
  let windowSocketHits = 0;
  let udpPacketHits = 0;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/start") {
        startEndpointHits += 1;
        response.writeHead(302, { location: "/middle" });
        response.end();
        return;
      }
      if (request.url === "/middle") {
        middleEndpointHits += 1;
        response.writeHead(302, { location: "/private" });
        response.end();
        return;
      }
      if (request.url === "/page") {
        response.setHeader("content-type", "text/html");
        response.end('<img src="/private" alt="blocked resource">');
        return;
      }
      if (request.url === "/popup") {
        response.setHeader("content-type", "text/html");
        response.end("popup launcher");
        return;
      }
      if (request.url === "/sw.js") {
        response.setHeader("content-type", "application/javascript");
        response.end(
          "self.addEventListener('fetch', event => {" +
          "if (new URL(event.request.url).pathname === '/trigger') " +
          "event.respondWith(fetch('/private'));" +
          "});",
        );
        return;
      }
      if (request.url === "/worker-register" || request.url === "/controlled") {
        response.setHeader("content-type", "text/html");
        response.end("worker test page");
        return;
      }
      if (request.url === "/trigger") {
        response.end("direct response");
        return;
      }
      if (request.url === "/private") {
        privateEndpointHits += 1;
        response.end("private response");
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.on("upgrade", (request, socket) => {
      if (request.url === "/worker-private") workerSocketHits += 1;
      if (request.url === "/window-private") windowSocketHits += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
    udpServer = createSocket("udp4");
    udpServer.on("message", () => {
      udpPacketHits += 1;
    });
    await new Promise<void>((resolve, reject) => {
      udpServer.once("error", reject);
      udpServer.bind(0, "127.0.0.1", resolve);
    });
    const udpAddress = udpServer.address();
    udpOrigin = `127.0.0.1:${udpAddress.port}`;
    browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
  });

  beforeEach(async () => {
    privateEndpointHits = 0;
    middleEndpointHits = 0;
    startEndpointHits = 0;
    workerSocketHits = 0;
    windowSocketHits = 0;
    udpPacketHits = 0;
    context = await browser.newContext();
    runtime.page = await context.newPage();
  });

  afterEach(async () => {
    runtime.page = undefined;
    await context?.close();
  });

  afterAll(async () => {
    await browser?.close();
    udpServer?.close();
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
  });

  it("blocks a private redirect target before the browser reaches its endpoint", async () => {
    const service = createBrowserService({ timeoutMs: 5_000 });

    await expect(service.navigate({ url: `${origin}/start` })).rejects.toThrow();

    expect(startEndpointHits).toBe(1);
    expect(middleEndpointHits).toBe(1);
    expect(privateEndpointHits).toBe(0);
  });

  it("blocks a private page subresource before the browser reaches its endpoint", async () => {
    const service = createBrowserService({ timeoutMs: 5_000 });

    await expect(service.navigate({ url: `${origin}/page` })).resolves.toMatchObject({
      url: `${origin}/page`,
    });

    expect(privateEndpointHits).toBe(0);
  });

  it("blocks a page-created tab before its unguarded first request reaches the network", async () => {
    const service = createBrowserService({ timeoutMs: 5_000 });
    await service.navigate({ url: `${origin}/popup` });
    const popupCreated = context.waitForEvent("page");

    await runtime.page!.evaluate((url) => window.open(url), `${origin}/start`);
    const popup = await popupCreated;
    await popup.waitForTimeout(100);

    expect(startEndpointHits).toBe(0);
    expect(privateEndpointHits).toBe(0);
  });

  it("bypasses a pre-existing service worker before guarded page requests run", async () => {
    await runtime.page!.goto(`${origin}/worker-register`);
    await runtime.page!.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    });
    await runtime.page!.goto(`${origin}/controlled`);
    expect(await runtime.page!.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    const service = createBrowserService({ timeoutMs: 5_000 });
    await service.navigate({ url: `${origin}/controlled` });

    await runtime.page!.evaluate(async () => {
      await fetch("/trigger");
    });

    expect(privateEndpointHits).toBe(0);
  });

  it("blocks worker WebSockets that cannot pass through page request validation", async () => {
    const service = createBrowserService({ timeoutMs: 5_000 });
    await service.navigate({ url: `${origin}/page` });

    const outcome = await runtime.page!.evaluate(async (url) => {
      try {
        const source = `new WebSocket(${JSON.stringify(url)}); postMessage("started");`;
        const objectUrl = URL.createObjectURL(
          new Blob([source], { type: "application/javascript" }),
        );
        const worker = new Worker(objectUrl);
        await new Promise<void>((resolve) => {
          worker.onmessage = () => resolve();
          setTimeout(resolve, 250);
        });
        worker.terminate();
        URL.revokeObjectURL(objectUrl);
        return "started";
      } catch {
        return "blocked";
      }
    }, `${origin.replace("http://", "ws://")}/worker-private`);
    await runtime.page!.waitForTimeout(150);

    expect(outcome).toBe("blocked");
    expect(workerSocketHits).toBe(0);
  });

  it("blocks WebSockets in a document that loaded before its guard was installed", async () => {
    await runtime.page!.goto(`${origin}/page`);
    const service = createBrowserService({ timeoutMs: 5_000 });
    await service.console({});

    const outcome = await runtime.page!.evaluate((url) => {
      try {
        new WebSocket(url);
        return "started";
      } catch {
        return "blocked";
      }
    }, `${origin.replace("http://", "ws://")}/window-private`);
    await runtime.page!.waitForTimeout(150);

    expect(outcome).toBe("blocked");
    expect(windowSocketHits).toBe(0);
  });

  it("validates Window WebSockets after a guarded navigation", async () => {
    const service = createBrowserService({ timeoutMs: 5_000 });
    await service.navigate({ url: `${origin}/page` });

    const available = await runtime.page!.evaluate((url) => {
      try {
        new WebSocket(url);
        return true;
      } catch {
        return false;
      }
    }, `${origin.replace("http://", "ws://")}/window-private`);
    await runtime.page!.waitForTimeout(150);

    expect(available).toBe(true);
    expect(windowSocketHits).toBe(0);
  });

  it("blocks WebTransport before it can send unvalidated UDP traffic", async () => {
    const service = createBrowserService({ timeoutMs: 5_000 });
    await service.navigate({ url: `${origin}/page` });

    const outcome = await runtime.page!.evaluate((destination) => {
      try {
        const transport = new WebTransport(`https://${destination}/private`);
        void transport.ready.catch(() => undefined);
        return "started";
      } catch {
        return "blocked";
      }
    }, udpOrigin);
    await runtime.page!.waitForTimeout(300);

    expect(outcome).toBe("blocked");
    expect(udpPacketHits).toBe(0);
  });

  it("blocks WebRTC before it can probe a private UDP destination", async () => {
    const service = createBrowserService({ timeoutMs: 5_000 });
    await service.navigate({ url: `${origin}/page` });

    const outcome = await runtime.page!.evaluate(async (destination) => {
      try {
        const connection = new RTCPeerConnection({
          iceServers: [{ urls: `stun:${destination}` }],
        });
        connection.createDataChannel("probe");
        await connection.setLocalDescription(await connection.createOffer());
        await new Promise((resolve) => setTimeout(resolve, 300));
        connection.close();
        return "started";
      } catch {
        return "blocked";
      }
    }, udpOrigin);
    await runtime.page!.waitForTimeout(150);

    expect(outcome).toBe("blocked");
    expect(udpPacketHits).toBe(0);
  });

  it("rejects new service worker registrations with the browser policy error", async () => {
    const service = createBrowserService({ timeoutMs: 5_000 });
    await service.navigate({ url: `${origin}/page` });

    const errorName = await runtime.page!.evaluate(async () => {
      try {
        await navigator.serviceWorker.register("/sw.js");
        return "none";
      } catch (error) {
        return error instanceof DOMException ? error.name : "unknown";
      }
    });

    expect(errorName).toBe("SecurityError");
  });
});
