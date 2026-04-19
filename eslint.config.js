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
  {
    files: [
      "packages/*/scripts/**/*.js",
      "scripts/**/*.js",
      "skills/*/scripts/**/*.js",
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
      ],
    },
  },
);
