import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    // Disable TypeScript type checking during builds to prevent OOM crashes
    // on resource-constrained systems. Type checking is still done via
    // `tsc --noEmit` in development and CI.
    ignoreBuildErrors: true,
  },
  serverExternalPackages: ["better-sqlite3", "sqlite-vec", "onnxruntime-node"],
  experimental: {
    turbopackMemoryEviction: "full",
    optimizePackageImports: [
      "@phosphor-icons/react",
      "@xyflow/react",
      "shiki",
      "three",
      "@react-three/fiber",
      "@react-three/drei",
      "mermaid",
      "katex",
    ],
  },
};

export default withWorkflow(nextConfig);
