import { describe, it, expect, beforeEach } from "vitest";
import {
  guardTelegramFileRefs,
  initTelegramFileGuardConfig,
  isTelegramFileGuardEnabled,
  ALWAYS_GUARD_EXTENSIONS,
  AMBIGUOUS_EXTENSIONS,
} from "./telegram-file-ref-guard.js";

describe("telegram-file-ref-guard", () => {
  beforeEach(() => {
    // Reset to default enabled config before each test
    initTelegramFileGuardConfig({
      enabled: true,
      additionalExtensions: [],
      excludedExtensions: [],
    });
  });

  // -------------------------------------------------------------------------
  // Always-guard extensions
  // -------------------------------------------------------------------------

  describe("always-guard extensions", () => {
    it("wraps config.go", () => {
      expect(guardTelegramFileRefs("check config.go for details")).toBe(
        "check <code>config.go</code> for details",
      );
    });

    it("wraps utils.py", () => {
      expect(guardTelegramFileRefs("see utils.py")).toBe(
        "see <code>utils.py</code>",
      );
    });

    it("wraps README.md", () => {
      expect(guardTelegramFileRefs("read README.md")).toBe(
        "read <code>README.md</code>",
      );
    });

    it("wraps script.sh", () => {
      expect(guardTelegramFileRefs("run script.sh")).toBe(
        "run <code>script.sh</code>",
      );
    });

    it("wraps main.rs", () => {
      expect(guardTelegramFileRefs("see main.rs")).toBe(
        "see <code>main.rs</code>",
      );
    });

    it("wraps handler.pl", () => {
      expect(guardTelegramFileRefs("edit handler.pl")).toBe(
        "edit <code>handler.pl</code>",
      );
    });

    it("wraps index.ts", () => {
      expect(guardTelegramFileRefs("open index.ts")).toBe(
        "open <code>index.ts</code>",
      );
    });

    it("wraps app.js", () => {
      expect(guardTelegramFileRefs("check app.js")).toBe(
        "check <code>app.js</code>",
      );
    });

    it("wraps multiple file refs in one string", () => {
      expect(guardTelegramFileRefs("edit config.go and utils.py")).toBe(
        "edit <code>config.go</code> and <code>utils.py</code>",
      );
    });

    it("wraps file ref at start of text", () => {
      expect(guardTelegramFileRefs("config.go is the main file")).toBe(
        "<code>config.go</code> is the main file",
      );
    });

    it("wraps file ref at end of text", () => {
      expect(guardTelegramFileRefs("edit config.go")).toBe(
        "edit <code>config.go</code>",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Full paths
  // -------------------------------------------------------------------------

  describe("full paths", () => {
    it("wraps entire path src/utils/helper.ts", () => {
      expect(guardTelegramFileRefs("see src/utils/helper.ts")).toBe(
        "see <code>src/utils/helper.ts</code>",
      );
    });

    it("wraps entire path packages/core/index.ts", () => {
      expect(guardTelegramFileRefs("open packages/core/index.ts")).toBe(
        "open <code>packages/core/index.ts</code>",
      );
    });

    it("wraps path with dot in directory name", () => {
      expect(guardTelegramFileRefs("see node_modules/.bin/vitest.js")).toBe(
        "see <code>node_modules/.bin/vitest.js</code>",
      );
    });

    it("wraps deeply nested path", () => {
      expect(guardTelegramFileRefs("edit a/b/c/d/e.ts")).toBe(
        "edit <code>a/b/c/d/e.ts</code>",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Already-escaped HTML input
  // -------------------------------------------------------------------------

  describe("HTML-escaped input", () => {
    it("does not break on &amp; in surrounding text", () => {
      expect(guardTelegramFileRefs("A &amp; B in config.go file")).toBe(
        "A &amp; B in <code>config.go</code> file",
      );
    });

    it("handles file ref next to &lt; entity", () => {
      expect(guardTelegramFileRefs("use &lt;config.go&gt;")).toBe(
        "use &lt;<code>config.go</code>&gt;",
      );
    });

    it("handles file ref followed by &amp; entity", () => {
      expect(guardTelegramFileRefs("config.go&amp;more")).toBe(
        "<code>config.go</code>&amp;more",
      );
    });
  });

  // -------------------------------------------------------------------------
  // No double-wrapping
  // -------------------------------------------------------------------------

  describe("no double-wrapping", () => {
    it("does not create nested <code> tags from its own output", () => {
      // Guard should not be called on already-guarded output in normal flow,
      // but verify it does not accidentally nest tags from a single pass.
      const result = guardTelegramFileRefs("config.go and utils.py");
      expect(result).toBe("<code>config.go</code> and <code>utils.py</code>");
      // Verify no nested <code><code>
      expect(result).not.toContain("<code><code>");
    });
  });

  // -------------------------------------------------------------------------
  // URL exclusion
  // -------------------------------------------------------------------------

  describe("URL exclusion", () => {
    it("does NOT guard https://example.go", () => {
      expect(guardTelegramFileRefs("visit https://example.go")).toBe(
        "visit https://example.go",
      );
    });

    it("does NOT guard http://api.py", () => {
      expect(guardTelegramFileRefs("see http://api.py")).toBe(
        "see http://api.py",
      );
    });

    it("does NOT guard bare domain example.com (.com not in set)", () => {
      expect(guardTelegramFileRefs("visit example.com")).toBe(
        "visit example.com",
      );
    });

    it("does NOT guard URLs with paths", () => {
      expect(guardTelegramFileRefs("see https://github.com/repo/main.go")).toBe(
        "see https://github.com/repo/main.go",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Ambiguous extensions
  // -------------------------------------------------------------------------

  describe("ambiguous extensions", () => {
    it("does NOT guard bare portfolio.io", () => {
      expect(guardTelegramFileRefs("visit portfolio.io")).toBe(
        "visit portfolio.io",
      );
    });

    it("guards src/lang.io with path prefix", () => {
      expect(guardTelegramFileRefs("see src/lang.io")).toBe(
        "see <code>src/lang.io</code>",
      );
    });

    it("guards import foo.ai with import keyword context", () => {
      expect(guardTelegramFileRefs("import foo.ai")).toBe(
        "import <code>foo.ai</code>",
      );
    });

    it("guards from bar.io with from keyword context", () => {
      expect(guardTelegramFileRefs("from bar.io")).toBe(
        "from <code>bar.io</code>",
      );
    });

    it("does NOT guard bare website.ai", () => {
      expect(guardTelegramFileRefs("check website.ai")).toBe(
        "check website.ai",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Configurable extensions
  // -------------------------------------------------------------------------

  describe("configurable extensions", () => {
    it("guards additional extension .kt", () => {
      initTelegramFileGuardConfig({
        enabled: true,
        additionalExtensions: [".kt"],
        excludedExtensions: [],
      });
      expect(guardTelegramFileRefs("see Main.kt")).toBe(
        "see <code>Main.kt</code>",
      );
    });

    it("does not guard excluded extension .md", () => {
      initTelegramFileGuardConfig({
        enabled: true,
        additionalExtensions: [],
        excludedExtensions: [".md"],
      });
      expect(guardTelegramFileRefs("read README.md")).toBe(
        "read README.md",
      );
    });

    it("additional without leading dot works", () => {
      initTelegramFileGuardConfig({
        enabled: true,
        additionalExtensions: ["kt"],
        excludedExtensions: [],
      });
      expect(guardTelegramFileRefs("see Main.kt")).toBe(
        "see <code>Main.kt</code>",
      );
    });

    it("excluded takes priority over always-guard", () => {
      initTelegramFileGuardConfig({
        enabled: true,
        additionalExtensions: [],
        excludedExtensions: ["go"],
      });
      expect(guardTelegramFileRefs("config.go")).toBe("config.go");
    });
  });

  // -------------------------------------------------------------------------
  // False positive prevention
  // -------------------------------------------------------------------------

  describe("false positive prevention", () => {
    it("does NOT guard hello.world (.world not in set)", () => {
      expect(guardTelegramFileRefs("hello.world")).toBe("hello.world");
    });

    it("does NOT guard version numbers like v2.0", () => {
      // .0 is only 1 char, regex requires 2-4 char extension
      expect(guardTelegramFileRefs("using v2.0")).toBe("using v2.0");
    });

    it("does NOT guard v2.10 (numeric extension not in set)", () => {
      expect(guardTelegramFileRefs("upgrade to v2.10")).toBe(
        "upgrade to v2.10",
      );
    });

    it("does NOT guard plain English sentences with periods", () => {
      expect(guardTelegramFileRefs("This is good. That is fine.")).toBe(
        "This is good. That is fine.",
      );
    });

    it("does NOT guard IP addresses", () => {
      expect(guardTelegramFileRefs("connect to 192.168")).toBe(
        "connect to 192.168",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Guard enabled/disabled
  // -------------------------------------------------------------------------

  describe("guard enabled/disabled", () => {
    it("isTelegramFileGuardEnabled returns true by default", () => {
      expect(isTelegramFileGuardEnabled()).toBe(true);
    });

    it("isTelegramFileGuardEnabled returns false when disabled", () => {
      initTelegramFileGuardConfig({
        enabled: false,
        additionalExtensions: [],
        excludedExtensions: [],
      });
      expect(isTelegramFileGuardEnabled()).toBe(false);
    });

    it("isTelegramFileGuardEnabled returns true when re-enabled", () => {
      initTelegramFileGuardConfig({
        enabled: false,
        additionalExtensions: [],
        excludedExtensions: [],
      });
      initTelegramFileGuardConfig({
        enabled: true,
        additionalExtensions: [],
        excludedExtensions: [],
      });
      expect(isTelegramFileGuardEnabled()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Extension registry exports
  // -------------------------------------------------------------------------

  describe("extension registries", () => {
    it("ALWAYS_GUARD_EXTENSIONS contains core set", () => {
      for (const ext of ["md", "go", "py", "pl", "sh", "rs", "ts", "js"]) {
        expect(ALWAYS_GUARD_EXTENSIONS.has(ext)).toBe(true);
      }
    });

    it("AMBIGUOUS_EXTENSIONS contains io and ai", () => {
      expect(AMBIGUOUS_EXTENSIONS.has("io")).toBe(true);
      expect(AMBIGUOUS_EXTENSIONS.has("ai")).toBe(true);
    });

    it("ALWAYS_GUARD_EXTENSIONS does not contain ambiguous extensions", () => {
      expect(ALWAYS_GUARD_EXTENSIONS.has("io")).toBe(false);
      expect(ALWAYS_GUARD_EXTENSIONS.has("ai")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles empty string", () => {
      expect(guardTelegramFileRefs("")).toBe("");
    });

    it("handles string with no file refs", () => {
      expect(guardTelegramFileRefs("just plain text")).toBe("just plain text");
    });

    it("handles file ref with hyphen in filename", () => {
      expect(guardTelegramFileRefs("edit my-config.ts")).toBe(
        "edit <code>my-config.ts</code>",
      );
    });

    it("handles file ref with dot in filename", () => {
      expect(guardTelegramFileRefs("see vitest.config.ts")).toBe(
        "see <code>vitest.config.ts</code>",
      );
    });

    it("handles file ref followed by comma", () => {
      expect(guardTelegramFileRefs("edit config.go, then deploy")).toBe(
        "edit <code>config.go</code>, then deploy",
      );
    });

    it("handles file ref followed by colon", () => {
      expect(guardTelegramFileRefs("config.go: the main config")).toBe(
        "<code>config.go</code>: the main config",
      );
    });

    it("handles file ref followed by closing paren", () => {
      expect(guardTelegramFileRefs("(see config.go)")).toBe(
        "(see <code>config.go</code>)",
      );
    });

    it("handles file ref in parenthetical path", () => {
      expect(guardTelegramFileRefs("(src/config.go)")).toBe(
        "(<code>src/config.go</code>)",
      );
    });

    it("handles consecutive calls (regex state reset)", () => {
      expect(guardTelegramFileRefs("config.go")).toBe("<code>config.go</code>");
      expect(guardTelegramFileRefs("utils.py")).toBe("<code>utils.py</code>");
      expect(guardTelegramFileRefs("main.rs")).toBe("<code>main.rs</code>");
    });
  });
});
