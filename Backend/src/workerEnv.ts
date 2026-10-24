import "dotenv/config";
import { z } from "zod";

const WorkerEnvSchema = z.object({
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  WORKER_DRY_RUN: z.string().default("false").transform((value) => value === "true"),
  // Kill switch for the AI agent loop (3C-2, shadow only). Off unless exactly "true".
  AGENT_RUNNER_ENABLED: z.string().default("false").transform((value) => value === "true"),
  // CRM v2 company sweeper (B3a): links unchecked contacts to companies. On unless exactly "false".
  CRM_COMPANY_SWEEP_ENABLED: z.string().default("true").transform((value) => value !== "false"),
});

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env) {
  const parsed = WorkerEnvSchema.safeParse(source);
  if (!parsed.success) {
    console.error("Invalid worker environment configuration:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid worker environment configuration. Check WORKER_* values in .env.example.");
  }
  return parsed.data;
}

export const workerEnv = loadWorkerEnv();
