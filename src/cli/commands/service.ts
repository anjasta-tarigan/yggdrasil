// src/cli/commands/service.ts
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallPaths } from "../utils/paths";
import { getServiceManager } from "../platform";

export async function serviceCommand(action: "start" | "stop" | "restart" | "status" | "logs"): Promise<void> {
  const mgr = getServiceManager();
  const paths = resolveInstallPaths();

  if (action === "start") {
    await mgr.start();
    console.log("[Yggdrasil] Service started.");
  } else if (action === "stop") {
    await mgr.stop();
    console.log("[Yggdrasil] Service stopped.");
  } else if (action === "restart") {
    await mgr.restart();
    console.log("[Yggdrasil] Service restarted.");
  } else if (action === "status") {
    const stat = await mgr.status();
    console.log(`[Yggdrasil] Service status: ${stat.active ? "ACTIVE" : "INACTIVE"}`);
    if (stat.details) console.log(stat.details);
  } else if (action === "logs") {
    const logPath = path.join(paths.logsDir, "yggdrasil.log");
    try {
      const content = await fs.readFile(logPath, "utf8");
      const lines = content.trim().split("\n");
      const tail = lines.slice(-50).join("\n");
      console.log(tail || "(Log file empty)");
    } catch {
      console.log(`No log file found at ${logPath}`);
    }
  }
}
