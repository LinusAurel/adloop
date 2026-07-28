import { z } from "zod";

/**
 * Every environment variable the app depends on, validated once at import
 * time. Failing fast here beats a confusing runtime error three layers
 * down. This is a system boundary — see PROMPT-etappe-1.md §10.
 */
const DEVELOPMENT_SESSION_SECRET = "development-session-secret-change-me";

const envSchema = z
  .object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  WEB_PORT: z.coerce.number().int().positive().default(3000),

  S3_ENDPOINT: z.string().min(1).default("http://minio:9000"),
  S3_BUCKET: z.string().min(1).default("adloop"),
  S3_REGION: z.string().min(1).default("us-east-1"),
  MINIO_ROOT_USER: z.string().min(1).optional(),
  MINIO_ROOT_PASSWORD: z.string().min(1).optional(),

  SESSION_SECRET: z.string().min(32).default(DEVELOPMENT_SESSION_SECRET),
  ENCRYPTION_KEY: z.string().min(1).optional(),
  META_APP_ID: z.string().min(1).optional(),
  META_APP_SECRET: z.string().min(1).optional(),
  META_REDIRECT_URI: z.string().url().optional(),
  META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v25.0"),
  SYNC_BACKFILL_DAYS: z.coerce.number().int().min(1).max(90).default(7),

  JOB_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  JOB_LEASE_MS: z.coerce.number().int().positive().default(30000),
  JOB_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(10000),

  WORKER_ID: z.string().min(1).optional(),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(3100),

  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === "production" && value.SESSION_SECRET === DEVELOPMENT_SESSION_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SESSION_SECRET"],
        message: "SESSION_SECRET must be set explicitly in production",
      });
    }

    const metaValues = [
      value.META_APP_ID,
      value.META_APP_SECRET,
      value.META_REDIRECT_URI,
      value.ENCRYPTION_KEY,
    ];
    const configured = metaValues.filter(Boolean).length;
    if (configured > 0 && configured < metaValues.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["META_APP_ID"],
        message: "META_APP_ID, META_APP_SECRET, META_REDIRECT_URI, and ENCRYPTION_KEY must be configured together",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error(
      "Invalid environment configuration:",
      parsed.error.flatten().fieldErrors,
    );
    throw new Error("Invalid environment configuration");
  }
  return parsed.data;
}

let cached: Env | undefined;
function getEnv(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

/**
 * Validated lazily, on first property access, and cached after that —
 * not eagerly at import time. Every real code path (route handlers,
 * worker/index.ts) only reads `env.X` once a request or the process is
 * actually running, so validation still happens before anything uses a
 * bad value. Eager validation at import time was the first attempt, but
 * it broke `next build`'s static route analysis, which imports every
 * route module (to inspect its exports) without a real DATABASE_URL
 * present — see DECISIONS.md.
 */
export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string | symbol) {
    return getEnv()[prop as keyof Env];
  },
}) as Env;
