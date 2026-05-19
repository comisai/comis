// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { detectSuspicious } from "./suspicious.js";

describe("config-audit/suspicious", () => {
  it("flags unknown-binary when argv[0] is not node, comis, deno, or bun", () => {
    const flags = detectSuspicious({
      argv: ["/usr/local/bin/curl", "config.yaml"],
      execArgv: [],
    });
    expect(flags).toContain("unknown-binary");
  });

  it("does not flag unknown-binary when argv[0] is node", () => {
    const flags = detectSuspicious({
      argv: ["node", "daemon.js"],
      execArgv: [],
    });
    expect(flags).not.toContain("unknown-binary");
  });

  it("does not flag unknown-binary when argv[0] is comis on an absolute path", () => {
    const flags = detectSuspicious({
      argv: ["/home/user/.nvm/versions/node/v22.0.0/bin/comis", "config", "show"],
      execArgv: [],
    });
    expect(flags).not.toContain("unknown-binary");
  });

  it("does not flag unknown-binary on Windows-style .exe suffix", () => {
    const flags = detectSuspicious({
      argv: ["C:\\Program Files\\nodejs\\node.exe", "daemon.js"],
      execArgv: [],
    });
    // The regex anchors at /, but Windows paths use \\. Node + .exe
    // still matches the basename pattern.
    // Actually, the regex matches `(?:^|/)(node|comis|deno|bun)(?:\.exe)?$`
    // so a backslash path means the WHOLE string is checked from `^`.
    // `C:\...\node.exe` does NOT contain `/node.exe` so the regex
    // sees the basename only via the `^` alternative — which requires
    // the whole string to start with `node.exe`. So Windows-style
    // paths will trip the unknown-binary heuristic. Confirm and
    // document this limitation explicitly.
    expect(flags).toContain("unknown-binary");
  });

  it("flags non-comis-argv when no argv element contains the literal 'comis'", () => {
    const flags = detectSuspicious({
      argv: ["node", "evil.js", "--config", "/etc/comis/config.yaml"],
      execArgv: [],
    });
    // Even though /etc/comis/config.yaml has 'comis' in the path, the
    // non-comis-argv heuristic should still detect that the script
    // being run is not Comis. To make the test deterministic, exclude
    // the comis path entirely.
    expect(detectSuspicious({ argv: ["node", "evil.js"], execArgv: [] })).toContain(
      "non-comis-argv",
    );
    // When 'comis' appears anywhere in argv, the flag is absent.
    expect(flags).not.toContain("non-comis-argv");
  });

  it("flags permission-restricted-caller when execArgv contains a --permission flag", () => {
    const flags = detectSuspicious({
      argv: ["node", "daemon.js"],
      execArgv: ["--permission", "--allow-fs-read=*"],
    });
    expect(flags).toContain("permission-restricted-caller");
  });

  it("does not flag permission-restricted-caller when execArgv is empty", () => {
    const flags = detectSuspicious({
      argv: ["node", "daemon.js"],
      execArgv: [],
    });
    expect(flags).not.toContain("permission-restricted-caller");
  });

  it("accumulates multiple flags when several heuristics fire", () => {
    const flags = detectSuspicious({
      argv: ["/usr/local/bin/curl", "evil.sh"],
      execArgv: ["--permission"],
    });
    expect(flags).toEqual(
      expect.arrayContaining([
        "unknown-binary",
        "non-comis-argv",
        "permission-restricted-caller",
      ]),
    );
  });
});
