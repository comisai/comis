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
      "website/.astro/**",
      // Fixtures consumed as raw text by test helpers (e.g. parsed via
      // ts.createSourceFile). They are not compiled; lint rules like
      // no-unused-vars or ban-ts-comment do not apply meaningfully.
      "test/support/__fixtures__/**",
      // Phase 31 plan 08 (MEM-CTX-PORTS-14 part 1) — secret-residency
      // walker fixtures live under test/architecture/fixtures/ (per plan
      // spec; the path differs from test/support/__fixtures__ because the
      // walker's source-rule integration in source-rules.test.ts cites
      // them alongside the other architecture-test fixtures). Same
      // exemption rationale as test/support/__fixtures__/.
      "test/architecture/fixtures/**",
      // Phase 35 Wave D Plan 35-20 — generated artifacts from
      // `pnpm contracts:generate` (Plan 35-20 OQ-3). The file carries an
      // `/* eslint-disable */` directive in its header banner, but adding
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
  // `.mjs` is included for Plan 36-06's scripts/smoke/tarball-smoke.mjs (and any
  // future ESM Node scripts in the same locations).
  {
    files: [
      "packages/*/scripts/**/*.js",
      "packages/*/scripts/**/*.mjs",
      "scripts/**/*.js",
      "scripts/**/*.mjs",
      "skills/*/scripts/**/*.js",
      "skills/*/scripts/**/*.mjs",
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
      ],
    },
  },

  // The canonical logging schema declares `module` as a property of
  // LogFields; that legitimate property declaration would otherwise
  // trip the `module:`-in-log-payload guard above when ESLint walks the
  // ObjectExpression-style type literal. Disable the rule for the
  // logging schema files only — every other source file remains guarded.
  {
    files: ["packages/infra/src/logging/**/*.ts"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
);
