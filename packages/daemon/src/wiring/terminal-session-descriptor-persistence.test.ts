// SPDX-License-Identifier: Apache-2.0
/**
 * The DAEMON-side durable SESSION-DESCRIPTOR store (`createSessionDescriptorStore` → a
 * {@link SessionDescriptorStorePort} impl).
 *
 * This is the SIBLING of the drive-journal store: the daemon impl of the port the
 * registry recover-on-boot consumes. It persists the content-free
 * {@link SessionDescriptor} (the session IDENTITY — allowId/owner/scope/tmuxName) at
 * create-time + recovers every descriptor on boot + removes one explicitly, all over
 * the confined per-agent `<dataDir>/terminal-drive/<agentId>/descriptors/` tree. It
 * mirrors VERBATIM-in-shape the atomic-durable-write substrate of the journal store —
 * `ensureContainedDir` (dir `0o700`) + `writeRegularFile` (file `0o600`) with `dataDir`
 * as the `confinedBaseDir` ancestor-symlink defense, a boot-time recover scan that
 * SKIPS a corrupt/partial file via `deserializeDescriptor`, failed persistence Results,
 * and an ENOENT-tolerant remove.
 *
 * The port is INSTANCE-bound to one `(dataDir, agentId)` because
 * `SessionDescriptorStorePort.persist(descriptor)`/`recover()`/`remove(sessionId)` are
 * the agent-scoped surface the registry deps inject; the daemon constructs one per
 * agent rooted at the SAME `<dataDir>` the journal store uses.
 *
 * The load-bearing properties pinned here:
 *   - ROUND-TRIP ACROSS A SIMULATED RESTART: persist → a FRESH store instance's
 *     recover() re-reads the same dir and yields the same descriptor (the recover-on-
 *     boot substrate). persist NEVER deletes — only the explicit remove does.
 *   - CONTENT-FREE: the persisted bytes carry ONLY ids/enums/counts (no screen text,
 *     no credential KEY), 0o600 in a 0o700 confined dir.
 *   - IDENTITY VERBATIM: the recovered descriptor carries the SAME allowId/owner/scope
 *     it was persisted with (durability changes WHERE not WHAT).
 *   - TOTAL recover: a corrupt-after-crash descriptor is a corrupt-SKIP
 *     (`deserializeDescriptor` → undefined), NEVER a throw; a write fault is returned.
 *
 * @module
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDescriptor } from "@comis/skills/tools";
import { err, ok } from "@comis/shared";
import {
  createSessionDescriptorStore,
  descriptorDir,
  DESCRIPTORS_SUBDIR,
  type SessionDescriptorPersistenceDeps,
} from "./terminal-session-descriptor-persistence.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT = "agent-1";

/** A realistic content-free descriptor (the store never rewrites it). */
function makeDescriptor(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    sessionId: "sess-a",
    tmuxName: "comis-sess-a",
    allowId: "claude-cli",
    owner: { agentId: AGENT, sessionKey: "" },
    cols: 80,
    rows: 24,
    durable: true,
    createdAt: 1_700_000_000_000,
    scope: {
      filesystem: "workspace",
      network: "none",
      uid: "dedicated",
      credentialPaths: [],
      ephemeralWritablePaths: [],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// REAL-fs idiom — round-trip across a simulated restart + on-disk 0o600/0o700
// (mirrors terminal-drive-journal-persistence.test.ts; H2: under os.tmpdir(), never ~/.comis)
// ---------------------------------------------------------------------------

describe("terminal-session-descriptor-persistence (durable descriptor store, real fs)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "comis-descriptor-store-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("round-trips a persisted descriptor through persist then a FRESH recover (the restart)", () => {
    const store = createSessionDescriptorStore({ dataDir, agentId: AGENT });
    const descriptor = makeDescriptor();
    store.persist(descriptor);

    // Simulated restart: a FRESH store instance's recover re-reads from disk.
    const fresh = createSessionDescriptorStore({ dataDir, agentId: AGENT });
    const recovered = fresh.recover();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toEqual(descriptor);
  });

  it("recovers every persisted session on a simulated daemon restart", () => {
    const store = createSessionDescriptorStore({ dataDir, agentId: AGENT });
    store.persist(makeDescriptor({ sessionId: "sess-a", tmuxName: "comis-sess-a" }));
    store.persist(makeDescriptor({ sessionId: "sess-b", tmuxName: "comis-sess-b" }));
    store.persist(makeDescriptor({ sessionId: "sess-c", tmuxName: "comis-sess-c" }));

    const recovered = createSessionDescriptorStore({ dataDir, agentId: AGENT }).recover();
    expect(recovered.map((d) => d.sessionId).sort()).toEqual(["sess-a", "sess-b", "sess-c"]);
  });

  it("isolates descriptors per agent (a different agentId recovers nothing)", () => {
    createSessionDescriptorStore({ dataDir, agentId: AGENT }).persist(makeDescriptor());
    expect(createSessionDescriptorStore({ dataDir, agentId: "other-agent" }).recover()).toHaveLength(0);
  });

  it("recovers the SAME allowId/owner/scope it was persisted with (durability changes WHERE not WHAT)", () => {
    const descriptor = makeDescriptor({
      allowId: "privileged-cli",
      owner: { agentId: AGENT, sessionKey: "" },
      scope: { filesystem: "listed-paths", network: "listed-hosts", uid: "dedicated", credentialPaths: ["/x"], ephemeralWritablePaths: [], paths: ["/p"], hosts: ["h"] },
    });
    createSessionDescriptorStore({ dataDir, agentId: AGENT }).persist(descriptor);

    const recovered = createSessionDescriptorStore({ dataDir, agentId: AGENT }).recover();
    expect(recovered[0]?.allowId).toBe("privileged-cli");
    expect(recovered[0]?.owner).toEqual({ agentId: AGENT, sessionKey: "" });
    expect(recovered[0]?.scope).toEqual(descriptor.scope);
  });

  it("writes under a confined terminal-drive/<agentId>/descriptors subdir (0o700 dir / 0o600 file)", () => {
    createSessionDescriptorStore({ dataDir, agentId: AGENT }).persist(makeDescriptor({ sessionId: "sess-x" }));

    const dir = descriptorDir(dataDir, AGENT);
    expect(dir).toBe(join(dataDir, "terminal-drive", AGENT, DESCRIPTORS_SUBDIR));

    const entries = readdirSync(dir);
    expect(entries).toContain("sess-x.json");

    // Dir mode 0o700, file mode 0o600 — the @comis/observability fs-safe invariants.
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "sess-x.json")).mode & 0o777).toBe(0o600);
  });

  it("persists only content-free identity keys (no credential KEY, no screen text)", () => {
    createSessionDescriptorStore({ dataDir, agentId: AGENT }).persist(makeDescriptor({ sessionId: "sess-secret" }));

    const raw = readFileSync(join(descriptorDir(dataDir, AGENT), "sess-secret.json"), "utf-8");
    // The persisted bytes carry NO credential-field STRUCTURE — only the content-free
    // descriptor identity keys; a screen/text key physically cannot appear.
    expect(raw).not.toMatch(/"(apiKey|password|secret|token|authorization|botToken|privateKey|screen|text)"\s*:/i);
  });

  it("recover SKIPS a corrupt/partial descriptor file instead of throwing (corrupt-after-crash → corrupt-skip)", () => {
    const store = createSessionDescriptorStore({ dataDir, agentId: AGENT });
    store.persist(makeDescriptor({ sessionId: "good", tmuxName: "comis-good" }));
    const dir = descriptorDir(dataDir, AGENT);
    mkdirSync(dir, { recursive: true });
    // A truncated-mid-write file + a non-JSON file + a structurally-invalid descriptor
    // (missing the load-bearing identity fields → deserializeDescriptor returns undefined).
    writeFileSync(join(dir, "corrupt.json"), "{ this is not json");
    writeFileSync(join(dir, "half.json"), '{"sessionId":"x"');
    writeFileSync(join(dir, "noidentity.json"), JSON.stringify({ sessionId: "z", cols: 1 }));

    const recovered = createSessionDescriptorStore({ dataDir, agentId: AGENT }).recover();
    // The good one survives intact; the malformed ones are skipped — never a throw.
    expect(() => createSessionDescriptorStore({ dataDir, agentId: AGENT }).recover()).not.toThrow();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.sessionId).toBe("good");
  });

  it("returns an empty list when the agent's descriptor dir does not exist yet", () => {
    expect(createSessionDescriptorStore({ dataDir, agentId: "fresh-agent" }).recover()).toHaveLength(0);
  });

  it("persist/recover NEVER delete; remove is a DISTINCT explicit ENOENT-tolerant call", () => {
    const store = createSessionDescriptorStore({ dataDir, agentId: AGENT });
    store.persist(makeDescriptor({ sessionId: "sess-keep", tmuxName: "comis-sess-keep" }));
    // Re-persisting / recovering repeatedly never removes the descriptor.
    store.recover();
    store.persist(makeDescriptor({ sessionId: "sess-other", tmuxName: "comis-sess-other" }));
    expect(store.recover().map((d) => d.sessionId).sort()).toEqual(["sess-keep", "sess-other"]);

    // Only the explicit remove deletes it (ENOENT-tolerant on a repeat).
    store.remove("sess-keep");
    expect(store.recover().map((d) => d.sessionId)).toEqual(["sess-other"]);
    expect(() => store.remove("sess-keep")).not.toThrow();
  });

  it("returns a failed result when the persist target is unwritable", () => {
    const fileAsDir = join(dataDir, "not-a-dir");
    writeFileSync(fileAsDir, "x");
    const store = createSessionDescriptorStore({ dataDir: fileAsDir, agentId: AGENT });
    expect(store.persist(makeDescriptor())).toMatchObject({ ok: false });
  });

  it("retains the previous descriptor when an atomic replacement cannot commit", () => {
    const initial = makeDescriptor({
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      serviceInstanceId: "service-instance_a",
    });
    expect(createSessionDescriptorStore({ dataDir, agentId: AGENT }).persist(initial)).toEqual(ok(undefined));

    const replacement = makeDescriptor({
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      serviceInstanceId: "service-instance_a",
      rootProcessIdentity: { pid: 6200, startIdentity: "linux:991" },
    });
    const renameError = new Error("EIO: descriptor rename failed");
    const failingDeps = {
      dataDir,
      agentId: AGENT,
      renameSync: () => {
        throw renameError;
      },
    } as SessionDescriptorPersistenceDeps & { renameSync: (from: string, to: string) => void };

    expect(createSessionDescriptorStore(failingDeps).persist(replacement)).toEqual(err(renameError));
    expect(createSessionDescriptorStore({ dataDir, agentId: AGENT }).recover()).toEqual([initial]);
  });

  it("reports persistence failure for a degenerate relative data directory", () => {
    const store = createSessionDescriptorStore({ dataDir: ".", agentId: AGENT });
    expect(store.persist(makeDescriptor())).toMatchObject({ ok: false });
    expect(() => store.recover()).not.toThrow();
    expect(store.recover()).toHaveLength(0);
    expect(() => store.remove("sess-a")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// INJECTED-fs idiom — mode-arg spies + the durable write + failure propagation
// (mirrors the journal-store injected-fs idiom; runs on macOS with no real disk).
// ---------------------------------------------------------------------------

describe("terminal-session-descriptor-persistence (injected fs — mode + durability)", () => {
  function spyDeps(): {
    deps: SessionDescriptorPersistenceDeps;
    ensured: Array<{ dir: string; mode: number; confinedBaseDir?: string }>;
    written: Array<{ path: string; content: string; confinedBaseDir?: string; fsyncBeforeSuccess?: true }>;
  } {
    const ensured: Array<{ dir: string; mode: number; confinedBaseDir?: string }> = [];
    const written: Array<{ path: string; content: string; confinedBaseDir?: string; fsyncBeforeSuccess?: true }> = [];
    const deps: SessionDescriptorPersistenceDeps = {
      dataDir: "/data",
      agentId: AGENT,
      ensureContainedDir: (opts) => {
        ensured.push({ dir: opts.dir, mode: opts.mode, confinedBaseDir: opts.confinedBaseDir });
        return ok({ created: true });
      },
      writeRegularFile: (opts) => {
        written.push({
          path: opts.path,
          content: typeof opts.content === "string" ? opts.content : opts.content.toString("utf8"),
          confinedBaseDir: opts.confinedBaseDir,
          fsyncBeforeSuccess: opts.fsyncBeforeSuccess,
        });
        return ok({ totalBytes: 1 });
      },
    };
    return { deps, ensured, written };
  }

  it("creates the descriptors dir at mode 0o700 with dataDir as the confinedBaseDir", () => {
    const s = spyDeps();
    createSessionDescriptorStore(s.deps).persist(makeDescriptor({ sessionId: "sess-a" }));
    expect(s.ensured).toHaveLength(1);
    expect(s.ensured[0].mode).toBe(0o700);
    expect(s.ensured[0].dir).toBe(join("/data", "terminal-drive", AGENT, "descriptors"));
    expect(s.ensured[0].confinedBaseDir).toBe("/data");
  });

  it("writes the serialized descriptor through the 0o600 fs-safe write with the confinedBaseDir", () => {
    const s = spyDeps();
    const descriptor = makeDescriptor({ sessionId: "sess-a" });
    createSessionDescriptorStore(s.deps).persist(descriptor);
    expect(s.written).toHaveLength(1);
    expect(s.written[0].path).toBe(join("/data", "terminal-drive", AGENT, "descriptors", "sess-a.json"));
    expect(s.written[0].confinedBaseDir).toBe("/data");
    expect(s.written[0].fsyncBeforeSuccess).toBe(true);
    // The bytes are exactly the SHIPPED serializeDescriptor output (no shape rewrite).
    expect(JSON.parse(s.written[0].content)).toEqual(descriptor);
  });

  it("returns a failed result for a thrown write fault", () => {
    const s = spyDeps();
    s.deps.writeRegularFile = () => {
      const e = new Error("EIO: i/o error");
      (e as { code?: string }).code = "EIO";
      throw e;
    };
    expect(createSessionDescriptorStore(s.deps).persist(makeDescriptor())).toMatchObject({ ok: false });
  });

  it("does not write after confined directory creation returns an error", () => {
    const s = spyDeps();
    s.deps.ensureContainedDir = () => err(new Error("directory unavailable"));

    expect(createSessionDescriptorStore(s.deps).persist(makeDescriptor())).toEqual(
      err(new Error("directory unavailable")),
    );
    expect(s.written).toHaveLength(0);
  });

  it("remove swallows ENOENT via the injected unlink (explicit-only)", () => {
    const unlink = vi.fn(() => {
      const e = new Error("ENOENT");
      (e as { code?: string }).code = "ENOENT";
      throw e;
    });
    const deps: SessionDescriptorPersistenceDeps = { dataDir: "/data", agentId: AGENT, unlinkSync: unlink };
    expect(() => createSessionDescriptorStore(deps).remove("gone")).not.toThrow();
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it("reports a descriptor deletion fault instead of claiming authority was removed", () => {
    const unlinkError = new Error("EIO: descriptor unlink failed");
    const deps: SessionDescriptorPersistenceDeps = {
      dataDir: "/data",
      agentId: AGENT,
      unlinkSync: () => {
        throw unlinkError;
      },
    };

    expect(createSessionDescriptorStore(deps).remove("sess-a") as unknown).toEqual(err(unlinkError));
  });
});
