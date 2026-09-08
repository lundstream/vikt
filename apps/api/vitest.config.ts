import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Every test holds one open transaction on a single connection, so the
    // files run one at a time rather than fighting over it.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    // Creating and migrating the test database on the first run is slow.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
