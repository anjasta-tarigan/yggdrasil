export interface InstallPaths {
  baseDir: string;
  appDir: string;
  dataDir: string;
  logsDir: string;
  skillsDir: string;
  pluginsDir: string;
  envFile: string;
  pidFile: string;
  binDir: string;
}

export interface CliOptions {
  port?: number;
  dir?: string;
  noService?: boolean;
  yes?: boolean;
  purge?: boolean;
}
