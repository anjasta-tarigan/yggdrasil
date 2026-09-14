import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Two test projects:
 *
 *  - "unit" (default): everything except *.integration.test.*, jsdom, bounded
 *    workers (Rule 18).
 *  - "integration": *.integration.test.*, node environment. These load real
 *    ONNX models (100 MB+) from disk. They are kept out of the default run
 *    because a heavy native load starves the 2-worker pool and makes unrelated
 *    suites time out; each is gated on its model being present, so the project
 *    is a no-op on a fresh clone.
 *
 * Run:      pnpm test                    (unit only)
 *           pnpm test:integration        (integration only)
 *           pnpm test:all                (both)
 */
const alias = { "@": path.resolve(import.meta.dirname, "./src") };

export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    projects: [
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "unit",
          environment: "jsdom",
          // Rule 18: bounded workers to prevent OOM.
          maxWorkers: 2,
          execArgv: ["--max-old-space-size=2048"],
          // The sqlite FTS5/vector memory tests legitimately take 3-6s under
          // full-suite load; the 5s default flakes intermittently.
          testTimeout: 15000,
          setupFiles: ["./vitest.setup.ts"],
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: ["**/node_modules/**", "**/*.integration.test.{ts,tsx}"],
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "integration",
          // Real ORT needs Node: jsdom's realm gives onnxruntime-node a
          // different TypedArray constructor, which the native addon rejects.
          environment: "node",
          // A single model load is heavy; one worker keeps peak RSS bounded.
          maxWorkers: 1,
          execArgv: ["--max-old-space-size=4096"],
          // Cold model load + several inferences.
          testTimeout: 120000,
          hookTimeout: 120000,
          setupFiles: ["./vitest.setup.ts"],
          include: ["src/**/*.integration.test.{ts,tsx}"],
        },
      },
    ],
  },
});
