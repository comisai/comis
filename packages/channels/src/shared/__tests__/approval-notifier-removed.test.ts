// SPDX-License-Identifier: Apache-2.0
/**
 * Approval-notifier removal assertion (no-backward-compat).
 *
 * The old `approval-notifier.ts` was a SECOND, racing approval-text path:
 * it subscribed to `approval:requested` directly and sent chat text,
 * duplicating the prompt the signed activity-renderer path now owns on every
 * channel. It is hard-deleted — no shim, no alias, no migration (AGENTS.md
 * §2.9; mirrors the file-absent + no-alias idiom of
 * `test/architecture/no-backward-compat.test.ts`).
 *
 * This test pins the deletion so the notifier cannot return as a stray
 * re-export or as leftover daemon wiring. It asserts three things:
 *
 *   1. `approval-notifier.ts` and its `.test.ts` no longer exist on disk.
 *   2. The `@comis/channels` barrel (`packages/channels/src/index.ts`)
 *      source re-exports neither `createApprovalNotifier` nor the
 *      `ApprovalNotifier` / `ApprovalNotifierDeps` types (no alias).
 *   3. None of the five daemon wiring sites
 *      (`setup-channels-runtime`, `setup-channels-registry`,
 *      `setup-shutdown`, `daemon-types`, `daemon.ts`) reference
 *      `approvalNotifier` / `approvalNotifierStop` / `createApprovalNotifier`.
 *
 * It is a grep-style source assertion (not a runtime import) because the
 * symbols and files it forbids must be absent — there is nothing to import.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// __tests__ → shared → src → channels → packages → REPO_ROOT
const REPO_ROOT = resolve(here, "../../../../..");

function repoPath(...segments: string[]): string {
  return resolve(REPO_ROOT, ...segments);
}

describe("approval-notifier-removed", () => {
  it("approval-notifier.ts and approval-notifier.test.ts no longer exist on disk", () => {
    expect(
      existsSync(repoPath("packages/channels/src/shared/approval-notifier.ts")),
      "packages/channels/src/shared/approval-notifier.ts must be deleted (no-backward-compat)",
    ).toBe(false);
    expect(
      existsSync(
        repoPath("packages/channels/src/shared/approval-notifier.test.ts"),
      ),
      "packages/channels/src/shared/approval-notifier.test.ts must be deleted (no-backward-compat)",
    ).toBe(false);
  });

  it("the @comis/channels barrel re-exports neither createApprovalNotifier nor the ApprovalNotifier types", () => {
    const barrel = readFileSync(
      repoPath("packages/channels/src/index.ts"),
      "utf8",
    );
    expect(
      barrel,
      "channels/src/index.ts must not re-export createApprovalNotifier (no alias — no-backward-compat)",
    ).not.toMatch(/createApprovalNotifier/);
    expect(
      barrel,
      "channels/src/index.ts must not re-export the ApprovalNotifier types (no alias — no-backward-compat)",
    ).not.toMatch(/ApprovalNotifier/);
    expect(
      barrel,
      "channels/src/index.ts must not reference the deleted approval-notifier module",
    ).not.toMatch(/approval-notifier/);
  });

  it("none of the five daemon wiring sites reference approvalNotifier / approvalNotifierStop / createApprovalNotifier", () => {
    const daemonWiringFiles = [
      "packages/daemon/src/wiring/setup-channels/setup-channels-runtime.ts",
      "packages/daemon/src/wiring/setup-channels/setup-channels-registry.ts",
      "packages/daemon/src/wiring/setup-shutdown.ts",
      "packages/daemon/src/daemon-types.ts",
      "packages/daemon/src/daemon.ts",
    ];
    const offenders: string[] = [];
    const forbidden = /createApprovalNotifier|approvalNotifierStop|approvalNotifier|ApprovalNotifier/;
    for (const rel of daemonWiringFiles) {
      const text = readFileSync(repoPath(rel), "utf8");
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (forbidden.test(lines[i] ?? "")) {
          offenders.push(`${rel}:${i + 1}: ${(lines[i] ?? "").trim()}`);
        }
      }
    }
    expect(
      offenders,
      `Daemon composition root must not wire the deleted approval notifier. Offending lines:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
