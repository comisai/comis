// SPDX-License-Identifier: Apache-2.0
/**
 * Writer tests for the support bundle — the security backbone.
 *
 * These pin the write boundary where a leak or a symlink-escape would occur:
 * exactly the allowlisted files are written; a seeded secret in the doctor
 * object (the one file that echoes config-derived text) is value-shape masked
 * before it reaches disk, while the reducer's own content-free strings ride
 * through un-masked so the verdict is not corrupted; the manifest round-trips
 * through its parser with the redaction fingerprint, the caller's generatedAt,
 * the privacy declaration, and the warnings; a section that cannot be produced
 * folds into a warning and the other files are still written (partial output,
 * never a crash); and the bundle dir name carries a timestamp only — never a
 * host component.
 *
 * Temp dirs ONLY — never the real ~/.comis. The 0o700/0o600 mode bits and the
 * symlink refusal are asserted in writer.linux.test.ts (Pitfall: macOS umask
 * makes cross-platform perms asserts unreliable — gate those on Linux).
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";

import { safePath } from "@comis/core";

import { writeSupportBundle, ensureSupportBundleDir } from "./writer.js";
import {
  parseSupportBundleManifest,
  parseAuditSummary,
  type SupportTriage,
  type SupportBundleWarning,
} from "./types.js";

/** A well-known AWS example key — a shape the value-shape backstop redacts. */
const SEEDED_SECRET = "AKIAIOSFODNN7EXAMPLE";

/** Fixed generation instant so the bundle dir name is deterministic. */
const GENERATED_AT_MS = Date.UTC(2026, 6, 3, 12, 0, 0);

const tmpDirs: string[] = [];

function makeDataDir(): string {
  const dir = mkdtempSync(safePath(tmpdir(), "comis-bundle-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort teardown; a leaked temp dir must never fail the suite.
    }
  }
});

function makeTriage(overrides: Partial<SupportTriage> = {}): SupportTriage {
  return {
    schemaVersion: 1,
    status: "degraded",
    activeSignals: ["daemon_down"],
    host: {
      cliVersion: "1.0.45",
      daemonVersion: "1.0.45",
      nodeVersion: "v22.21.1",
      platform: "linux",
      arch: "x64",
    },
    doctorSummary: {
      checksRun: 9,
      pass: 7,
      warn: 1,
      fail: 1,
      skip: 0,
      repairable: 1,
      failing: ["config"],
    },
    reporterNextSteps: ["Run `comis doctor --repair`."],
    maintainerNextSteps: ["comis fleet --since 24"],
    evidenceFiles: [{ path: "triage.json", description: "machine-readable verdict" }],
    privacy: {
      redaction: "platform-aware-v1",
      excludes: ["secrets", "raw-config-values"],
    },
    ...overrides,
  };
}

function makeInput(
  overrides: {
    dataDir?: string;
    triage?: SupportTriage;
    issueSummaryMd?: string;
    doctorJson?: unknown;
    warnings?: SupportBundleWarning[];
  } = {},
) {
  return {
    dataDir: overrides.dataDir ?? makeDataDir(),
    generatedAtMs: GENERATED_AT_MS,
    triage: overrides.triage ?? makeTriage(),
    issueSummaryMd: overrides.issueSummaryMd ?? "# Comis support summary\n\n- ok\n",
    aiIssueDraftMd: "# Comis issue draft\n\n<REQUIRED: paste repro steps — do not invent>\n",
    doctorJson:
      overrides.doctorJson ??
      ({
        checksRun: 9,
        summary: { pass: 7, fail: 1, warn: 1, skip: 0, repairable: 1 },
        findings: [],
      } as unknown),
    ...(overrides.warnings !== undefined ? { warnings: overrides.warnings } : {}),
  };
}

/** Recompute the expected bundle dir the way the writer names it. */
function expectedBundleDir(dataDir: string): string {
  const tsIso = new Date(GENERATED_AT_MS).toISOString().replace(/[:.]/g, "-");
  return safePath(safePath(dataDir, "support-bundles"), `comis-support-${tsIso}`);
}

