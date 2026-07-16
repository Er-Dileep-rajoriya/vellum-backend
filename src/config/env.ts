import "dotenv/config";
import { z } from "zod";

/**
 * Environment validation.
 *
 * The process refuses to start on a bad environment rather than discovering it at 3am when the
 * first request with a missing JWT secret arrives. Every failure mode below is one I have
 * personally watched take down a production service:
 *
 *  - a JWT secret that fell back to a default string ("changeme") in staging and then shipped;
 *  - CORS set to "*" alongside credentialed requests, which browsers refuse but a native client
 *    happily exploits;
 *  - a limit read as a string, compared with `>` against a number, and silently always true.
 *
 * So: parse, don't validate-later. Coerce numbers here, once, and export a frozen typed object.
 */

const NonEmpty = z.string().trim().min(1);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    HOST: z.string().default("0.0.0.0"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    DATABASE_URL: NonEmpty.describe("Postgres connection string"),

    /**
     * A wildcard origin cannot be combined with credentials, and this API is only ever called
     * with a bearer token from a known first-party web origin. Rejecting "*" here means a
     * misconfigured deploy fails loudly at boot instead of quietly disabling an access control.
     */
    CORS_ORIGINS: NonEmpty.transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ).pipe(
      z
        .array(z.url({ error: "CORS_ORIGINS must be a comma-separated list of absolute URLs" }))
        .min(1)
        .refine((origins) => !origins.includes("*"), {
          error: "CORS_ORIGINS must not contain '*': this API is called with credentials",
        }),
    ),

    /**
     * Shared with the frontend, which mints access tokens after an Auth.js session is established.
     * 32 bytes minimum: an HS256 secret shorter than its digest is a downgrade the algorithm
     * cannot warn you about.
     */
    API_JWT_SECRET: NonEmpty.min(32, {
      error: "API_JWT_SECRET must be at least 32 characters (openssl rand -base64 48)",
    }),
    API_JWT_ISSUER: NonEmpty.default("vellum-web"),
    API_JWT_AUDIENCE: NonEmpty.default("vellum-api"),

    /** Service-to-service credential for the frontend's Auth.js callbacks (user create/lookup). */
    SERVICE_TOKEN: NonEmpty.min(32, {
      error: "SERVICE_TOKEN must be at least 32 characters",
    }),

    /**
     * DeepSeek powers the AI add-on features. Its API is OpenAI-compatible, so it is driven through
     * the `openai` SDK pointed at `DEEPSEEK_BASE_URL` (see ai.service.ts).
     *
     * The key is OPTIONAL: blank simply disables the AI endpoints (they return a clear "not
     * configured" error) while the rest of the product runs. Nothing else in the app depends on it, so
     * it is not worth failing the boot over — unlike the JWT secret, whose absence is a security hole.
     */
    DEEPSEEK_API_KEY: z.string().default(""),
    DEEPSEEK_MODEL: NonEmpty.default("deepseek-chat"),
    DEEPSEEK_BASE_URL: z.url().default("https://api.deepseek.com"),

    MAX_REQUEST_BYTES: z.coerce.number().int().positive().default(1_048_576),
    RATE_LIMIT_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(120),
    RATE_LIMIT_OPS_PER_MINUTE: z.coerce.number().int().positive().default(600),
    RATE_LIMIT_AI_PER_HOUR: z.coerce.number().int().positive().default(60),

    /**
     * AWS SES — transactional email (OTP for email verification and password reset).
     *
     * Credentials are read here rather than from the ambient AWS credential chain on purpose: this
     * service is deployed to platforms (Fly, a bare container) that have no instance role, so the
     * key pair in the environment is the only source. The SES client is constructed with them
     * explicitly in email.service.ts.
     *
     * These are OPTIONAL at the base schema and REQUIRED in production (see the superRefine below).
     * That split is deliberate: CI and local unit runs never send an email — no test should have to
     * carry live AWS credentials to boot the app — while production must not start without the
     * ability to deliver a password-reset code. A missing key in dev/test yields an SES client that
     * simply fails the (already swallowed) send; a missing key in production fails the boot.
     */
    AWS_REGION: NonEmpty.default("ap-south-1"),
    AWS_ACCESS_KEY_ID: z.string().default(""),
    AWS_SECRET_ACCESS_KEY: z.string().default(""),
    // Validated as an email only when set — an empty value is allowed outside production and the
    // production block below is what rejects it there. A bad *non-empty* value fails everywhere.
    AWS_SES_FROM_EMAIL: z
      .string()
      .default("")
      .refine((v) => v === "" || z.email().safeParse(v).success, {
        error: "AWS_SES_FROM_EMAIL must be a valid, SES-verified email address",
      }),
    AWS_SES_FROM_NAME: NonEmpty.default("Vellum"),

    /**
     * The public origin of the frontend, used to build invitation links in transactional email
     * (`${APP_URL}/invite/<token>`). Optional: when blank it falls back to the first CORS origin,
     * which is the frontend origin by construction (see DEPLOYMENT.md). Validated as a URL only when
     * set, so a typo fails at boot rather than producing a dead link in someone's inbox.
     */
    APP_URL: z
      .string()
      .default("")
      .refine((v) => v === "" || z.url().safeParse(v).success, {
        error: "APP_URL must be an absolute URL (e.g. https://vellum.paperflow.in)",
      }),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;

    /**
     * Production-only invariants. These are separate from the base schema because development
     * must stay frictionless (a generated dev secret is fine) while production must not be able
     * to boot with a placeholder that someone forgot to replace.
     */
    if (/dev-only|replace-me|changeme|secret/i.test(env.API_JWT_SECRET)) {
      ctx.addIssue({
        code: "custom",
        path: ["API_JWT_SECRET"],
        message: "API_JWT_SECRET looks like a placeholder and NODE_ENV=production",
      });
    }
    if (/dev-only|replace-me|changeme/i.test(env.SERVICE_TOKEN)) {
      ctx.addIssue({
        code: "custom",
        path: ["SERVICE_TOKEN"],
        message: "SERVICE_TOKEN looks like a placeholder and NODE_ENV=production",
      });
    }
    if (env.CORS_ORIGINS.some((origin) => origin.startsWith("http://"))) {
      ctx.addIssue({
        code: "custom",
        path: ["CORS_ORIGINS"],
        message: "plaintext http:// origin is not allowed in production",
      });
    }

    // SES is optional to *boot* in dev/test but mandatory in production: a prod server that cannot
    // send email cannot verify a sign-up or reset a password, and discovering that at the first
    // reset request is exactly the 3am failure this schema exists to prevent.
    if (env.AWS_ACCESS_KEY_ID === "") {
      ctx.addIssue({
        code: "custom",
        path: ["AWS_ACCESS_KEY_ID"],
        message: "AWS_ACCESS_KEY_ID is required in production (SES sends verification/reset email)",
      });
    }
    if (env.AWS_SECRET_ACCESS_KEY === "") {
      ctx.addIssue({
        code: "custom",
        path: ["AWS_SECRET_ACCESS_KEY"],
        message: "AWS_SECRET_ACCESS_KEY is required in production",
      });
    }
    if (env.AWS_SES_FROM_EMAIL === "") {
      ctx.addIssue({
        code: "custom",
        path: ["AWS_SES_FROM_EMAIL"],
        message: "AWS_SES_FROM_EMAIL is required in production and must be SES-verified",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    // Fail at boot, on stderr, with every problem at once — not one per restart.
    const issues = parsed.error.issues
      .map((issue) => `  • ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    process.stderr.write(`\nInvalid environment configuration:\n${issues}\n\n`);
    process.exit(1);
  }

  return Object.freeze(parsed.data);
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
