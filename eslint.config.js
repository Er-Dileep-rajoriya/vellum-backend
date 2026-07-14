import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Lint rules that encode the architecture, not just the formatting.
 *
 * Prettier owns whitespace; this file owns *correctness and layering*. A lint rule that argues about
 * semicolons is noise. A lint rule that stops a route handler from importing Prisma directly — thereby
 * bypassing the authorization layer — is a design decision that enforces itself at 3am when nobody is
 * reviewing carefully.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "src/generated/**",
      "node_modules/**",
      "coverage/**",
      "eslint.config.js",
      // Deployment config, not application code: a CommonJS file pm2 reads, deliberately outside the
      // TypeScript project. Type-aware linting cannot see it (`was not found by the project service`),
      // and adding it to tsconfig to satisfy the linter would put a pm2 config in the compiler's input.
      "ecosystem.config.cjs",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },

    rules: {
      /**
       * `any` is banned outright. It is not a type — it is a hole in the type system, and every one
       * of them is a place where the compiler stops helping. In a sync engine whose correctness rests
       * on the compiler refusing to let an `undefined` become an operation id, that is not a trade
       * worth making. Use `unknown` and narrow.
       */
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",

      /** A floating promise is a silently swallowed failure. Await it, or mark it `void` on purpose. */
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      // `catch (error: unknown)` is enforced by tsconfig; this stops the error being used unchecked.
      "@typescript-eslint/no-unnecessary-condition": "warn",

      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],

      /**
       * Fastify's plugin signature is `async (app) => void` — the framework awaits the returned
       * promise even when the body has nothing to await. `require-await` flags every route file as a
       * result, which is a false positive on a framework contract we do not control.
       */
      "@typescript-eslint/require-await": "off",

      /** `_reply` and friends: Fastify hands you parameters you do not always need. */
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      /** `() => doSomething()` where the callee returns void is idiomatic, not confusing. */
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],

      /**
       * No `console`. The service has a structured logger with a redaction list (utils/logger.ts) —
       * a stray `console.log(user)` bypasses it and puts a password hash or an access token into the
       * log aggregator, where it is effectively public inside the company forever.
       */
      "no-console": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],

      /**
       * The layering rule, enforced by the linter rather than by hope.
       *
       * Routes must not touch Prisma. Every database access goes through a repository, and every
       * repository method takes an `Actor` (D-011) — which is what makes "forgot to check permissions"
       * a compile error rather than a breach. A route that imports `prisma` directly has stepped
       * around that entire mechanism, and it would look completely innocent in a diff.
       */
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/database/client*", "**/database/client*"],
              message:
                "Routes and services must not import Prisma directly. Go through a repository — every repository method takes an Actor, which is what makes authorization impossible to forget.",
            },
          ],
        },
      ],
    },
  },

  /** Repositories and the collaboration hub ARE the layer allowed to touch the database. */
  {
    files: [
      "src/repositories/**",
      "src/database/**",
      "src/services/sync.service.ts",
      "src/ai/**",
      "src/routes/auth.routes.ts",
      // main.ts owns the process lifecycle, which includes closing the connection pool on SIGTERM.
      "src/main.ts",
    ],
    rules: { "no-restricted-imports": "off" },
  },

  /** Tests and scripts may reach for anything — they are the harness, not the product. */
  {
    files: ["tests/**", "scripts/**", "prisma/**", "*.config.ts", "prisma.config.ts"],
    rules: {
      "no-restricted-imports": "off",
      "no-console": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
);
