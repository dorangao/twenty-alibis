import { defineConfig } from "vitest/config";

/**
 * The tests' own config. Without it the test runner would pick up vite.config.ts, whose root
 * is the page's folder, and find no tests.
 *
 * A test may take twenty seconds before it is called hung. Several tests start a process of
 * their own (a build, a command, the built function), and a shared CI runner with every test
 * file running at once has taken more than five seconds over three such starts that take
 * under one here. The limit is for a test that never ends, not a measure of how fast one
 * should be; no test's result depends on it.
 */
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 20_000 },
});
