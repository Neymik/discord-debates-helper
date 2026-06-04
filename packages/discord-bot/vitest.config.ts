import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "discord-bot",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
