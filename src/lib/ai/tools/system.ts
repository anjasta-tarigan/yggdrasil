// src/lib/ai/tools/system.ts
import { tool } from "ai";
import { z } from "zod";
import os from "node:os";
import { probeCliCapabilities } from "./file-capabilities";

export const host_info = tool({
  description:
    "Diagnostic tool to inspect the host system environment, hardware resources (CPU, Memory, Uptime), OS platform, and availability of installed modern CLI tools (eza, fd, ripgrep, zoxide, fzf).",
  inputSchema: z.object({}),
  execute: async () => {
    const tools = await probeCliCapabilities();
    const totalMemMb = Math.round(os.totalmem() / (1024 * 1024));
    const freeMemMb = Math.round(os.freemem() / (1024 * 1024));

    return {
      os: {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
      },
      resources: {
        totalMemMb,
        freeMemMb,
        cpus: os.cpus().length,
        uptimeHours: Math.round((os.uptime() / 3600) * 10) / 10,
      },
      tools,
    };
  },
});
