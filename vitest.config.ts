import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["extensions/**/*.ts"],
      reporter: ["text", "json-summary", "html"],
      thresholds: {
        branches: 98,
        functions: 98,
        lines: 98,
        statements: 98,
      },
    },
  },
});