describe("writeSupportBundle", () => {
  it("writes exactly the allowlisted files into the bundle dir with no fleet or config-posture input", () => {
    // makeInput passes no fleetJson/configPostureJson, so the write set is the
    // five base files — the two digest files are spread in only when present.
    const result = writeSupportBundle(makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const files = readdirSync(result.value.bundleDir).sort();
    expect(files).toEqual([
      "ai-issue-draft.md",
      "doctor.json",
      "issue-summary.md",
      "manifest.json",
      "triage.json",
    ]);
  });

  it("names the bundle dir with a timestamp only, no host component", () => {
    const result = writeSupportBundle(makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const base = result.value.bundleDir.split("/").pop() ?? "";
    expect(base).toMatch(/^comis-support-[\dTZ.-]+$/);
  });

  it("value-shape masks a seeded secret in the written doctor.json — the file that echoes config text", () => {
    // doctor.json is the one bundle file that echoes config-derived free text
    // (DoctorFinding messages), so it alone carries the value-shape backstop. A
    // secret planted in a finding is masked before it reaches disk.
    const input = makeInput({
      doctorJson: { checksRun: 1, findings: [{ note: `credential ${SEEDED_SECRET}` }] },
    });
    const result = writeSupportBundle(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doctorJson = readFileSync(safePath(result.value.bundleDir, "doctor.json"), "utf8");
    expect(doctorJson).not.toContain(SEEDED_SECRET);
    // The sentinel proves the backstop ran (not that the field silently vanished).
    expect(doctorJson).toContain("<REDACTED:aws-access-key-id>");
  });

  it("writes a manifest that parses with the fingerprint, generatedAt, privacy, and warnings", () => {
    const incoming: SupportBundleWarning[] = [
      { source: "doctor", code: "doctor_run_failed", count: 1, message: "doctor could not run" },
    ];
    const input = makeInput({ warnings: incoming });
    const result = writeSupportBundle(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const raw = JSON.parse(
      readFileSync(safePath(result.value.bundleDir, "manifest.json"), "utf8"),
    ) as unknown;
    const parsed = parseSupportBundleManifest(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.redaction.policy).toBe("platform-aware-v1");
    expect(parsed.value.generatedAt).toBe(new Date(GENERATED_AT_MS).toISOString());
    expect(parsed.value.privacy.redaction).toBe("platform-aware-v1");
    expect(parsed.value.warnings?.some((w) => w.code === "doctor_run_failed")).toBe(true);

    // Incoming warnings are also surfaced on the returned result.
    expect(result.value.warnings.some((w) => w.code === "doctor_run_failed")).toBe(true);
  });

  it("records a warning and still writes the other files when a section body fails", () => {
    // A BigInt is not JSON-serializable → the doctor.json body throws; the
    // writer folds it into a warning and still writes the other three files.
    const result = writeSupportBundle(makeInput({ doctorJson: { bad: 10n } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bundleDir, warnings } = result.value;
    expect(warnings.some((w) => w.source === "writer")).toBe(true);
    expect(existsSync(safePath(bundleDir, "issue-summary.md"))).toBe(true);
    expect(existsSync(safePath(bundleDir, "triage.json"))).toBe(true);
    expect(existsSync(safePath(bundleDir, "manifest.json"))).toBe(true);
    expect(existsSync(safePath(bundleDir, "doctor.json"))).toBe(false);
  });

  it("records a warning and continues when a target file path is unwritable", () => {
    const dataDir = makeDataDir();
    const bundleDir = expectedBundleDir(dataDir);
    // Plant a directory where triage.json must go → its file write fails while
    // the other sections still succeed (partial output, no crash).
    mkdirSync(safePath(bundleDir, "triage.json"), { recursive: true });

    const result = writeSupportBundle(makeInput({ dataDir }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings.some((w) => w.source === "writer")).toBe(true);
    expect(existsSync(safePath(bundleDir, "issue-summary.md"))).toBe(true);
    expect(existsSync(safePath(bundleDir, "doctor.json"))).toBe(true);
    expect(existsSync(safePath(bundleDir, "manifest.json"))).toBe(true);
  });

  it("refuses a symlinked support-bundles dir and returns a hard error", () => {
    const dataDir = makeDataDir();
    const target = makeDataDir();
    // A symlink at the support-bundles slot could redirect writes outside the
    // data dir → ensureContainedDir refuses it; the bundle is unproducible.
    symlinkSync(target, safePath(dataDir, "support-bundles"));
    const result = writeSupportBundle(makeInput({ dataDir }));
    expect(result.ok).toBe(false);
    // The symlink target was never written into.
    expect(readdirSync(target)).toHaveLength(0);
  });
});

describe("writeSupportBundle preserves the reducer's own content-free strings", () => {
  // These strings are authored by the reducer itself — counts, category labels,
  // signal codes, and static remediation commands. They are content-free by
  // construction, yet several carry substrings the value-shape masker treats as
  // secret/payload FIELD NAMES ("key" in `sessionKey`, "secret" in `secrets`,
  // "message"/"content" in the exclusion labels). Masking them would corrupt the
  // machine-readable verdict AND desync triage.json's privacy block from the
  // verbatim copy the manifest writes — so the writer must NOT run the
  // value-shape pass over triage.json or issue-summary.md.
  const MAINTAINER_HINT = 'comis explain "<sessionKey>"';
  const REPORTER_HINT = "Set the variable in the environment or store it via comis secrets set";
  const PRIVACY_EXCLUDES = [
    "secrets",
    "raw-config-values",
    "message-bodies",
    "file-contents",
    ".env",
  ];

  /** A triage carrying the reducer's real field-name-bearing constants. */
  function reducerTriage(): SupportTriage {
    return makeTriage({
      activeSignals: ["secrets-audit"],
      doctorSummary: {
        checksRun: 9,
        pass: 7,
        warn: 0,
        fail: 1,
        skip: 1,
        repairable: 0,
        failing: ["secrets-audit"],
      },
      reporterNextSteps: [REPORTER_HINT],
      maintainerNextSteps: ["comis fleet --since 24", MAINTAINER_HINT],
      privacy: { redaction: "platform-aware-v1", excludes: [...PRIVACY_EXCLUDES] },
    });
  }

  it("writes a triage.json whose privacy block is byte-equal to the manifest's", () => {
    const result = writeSupportBundle(makeInput({ triage: reducerTriage() }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const triage = JSON.parse(
      readFileSync(safePath(result.value.bundleDir, "triage.json"), "utf8"),
    ) as { privacy: unknown };
    const manifest = JSON.parse(
      readFileSync(safePath(result.value.bundleDir, "manifest.json"), "utf8"),
    ) as { privacy: unknown };

    // The shared privacy declaration must not drift between the two artifacts.
    expect(triage.privacy).toEqual(manifest.privacy);
    expect(triage.privacy).toEqual({
      redaction: "platform-aware-v1",
      excludes: PRIVACY_EXCLUDES,
    });
  });

  it("does not mask the reducer's command hints or signal labels in triage.json or issue-summary.md", () => {
    const result = writeSupportBundle(
      makeInput({
        triage: reducerTriage(),
        issueSummaryMd: `# Comis support summary\n\n1. ${REPORTER_HINT}\n`,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const triageJson = readFileSync(safePath(result.value.bundleDir, "triage.json"), "utf8");
    const triage = JSON.parse(triageJson) as {
      activeSignals: string[];
      maintainerNextSteps: string[];
    };
    const issueSummary = readFileSync(
      safePath(result.value.bundleDir, "issue-summary.md"),
      "utf8",
    );

    // The machine-readable verdict round-trips verbatim — no sentinel over
    // trusted, content-free text.
    expect(triage.maintainerNextSteps).toContain(MAINTAINER_HINT);
    expect(triage.activeSignals).toContain("secrets-audit");
    expect(triageJson).not.toContain("<REDACTED:");
    // The paste-ready summary keeps a runnable instruction (not `comis
    // <REDACTED:secret-field>s set`).
    expect(issueSummary).toContain("comis secrets set");
    expect(issueSummary).not.toContain("<REDACTED:");
  });
});

describe("writeSupportBundle routes fleet.json and config-posture.json through the trusted leaf", () => {
  // Both new digest files are content-free BY CONSTRUCTION, so they ride the
  // trusted-leaf path (path substitution only) exactly like triage.json — NOT
  // the doctor.json value-shape pass, which would mangle a legitimate token-like
  // id or a field-name-bearing label. These pin the WRITER's routing decision;
  // the digests' actual content-freeness is guaranteed upstream (buildConfigPosture
  // / the fleet assembler) and swept by no-secret-survives.
  it("leaves a value-shape-maskable token in fleet.json and config-posture.json un-mangled", () => {
    const fleetJson = {
      schemaVersion: 1,
      findings: [{ code: "config_posture", detail: "gateway.tls (off)", count: 1, hint: "" }],
      autonomy: { worstRootRunId: SEEDED_SECRET },
    };
    const configPostureJson = {
      schemaVersion: 1,
      sections: ["gateway", "channels"],
      configPosture: { detail: `flagged run ${SEEDED_SECRET}`, count: 1, hint: "" },
    };
    const result = writeSupportBundle({ ...makeInput(), fleetJson, configPostureJson });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fleet = readFileSync(safePath(result.value.bundleDir, "fleet.json"), "utf8");
    const posture = readFileSync(safePath(result.value.bundleDir, "config-posture.json"), "utf8");

    // The maskable token survives verbatim — proving neither file ran the
    // value-shape pass (contrast the doctor.json case above, masked to a sentinel).
    expect(fleet).toContain(SEEDED_SECRET);
    expect(posture).toContain(SEEDED_SECRET);
    expect(fleet).not.toContain("<REDACTED:");
    expect(posture).not.toContain("<REDACTED:");
    // The content-free label rides through unchanged (value-shape would corrupt it).
    expect(fleet).toContain("gateway.tls (off)");
  });

  it("omits config-posture.json from the write set when its input is undefined but keeps fleet.json", () => {
    // Each digest is spread into the file plan ONLY when its JSON is defined, so
    // a caller that could not build config-posture (a config parse failure)
    // yields a bundle without that file while fleet.json still lands.
    const result = writeSupportBundle({ ...makeInput(), fleetJson: { schemaVersion: 1 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const files = readdirSync(result.value.bundleDir).sort();
    expect(files).toContain("fleet.json");
    expect(files).not.toContain("config-posture.json");
  });
});

describe("writeSupportBundle routes explain.json through the UNTRUSTED value-shape leaf", () => {
  // An AWS-access-key-id planted in a free-text incident field — a value-shape
  // the backstop redacts (the same shape the doctor.json case pins).
  const FREE_TEXT_SECRET = "AKIAIOSFODNN7EXAMPLE";

  /**
   * A minimal IncidentReport-shaped object carrying the content-free ids that
   * MUST round-trip un-mangled (a UUID traceId, a non-numeric colon-form
   * sessionKey, a tool name, and a clean root-cause code) plus a free-text
   * `errorPreview` seeded with a value-shape secret that MUST be masked.
   */
  function explainReport(): unknown {
    return {
      schemaVersion: 1,
      sessionKey: "acme:alice:general",
      traceId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      agentId: "default",
      channel: { type: "discord", id: "general" },
      outcome: { endReason: "completed", degraded: true, severity: "degraded" },
      toolStats: { read_file: { ok: 3, failed: 1 } },
      failures: [
        {
          seq: 1,
          toolName: "read_file",
          errorKind: "io",
          errorPreview: `tool failed: credential ${FREE_TEXT_SECRET} leaked`,
          resultDigest: "3 rows",
        },
      ],
      likelyRootCause: { code: "spend_exceeded", detail: "cap hit" },
    };
  }

  it("value-shape masks a secret in an explain.json free-text field", () => {
    const result = writeSupportBundle({ ...makeInput(), explainJson: explainReport() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const explain = readFileSync(safePath(result.value.bundleDir, "explain.json"), "utf8");
    // The seeded secret is masked, and the sentinel proves the value-shape pass ran.
    expect(explain).not.toContain(FREE_TEXT_SECRET);
    expect(explain).toContain("<REDACTED:aws-access-key-id>");
  });

  it("id round-trip golden: content-free ids survive VERBATIM through the untrusted leaf", () => {
    // The correlation-id risk: the value-shape pass masks secrets but must NOT
    // mangle the report's content-free correlation ids. A UUID traceId, a non-numeric
    // colon-form sessionKey, a tool name, and a clean root-cause code all
    // round-trip byte-for-byte — proven against the real redactor.
    const result = writeSupportBundle({ ...makeInput(), explainJson: explainReport() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const explain = readFileSync(safePath(result.value.bundleDir, "explain.json"), "utf8");
    expect(explain).toContain("3f2504e0-4f89-41d3-9a0c-0305e82c3301"); // UUID traceId
    expect(explain).toContain("acme:alice:general"); // colon-form sessionKey
    expect(explain).toContain("read_file"); // tool name
    expect(explain).toContain("spend_exceeded"); // root-cause code
  });

  it("redacts PII-shaped ids (numeric channel ids, keyword-bearing codes) — the accepted redaction tradeoff", () => {
    // Ground truth pinned so the tradeoff is not a hidden surprise: the untrusted
    // leaf INTENTIONALLY redacts a 9+ digit numeric channel/user id in a
    // sessionKey (a PII shape via long-decimal-id) and masks a root-cause code
    // that embeds a payload keyword (`context_exhausted` contains "text"). The
    // UUID traceId remains the stable, un-mangled correlation id. This is the
    // security-first cost of masking a secret-shaped substring in free text.
    const report = {
      schemaVersion: 1,
      sessionKey: "default:678314278:678314278:peer:678314278",
      traceId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      agentId: "default",
      likelyRootCause: { code: "context_exhausted", detail: "" },
    };
    const result = writeSupportBundle({ ...makeInput(), explainJson: report });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const explain = readFileSync(safePath(result.value.bundleDir, "explain.json"), "utf8");
    expect(explain).not.toContain("678314278"); // numeric id redacted (PII shape)
    expect(explain).toContain("<REDACTED:long-decimal-id>");
    expect(explain).toContain("<REDACTED:payload-field>"); // context_exhausted's "text"
    expect(explain).toContain("3f2504e0-4f89-41d3-9a0c-0305e82c3301"); // traceId still intact
  });
});

describe("writeSupportBundle routes audit-summary.json through the TRUSTED leaf", () => {
  it("writes counts and closed kind labels that round-trip un-mangled", () => {
    // `secret_access` is the discriminator: it carries the "secret" field-name
    // token, so the value-shape pass WOULD mask it — its verbatim survival proves
    // audit-summary.json rides the trusted (path-substitution-only) leaf.
    const auditSummaryJson = {
      schemaVersion: 1,
      total: 7,
      byKind: { secret_access: 3, command_blocked: 4 },
    };
    const result = writeSupportBundle({ ...makeInput(), auditSummaryJson });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const raw = readFileSync(safePath(result.value.bundleDir, "audit-summary.json"), "utf8");
    expect(raw).not.toContain("<REDACTED:");
    expect(raw).toContain("secret_access");

    const parsed = parseAuditSummary(JSON.parse(raw) as unknown);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.total).toBe(7);
    expect(parsed.value.byKind["secret_access"]).toBe(3);
    expect(parsed.value.byKind["command_blocked"]).toBe(4);
  });
});

describe("writeSupportBundle omits the new files when their inputs are absent", () => {
  it("writes neither explain.json nor audit-summary.json when both are undefined", () => {
    const result = writeSupportBundle(makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const files = readdirSync(result.value.bundleDir);
    expect(files).not.toContain("explain.json");
    expect(files).not.toContain("audit-summary.json");
  });
});

describe("ensureSupportBundleDir exposes the writer's dir derivation", () => {
  it("returns the same bundle dir the writer uses and is idempotent", () => {
    const dataDir = makeDataDir();
    const first = ensureSupportBundleDir(dataDir, GENERATED_AT_MS);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value).toBe(expectedBundleDir(dataDir));

    // A second call is a no-op create (ensureContainedDir) — same dir, no throw.
    const second = ensureSupportBundleDir(dataDir, GENERATED_AT_MS);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toBe(first.value);

    // writeSupportBundle reuses a pre-created dir when one is passed in.
    const result = writeSupportBundle({ ...makeInput({ dataDir }), bundleDir: first.value });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bundleDir).toBe(first.value);
    expect(existsSync(safePath(first.value, "manifest.json"))).toBe(true);
  });
});
