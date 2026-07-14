import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..");
const entrypointPath = join(repoRoot, "docker", "comis-entrypoint.sh");
const temporaryDirectories: string[] = [];
const spawnedPids: number[] = [];

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "comis-xvfb-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    if (processIsAlive(pid)) process.kill(pid, "SIGTERM");
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("container entrypoint virtual-display readiness", () => {
  it("fails before daemon startup when Xvfb is unavailable", () => {
    const emptyPath = makeTemporaryDirectory();
    const result = spawnSync("/bin/sh", [entrypointPath, "/bin/sh", "-c", "exit 0"], {
      encoding: "utf8",
      env: { PATH: emptyPath, COMIS_WITH_XVFB: "1", DISPLAY: ":299" },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Xvfb.*(not found|unavailable)/i);
  });

  it("fails before daemon startup when Xvfb exits without a socket", () => {
    const binaryDirectory = makeTemporaryDirectory();
    writeExecutable(join(binaryDirectory, "Xvfb"), "#!/bin/sh\nexit 1\n");
    const result = spawnSync("/bin/sh", [entrypointPath, "/bin/sh", "-c", "exit 0"], {
      encoding: "utf8",
      env: {
        PATH: `${binaryDirectory}:/usr/bin:/bin`,
        COMIS_WITH_XVFB: "1",
        DISPLAY: ":298",
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Xvfb.*(exited|socket|ready)/i);
  });

  it("starts only after the X11 socket exists and stops Xvfb when the command exits", () => {
    const binaryDirectory = makeTemporaryDirectory();
    const pidFile = join(binaryDirectory, "xvfb.pid");
    const displayNumber = 297;
    const socketPath = `/tmp/.X11-unix/X${displayNumber}`;
    writeExecutable(
      join(binaryDirectory, "Xvfb"),
      `#!${process.execPath}\n` +
        `const fs = require("node:fs");\n` +
        `const net = require("node:net");\n` +
        `const display = process.argv[2].replace(/^:/, "").split(".")[0];\n` +
        `const socketPath = "/tmp/.X11-unix/X" + display;\n` +
        `fs.mkdirSync("/tmp/.X11-unix", { recursive: true });\n` +
        `try { fs.unlinkSync(socketPath); } catch {}\n` +
        `const server = net.createServer();\n` +
        `server.listen(socketPath, () => fs.writeFileSync(process.env.XVFB_PID_FILE, String(process.pid)));\n` +
        `const stop = () => server.close(() => process.exit(0));\n` +
        `process.on("SIGTERM", stop);\n` +
        `process.on("SIGINT", stop);\n` +
        `setInterval(() => {}, 1000);\n`,
    );

    const result = spawnSync(
      "/bin/sh",
      [entrypointPath, "/bin/sh", "-c", 'test -S "$XVFB_SOCKET_PATH"'],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: {
          PATH: `${binaryDirectory}:/usr/bin:/bin`,
          COMIS_WITH_XVFB: "1",
          DISPLAY: `:${displayNumber}`,
          XVFB_PID_FILE: pidFile,
          XVFB_SOCKET_PATH: socketPath,
        },
      },
    );

    if (existsSync(pidFile)) {
      spawnedPids.push(Number.parseInt(readFileSync(pidFile, "utf8"), 10));
    }
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    expect(processIsAlive(pid)).toBe(false);
  });
});
