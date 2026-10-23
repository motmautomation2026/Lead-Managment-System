// Runs tests/integration against the STAGING database named by TEST_DATABASE_URL
// in Backend/.env. Refuses the production project before anything connects.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const PRODUCTION_REF = "jorxltfwboabyjiydyhu";
const backendDir = fileURLToPath(new URL("..", import.meta.url));

const dotEnv = dotenv.parse(readFileSync(new URL("../.env", import.meta.url)));
const url = dotEnv.TEST_DATABASE_URL?.trim();
if (!url) throw new Error("TEST_DATABASE_URL is not set in Backend/.env.");
if (url.includes(PRODUCTION_REF)) throw new Error("TEST_DATABASE_URL points at the production project; refusing to run.");
// Staging Storage for the knowledge-base tests (uploads are cleaned up). Without these the
// tests' setup substitutes a fake Supabase URL.
const supabaseUrl = dotEnv.SUPABASE_URL?.trim();
if (supabaseUrl?.includes(PRODUCTION_REF)) throw new Error("SUPABASE_URL points at the production project; refusing to run.");
const supabase = supabaseUrl && dotEnv.SUPABASE_SERVICE_ROLE_KEY ? { SUPABASE_URL: supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: dotEnv.SUPABASE_SERVICE_ROLE_KEY.trim() } : {};

const result = spawnSync("npx", ["vitest", "run", "tests/integration"], {
  cwd: backendDir,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, ...supabase, TEST_DATABASE_URL: url },
});
process.exit(result.status ?? 1);
