// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for isFsyncDisabledByPermissionModel — the pure predicate that
 * distinguishes Node's Permission Model fsync refusal (swallow → graceful
 * degrade) from genuine I/O failures (must propagate).
 */
import { describe, it, expect } from "vitest";
import { isFsyncDisabledByPermissionModel } from "./fsync-permission.js";

describe("isFsyncDisabledByPermissionModel", () => {
  it("matches the real Node permission-model fsync message", () => {
    // Exact string emitted by Node 22.x under --permission (captured from a
    // production daemon FATAL on 2026-06-02).
    const e = new Error("fsync API is disabled when Permission Model is enabled.");
    expect(isFsyncDisabledByPermissionModel(e)).toBe(true);
  });

  it("matches the fchmod message (same disabled-fs-API family)", () => {
    // Node --permission disables the whole fd-based fs API family with the
    // same wording. fchmod refusal blocked MCP OAuth discovery and
    // session-metadata writes on a production VPS (2026-06-02).
    const e = new Error("fchmod API is disabled when Permission Model is enabled.");
    expect(isFsyncDisabledByPermissionModel(e)).toBe(true);
  });

  it("matches other disabled fd-syscalls (fdatasync, fchown)", () => {
    expect(
      isFsyncDisabledByPermissionModel(
        new Error("fdatasync API is disabled when Permission Model is enabled."),
      ),
    ).toBe(true);
    expect(
      isFsyncDisabledByPermissionModel(
        new Error("fchown API is disabled when Permission Model is enabled."),
      ),
    ).toBe(true);
  });

  it("matches by ERR_ACCESS_DENIED code regardless of message wording", () => {
    const e = Object.assign(new Error("whatever"), { code: "ERR_ACCESS_DENIED" });
    expect(isFsyncDisabledByPermissionModel(e)).toBe(true);
  });

  it("does NOT match a genuine fsync I/O error (EIO)", () => {
    const e = Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
    expect(isFsyncDisabledByPermissionModel(e)).toBe(false);
  });

  it("does NOT match a bad/closed descriptor error (EBADF)", () => {
    const e = Object.assign(new Error("EBADF: bad file descriptor, fsync"), { code: "EBADF" });
    expect(isFsyncDisabledByPermissionModel(e)).toBe(false);
  });

  it("does NOT match a permission-model denial unrelated to fsync", () => {
    // A generic permission-model message without "fsync" must not be swallowed
    // by an fsync call site.
    const e = new Error("Access to this API has been restricted by the Permission Model");
    expect(isFsyncDisabledByPermissionModel(e)).toBe(false);
  });

  it("does NOT match an fsync failure unrelated to the permission model", () => {
    const e = new Error("fsync failed: device not ready");
    expect(isFsyncDisabledByPermissionModel(e)).toBe(false);
  });

  it("returns false for null, undefined, strings, and shapeless objects", () => {
    expect(isFsyncDisabledByPermissionModel(null)).toBe(false);
    expect(isFsyncDisabledByPermissionModel(undefined)).toBe(false);
    expect(isFsyncDisabledByPermissionModel("ERR_ACCESS_DENIED")).toBe(false);
    expect(isFsyncDisabledByPermissionModel({})).toBe(false);
    expect(isFsyncDisabledByPermissionModel(42)).toBe(false);
  });
});
