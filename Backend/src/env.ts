import "dotenv/config";
import { z } from "zod";
import { parsePrices } from "./agent/pricing.js";
import { parsePublicApiBaseUrl } from "./domain/emailTracking.js";
import { databaseDisabled } from "./noDatabase.js";

// A blank `KEY=` line in .env arrives as "" — treat it as "not set".
const blankToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema);

/**
 * Postgres pool tuning (API and worker). The Supabase session pooler caps
 * client connections per project (15 on staging), and every pooled
 * connection counts while it is open, even idle. Exported for tests.
 */
export const DbEnvSchema = z.object({
  // Max connections in the API's pool / the worker's pool. Default 10 (the old fixed size).
  DB_POOL_MAX: blankToUndefined(z.coerce.number().int().min(1).max(100).default(10)),
  WORKER_DB_POOL_MAX: blankToUndefined(z.coerce.number().int().min(1).max(100).default(10)),
  // Close a connection after it has been idle this long. 0 = never.
  DB_IDLE_TIMEOUT_MS: blankToUndefined(z.coerce.number().int().min(0).default(10_000)),
  // How long a query waits for a free pool connection (or a new one) before failing. 0 = forever.
  DB_CONNECTION_TIMEOUT_MS: blankToUndefined(z.coerce.number().int().min(0).default(15_000)),
  // DB-3: max connections in the session-pooler pool (only code that needs a real session uses it).
  DB_SESSION_POOL_MAX: blankToUndefined(z.coerce.number().int().min(1).max(100).default(2)),
  // E4b: the session pooler's client limit (Supabase → Database → Connection pooling; 15 on staging), API + worker.
  SESSION_POOLER_MAX_CLIENTS: blankToUndefined(z.coerce.number().int().min(5).max(10_000).default(15)),
});

const EnvSchema = DbEnvSchema.extend({
  PORT: z.coerce.number().int().positive().default(8787),
  CORS_ORIGINS: z.string().default("http://localhost:8080,http://127.0.0.1:8080"),
  // DB-3: DATABASE_URL = Supabase TRANSACTION pooler (port 6543); DATABASE_SESSION_URL = SESSION pooler
  // (port 5432), only for session-level state (the WhatsApp session locks). Unset → DATABASE_URL (warned).
  // DEMO-1: may be empty only in a run without a database (NORTHBEAM_NO_DATABASE=1, src/noDatabase.ts).
  DATABASE_URL: z.string().default(""),
  DATABASE_SESSION_URL: blankToUndefined(z.string().optional()),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
  INTEGRATION_ENCRYPTION_KEY: z.string().refine(
    (value) => {
      try {
        return Buffer.from(value, "base64").length === 32;
      } catch {
        return false;
      }
    },
    "INTEGRATION_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
  ),

  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // The platform's own Google OAuth app, shared by every workspace so users
  // connect Google Calendar with one click instead of registering their own
  // client. All three must be set together (checked in loadEnv).
  GOOGLE_OAUTH_CLIENT_ID: blankToUndefined(z.string().optional()),
  GOOGLE_OAUTH_CLIENT_SECRET: blankToUndefined(z.string().optional()),
  GOOGLE_OAUTH_REDIRECT_URI: blankToUndefined(z.string().url().optional()),

  // Public website-form lead intake (POST /api/v1/public/leads). Both must be
  // set together or the endpoint stays disabled (checked in loadEnv). The key
  // is a shared secret held only by the website's server; it is bound to the
  // one workspace named here.
  INGEST_API_KEY: blankToUndefined(z.string().min(32, "INGEST_API_KEY must be at least 32 characters").optional()),
  INGEST_WORKSPACE_ID: blankToUndefined(z.string().uuid().optional()),

  // Knowledge-base embeddings (API and worker; never the frontend). Optional:
  // without a key, embedding calls fail with "OpenAI is not configured".
  OPENAI_API_KEY: blankToUndefined(z.string().optional()),
  OPENAI_EMBEDDING_MODEL: blankToUndefined(z.string().default("text-embedding-3-small")),

  // AI agent (API and worker; never the frontend). The default models when a
  // workspace's agent_settings has none; no model is hard-coded. Prices per
  // million tokens, e.g. {"<model>": {"inputPer1M": 2.5, "outputPer1M": 10}}.
  OPENAI_DECISION_MODEL: blankToUndefined(z.string().optional()),
  OPENAI_GROUNDING_MODEL: blankToUndefined(z.string().optional()),
  OPENAI_PRICES_JSON: blankToUndefined(
    z
      .string()
      .optional()
      .refine((value) => {
        try {
          parsePrices(value);
          return true;
        } catch {
          return false;
        }
      }, 'OPENAI_PRICES_JSON must be JSON like {"<model>": {"inputPer1M": 2.5, "outputPer1M": 10}}'),
  ),

  // E3b-2b email open tracking (API and worker): the API's public address for the open pixel
  // (https in production). Missing = tracking off; malformed = startup error (checked in loadEnv).
  PUBLIC_API_BASE_URL: blankToUndefined(z.string().optional()),

  // LL-2 (worker): the CRM frontend's address for links in staff alert / digest emails. Missing = the first CORS origin.
  APP_BASE_URL: blankToUndefined(z.string().url("APP_BASE_URL must be a full URL like https://crm.example.com.").optional()),
});

// WORKER_* tuning is validated separately in workerEnv.ts. Provider secrets
// (the SMTP/IMAP mailbox, etc.) are loaded from encrypted database configuration,
// entered by an admin in Settings — never from environment variables.
// Google Calendar is the exception: the platform-wide OAuth app lives in the
// GOOGLE_OAUTH_* variables above, and a workspace can still override it with
// its own client saved (encrypted) in the database.

function loadEnv() {
  const parsed = EnvSchema.superRefine((value, ctx) => {
    if (!value.DATABASE_URL && !databaseDisabled()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["DATABASE_URL"], message: "DATABASE_URL is required" });
  }).safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration. See .env.example.");
  }
  const googleVars = [
    parsed.data.GOOGLE_OAUTH_CLIENT_ID,
    parsed.data.GOOGLE_OAUTH_CLIENT_SECRET,
    parsed.data.GOOGLE_OAUTH_REDIRECT_URI,
  ];
  if (googleVars.some(Boolean) && !googleVars.every(Boolean)) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_OAUTH_REDIRECT_URI must all be set together. See .env.example.",
    );
  }
  if (Boolean(parsed.data.INGEST_API_KEY) !== Boolean(parsed.data.INGEST_WORKSPACE_ID)) {
    throw new Error("INGEST_API_KEY and INGEST_WORKSPACE_ID must both be set, or both left blank. See .env.example.");
  }
  return { ...parsed.data, PUBLIC_API_BASE_URL: parsePublicApiBaseUrl(parsed.data.PUBLIC_API_BASE_URL, parsed.data.NODE_ENV) };
}

export const env = loadEnv();

export const corsOrigins = env.CORS_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** LL-2: the CRM frontend's address (no trailing slash) for links in staff emails. */
export const appBaseUrl = (env.APP_BASE_URL ?? corsOrigins[0] ?? "").replace(/\/+$/, "");
