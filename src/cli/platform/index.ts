import type { InstallPaths } from "../types";
import { SystemdManager } from "./systemd";
import { LaunchdManager } from "./launchd";
import { WindowsManager } from "./windows";

export interface ServiceManager {
  installService(paths: InstallPaths, port: number): Promise<void | "startup-folder">;
  uninstallService(paths?: InstallPaths): Promise<void>;
  start(paths?: InstallPaths): Promise<void>;
  stop(paths?: InstallPaths): Promise<void>;
  restart(paths?: InstallPaths): Promise<void>;
  status(paths?: InstallPaths): Promise<{ active: boolean; details?: string }>;
  /** Platforms with a tray app implement these; others omit them. */
  installTrayLauncher?(paths: InstallPaths): Promise<void>;
  startTray?(paths: InstallPaths): Promise<void>;
  stopTray?(paths?: InstallPaths): Promise<void>;
}

export function getServiceManager(platform = process.platform): ServiceManager {
  if (platform === "linux") return new SystemdManager();
  if (platform === "darwin") return new LaunchdManager();
  if (platform === "win32") return new WindowsManager();
  throw new Error(`Unsupported platform: ${platform}`);
}
