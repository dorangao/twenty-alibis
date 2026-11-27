import { defineConfig } from "vitest/config";

/**
 * The tests' own config. Without it the test runner would pick up vite.config.ts, whose root
 * is the page's folder, and find no tests.
 */
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
