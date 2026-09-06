import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    // Rule 18: bounded workers to prevent OOM.
    maxWorkers: 2,
    execArgv: ["--max-old-space-size=2048"],
    // The sqlite FTS5/vector memory tests legitimately take 3-6s under
    // full-suite load; the 5s default flakes intermittently.
    testTimeout: 15000,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
