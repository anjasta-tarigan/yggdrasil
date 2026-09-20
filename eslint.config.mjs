import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // React Compiler rules (eslint-plugin-react-hooks v7). The React
      // Compiler is not enabled in this project, and vendored AI Elements /
      // shadcn components intentionally use these patterns. Downgrade to
      // warnings so `pnpm lint` stays green without masking them.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/static-components": "warn",
    },
  },
  // The Project Harness has its own loop policy in @/lib/ai/harness-loop
  // (60 steps, no tool withholding, no temperature change, forced wrap-up on
  // the last step). Reusing the chat loop policy here reintroduces C1: bash
  // withheld after step 5, a 15-step cap, and a stop condition waiting for a
  // tool the harness does not have. Guard the harness surface only; the main
  // chat route keeps its own policy unrestricted.
  {
    files: ["src/app/api/projects/**", "src/lib/project-*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/ai/prepare-step",
              message:
                "The project harness has its own loop policy in @/lib/ai/harness-loop. Do not reuse chat loop policy.",
            },
            {
              name: "@/lib/ai/termination-conditions",
              message:
                "The project harness has its own loop policy in @/lib/ai/harness-loop. Do not reuse chat loop policy.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
