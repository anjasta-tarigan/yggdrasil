import type { InstallPaths } from "../types";
import { SystemdManager } from "./systemd";
import { LaunchdManager } from "./launchd";
import { WindowsManager } from "./windows";

export interface ServiceManager {
  installService(paths: InstallPaths, port: number): Promise<void>;
  uninstallService(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<{ active: boolean; details?: string }>;
}

export function getServiceManager(platform = process.platform): ServiceManager {
  if (platform === "linux") return new SystemdManager();
  if (platform === "darwin") return new LaunchdManager();
  if (platform === "win32") return new WindowsManager();
  throw new Error(`Unsupported platform: ${platform}`);
}
