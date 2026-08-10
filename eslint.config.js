/// <reference types="node" />
// @ts-check
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import { fileURLToPath, URL } from "node:url";
import tseslint from "typescript-eslint";

const tsconfigRootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig([
  globalIgnores([
    "**/dist/**",
    "apps/agentd/bundle/**",
    "**/node_modules/**",
    "**/*.d.ts",
    "fixtures/**",
    "schemas/**",
  ]),

  {
    files: ["**/*.ts"],

    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],

    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir,
      },
    },

    rules: {
      // --- CLAUDE.md: "Never use `any`; avoid type assertions except
      // --- immediately after schema validation."
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",

      // --- CLAUDE.md: "Do not ... silently swallow errors." A daemon that
      // --- drops a rejected promise loses a task with no terminal state.
      // --- `node:test`'s describe/it return promises the runner owns, so they
      // --- are exempted by name rather than by switching the rule off.
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: [
                "describe",
                "it",
                "test",
                "suite",
                "before",
                "after",
                "beforeEach",
                "afterEach",
              ],
            },
          ],
        },
      ],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/return-await": ["error", "always"],

      // --- Discriminated unions are the project's state/event representation;
      // --- a missing arm must fail the build, not fall through.
      "@typescript-eslint/switch-exhaustiveness-check": "error",

      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // --- CLAUDE.md: "Spawn commands with argument arrays, never shell
      // --- interpolation. Default to no shell." Enforced at lint time so it
      // --- cannot be reintroduced by accident in an adapter.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:child_process",
              importNames: ["exec", "execSync"],
              message:
                "exec/execSync interpolate through a shell. Use spawn/execFile with an argv array.",
            },
            {
              name: "child_process",
              message: "Use the `node:child_process` specifier.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "Property[key.name='shell'][value.value=true]",
          message:
            "`shell: true` is forbidden. Spawn with an argv array (CLAUDE.md, security rules).",
        },
        {
          selector: "TSEnumDeclaration",
          message:
            "`enum` is not erasable syntax. Use a union of string literals.",
        },
      ],
    },
  },

  // Config files and other loose JS: worth linting for syntax and obvious
  // mistakes, but they are not part of a TypeScript project, so type-aware
  // rules cannot run on them.
  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [js.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        URL: "readonly",
        console: "readonly",
        process: "readonly",
      },
    },
  },
]);
