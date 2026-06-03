import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests import modules that validate the full env at import time
// (e.g. queue.ts -> buildConfig -> loadEnv). Load the repo-root .env so those
// modules can construct. REDIS_URL/DATABASE_URL point at the compose services
// on localhost for local test runs.
loadDotenv({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

export default defineConfig({
  test: {
    name: "api",
    include: ["src/**/*.test.ts"],
    environment: "node",
    env: { NODE_ENV: "test" },
  },
});
