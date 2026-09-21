import { defineConfig } from "vitest/config";
import { workflow } from "@workflow/vitest";

/**
 * Workflow-boundary tests (`*.workflow.test.ts`).
 *
 * These run through the Workflow SDK's real runtime: the `workflow()` plugin
 * compiles the `"use workflow"` / `"use step"` bundles with the SWC plugin and
 * installs an in-process world, so a test exercises genuine step-boundary
 * serialization rather than a mock. They are kept out of the unit project
 * because the unit project has no workflow plugin and would run the bundles
 * untransformed.
 *
 * Run: pnpm vitest run --config vitest.workflow.config.ts <file>
 */
export default defineConfig({
  plugins: [workflow({ cwd: process.cwd() })],
  test: {
    include: ["src/**/*.workflow.test.ts"],
    testTimeout: 90_000,
    maxWorkers: 1,
  },
});
