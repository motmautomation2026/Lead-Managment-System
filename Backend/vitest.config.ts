import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup-env.ts"],
    // Integration files each open their own pools; run them one at a time so a
    // session-mode pooler (Supabase: 15 clients) is never exhausted.
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
