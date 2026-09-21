import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
