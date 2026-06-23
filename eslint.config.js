import js from "@eslint/js";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  // Global ignores - must be first, standalone object
  {
    ignores: [
      "**/*.test.ts",
      "**/*.config.*",
      "node_modules/**",
      "**/node_modules/**",
      "packages/*/dist/**",
      ".claude/worktrees/**",
      // GSD planning state (gitignored, commit_docs:false) — never product code.
      // Archived spike scripts / reproduction artifacts can be any extension
      // (.mjs/.ts); eslint must not lint planning artifacts.
      ".planning/**",
      "website/.astro/**",
      // Fixtures consumed as raw text by test helpers (e.g. parsed via
      // ts.createSourceFile). They are not compiled; lint rules like
      // no-unused-vars or ban-ts-comment do not apply meaningfully.
      "test/support/__fixtures__/**",
      // Secret-residency walker fixtures live under test/architecture/fixtures/;
      // the walker's source-rule integration in source-rules.test.ts cites
      // them alongside the other architecture-test fixtures. Same exemption
      // rationale as test/support/__fixtures__/.
      "test/architecture/fixtures/**",
      // Generated artifact from `pnpm contracts:generate`. The file carries
      // an `/* eslint-disable */` directive in its header banner, but adding
      // it to global ignores is belt-and-suspenders + avoids the parser
      // ever having to walk the 190-contract literal.
      "packages/web/src/api/contracts.generated.ts",
    ],
  },

  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript recommended rules (includes parser)
  ...tseslint.configs.recommended,

  // Security plugin recommended rules
  security.configs.recommended,

  // Allow underscore-prefixed vars (standard TS convention for intentionally unused params)
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },

  // Node build scripts (ESM/CJS) need node globals: process, console, require, etc.
  // `.mjs` is included for scripts/smoke/tarball-smoke.mjs (and any future ESM
  // Node scripts in the same locations).
  {
    files: [
      "packages/*/scripts/**/*.js",
      "packages/*/scripts/**/*.mjs",
      // src-adjacent dev/tooling scripts (e.g. terminal-driver fixture recorder)
      "packages/*/src/**/scripts/**/*.js",
      "packages/*/src/**/scripts/**/*.mjs",
      "scripts/**/*.js",
      "scripts/**/*.mjs",
      "skills/*/scripts/**/*.js",
      "skills/*/scripts/**/*.mjs",
      // CI workflow runner scripts (e.g. check-pr-description.mjs) run under Node.
      ".github/scripts/**/*.js",
      ".github/scripts/**/*.mjs",
      // Live channel-emulation harness CLI binaries (chan/tg/ask) run under Node.
      "test/live/bin/**/*.js",
      "test/live/bin/**/*.mjs",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Browser-facing web package uses DOM + browser globals.
  {
    files: ["packages/web/src/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  // Comis security enforcement for package source files
  {
    files: ["packages/*/src/**/*.ts"],
    plugins: {
      security,
    },
    rules: {
      // --- Ban eval() and dynamic code execution ---
      "security/detect-eval-with-expression": "error",
      "security/detect-non-literal-fs-filename": "warn",
      "security/detect-child-process": "warn",

      // --- Custom security rules via no-restricted-syntax ---
      "no-restricted-syntax": [
        "error",

        // Ban empty .catch(() => {})
        {
          selector:
            "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='BlockStatement'][body.body.length=0]",
          message:
            "Empty .catch() is banned. Use suppressError(promise, reason) from @comis/shared.",
        },

        // Ban raw path.join() - must use safePath() from @comis/core/security
        {
          selector: "MemberExpression[object.name='path'][property.name='join']",
          message:
            "Raw path.join() is banned for security. Use safePath() from @comis/core/security.",
        },

        // Ban direct process.env access - must use SecretManager
        {
          selector: "MemberExpression[object.object.name='process'][object.property.name='env']",
          message:
            "Direct process.env access is banned. Use SecretManager from @comis/core/security.",
        },

        // Ban Function() constructor (equivalent to eval)
        {
          selector: "NewExpression[callee.name='Function']",
          message: "Function() constructor is banned. It is equivalent to eval().",
        },

        // Ban `module:` inside Pino log-method payloads.
        //
        // Pino concatenates parent-bound fields (pre-serialized JSON
        // fragment) with the call-site object without dedup, so call
        // sites passing `{ module: "..." }` against a parent already
        // bound with `module: "<subsystem>"` (e.g. via getLogger())
        // emit BOTH keys on the same JSON line. Use `submodule:`
        // instead — see LogFields in @comis/infra.
        {
          selector:
            "CallExpression[callee.property.name=/^(info|warn|error|debug|audit|trace|fatal)$/] > ObjectExpression > Property[key.name='module']",
          message:
            "`module:` in a log payload duplicates the parent-bound `module` field on the emitted JSON line. Use `submodule:` instead (see LogFields in @comis/infra).",
        },

        // Ban the literal "[REDACTED]" string in production source.
        //
        // The Pino redact censor uses an edge-keeping mask callback (see
        // maskToken in @comis/observability/redact/edge-keeping.ts); the
        // only sanctioned production use of "[REDACTED]" is the
        // non-string fallback inside packages/infra/src/logging/
        // logger.ts, which carries an `// eslint-disable-next-line
        // no-restricted-syntax` annotation citing this rule.
        //
        // Mirrored by an architecture-test source-grep in
        // test/architecture/source-rules.test.ts (defense-in-depth:
        // ESLint catches the AST literal; the source-grep catches the
        // bytes in case ESLint is bypassed). eslint-plugin-comis does
        // NOT exist; we use no-restricted-syntax per house style.
        {
          selector: "Literal[value='[REDACTED]']",
          message:
            "The literal '[REDACTED]' is banned in production source. Use maskToken() from @comis/observability/redact instead. The one sanctioned use (non-string Pino censor fallback) carries an inline eslint-disable annotation.",
        },
      ],
    },
  },

  // The canonical logging schema declares `module` as a property of
  // LogFields; that legitimate property declaration would otherwise
  // trip the `module:`-in-log-payload guard above when ESLint walks the
  // ObjectExpression-style type literal. Disable the rule for the
  // logging schema files only — every other source file remains guarded.
  //
  // Keeping the carve-out narrow. The non-string Pino censor fallback
  // in logger.ts uses an inline `// eslint-disable-next-line
  // no-restricted-syntax` instead of relying on this file-level
  // carve-out, but the carve-out remains for the LogFields type-literal
  // `module` property declaration.
  {
    files: ["packages/infra/src/logging/**/*.ts"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
);
