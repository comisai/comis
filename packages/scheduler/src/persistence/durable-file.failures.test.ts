// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  chmod: vi.fn(),
  open: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("node:fs/promises", () => fsMocks);

import { replaceDurableFile } from "./durable-file.js";

function handle() {
  return {
    writeFile: vi.fn(async () => undefined),
    sync: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function input() {
  return {
    filePath: "/var/lib/comis/scheduler/authority.json",
    bytes: Buffer.from("{}\n", "utf8"),
    temporaryToken: () => "write-a",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fsMocks.mkdir.mockResolvedValue(undefined);
  fsMocks.chmod.mockResolvedValue(undefined);
  fsMocks.rename.mockResolvedValue(undefined);
  fsMocks.unlink.mockResolvedValue(undefined);
});

describe("durable file boundary failures", () => {
  it("rejects relative paths non-buffer content and failing token factories", async () => {
    await expect(replaceDurableFile({ ...input(), filePath: "relative.json" })).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_input", errorKind: "validation" },
    });
    await expect(replaceDurableFile({ ...input(), bytes: "not-bytes" as unknown as Buffer })).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_input", errorKind: "validation" },
    });
    await expect(replaceDurableFile({
      ...input(),
      temporaryToken: () => { throw new Error("entropy unavailable"); },
    })).resolves.toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fsMocks.mkdir).not.toHaveBeenCalled();
  });

  it("maps directory creation hardening and temporary open failures to io", async () => {
    fsMocks.mkdir.mockRejectedValueOnce(new Error("mkdir failed"));
    await expect(replaceDurableFile(input())).resolves.toMatchObject({ ok: false, error: { code: "io" } });

    fsMocks.chmod.mockRejectedValueOnce(new Error("chmod failed"));
    await expect(replaceDurableFile(input())).resolves.toMatchObject({ ok: false, error: { code: "io" } });

    fsMocks.open.mockRejectedValueOnce(new Error("open failed"));
    await expect(replaceDurableFile(input())).resolves.toMatchObject({ ok: false, error: { code: "io" } });
  });

  it("cleans temporary files after write sync close and rename failures", async () => {
    for (const stage of ["write", "sync", "close", "rename"] as const) {
      const temporary = handle();
      if (stage === "write") temporary.writeFile.mockRejectedValueOnce(new Error("write failed"));
      if (stage === "sync") temporary.sync.mockRejectedValueOnce(new Error("sync failed"));
      if (stage === "close") temporary.close.mockRejectedValueOnce(new Error("close failed"));
      if (stage === "rename") fsMocks.rename.mockRejectedValueOnce(new Error("rename failed"));
      fsMocks.open.mockResolvedValueOnce(temporary);

      await expect(replaceDurableFile(input())).resolves.toMatchObject({
        ok: false,
        error: { code: "io", errorKind: "internal" },
      });
    }
    expect(fsMocks.unlink).toHaveBeenCalledTimes(4);
  });

  it("reports final file and directory durability failures", async () => {
    const fileMode = handle();
    fsMocks.open.mockResolvedValueOnce(fileMode);
    fsMocks.chmod.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("file chmod failed"));
    await expect(replaceDurableFile(input())).resolves.toMatchObject({ ok: false, error: { code: "io" } });

    vi.clearAllMocks();
    fsMocks.mkdir.mockResolvedValue(undefined);
    fsMocks.chmod.mockResolvedValue(undefined);
    fsMocks.rename.mockResolvedValue(undefined);
    const noDirectory = handle();
    fsMocks.open.mockResolvedValueOnce(noDirectory).mockRejectedValueOnce(new Error("directory open failed"));
    await expect(replaceDurableFile(input())).resolves.toMatchObject({ ok: false, error: { code: "io" } });

    for (const stage of ["sync", "close"] as const) {
      vi.clearAllMocks();
      fsMocks.mkdir.mockResolvedValue(undefined);
      fsMocks.chmod.mockResolvedValue(undefined);
      fsMocks.rename.mockResolvedValue(undefined);
      const temporary = handle();
      const directory = handle();
      if (stage === "sync") directory.sync.mockRejectedValueOnce(new Error("directory sync failed"));
      if (stage === "close") directory.close.mockRejectedValueOnce(new Error("directory close failed"));
      fsMocks.open.mockResolvedValueOnce(temporary).mockResolvedValueOnce(directory);
      await expect(replaceDurableFile(input())).resolves.toMatchObject({ ok: false, error: { code: "io" } });
    }
  });
});
