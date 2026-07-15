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

    ANTHROPIC_API_KEY: z.string().default(""),
    ANTHROPIC_MODEL: NonEmpty.default("claude-opus-4-8"),

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
     * `AWS_SES_FROM_EMAIL` must be an address (or a domain) verified in SES, or every send is
     * rejected by the API. It is validated as an email here so a typo fails at boot, not at the
     * first password-reset request.
     */
    AWS_REGION: NonEmpty.default("ap-south-1"),
    AWS_ACCESS_KEY_ID: NonEmpty.describe("AWS access key id for SES"),
    AWS_SECRET_ACCESS_KEY: NonEmpty.describe("AWS secret access key for SES"),
    AWS_SES_FROM_EMAIL: z.email({ error: "AWS_SES_FROM_EMAIL must be a verified SES address" }),
    AWS_SES_FROM_NAME: NonEmpty.default("Vellum"),
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
