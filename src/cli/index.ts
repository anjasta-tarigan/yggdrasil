// src/cli/index.ts
import type { CliOptions } from "./types";
import { installCommand } from "./commands/install";
import { updateCommand } from "./commands/update";
import { uninstallCommand } from "./commands/uninstall";
import { serviceCommand } from "./commands/service";

export interface ParsedArgs {
  command: string;
  options: CliOptions;
  extraArgs: string[];
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  const command = argv[0] || "status";
  const options: CliOptions = {
    port: 2302,
    noService: false,
    yes: false,
    purge: false,
  };
  const extraArgs: string[] = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" && argv[i + 1]) {
      options.port = parseInt(argv[++i], 10);
    } else if (arg === "--dir" && argv[i + 1]) {
      options.dir = argv[++i];
    } else if (arg === "--no-service") {
      options.noService = true;
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--purge") {
      options.purge = true;
    } else {
      extraArgs.push(arg);
    }
  }

  return { command, options, extraArgs };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { command, options } = parseCliArgs(argv);

  switch (command) {
    case "install":
      await installCommand(options);
      break;
    case "update":
      await updateCommand(options);
      break;
    case "uninstall":
      await uninstallCommand(options);
      break;
    case "start":
    case "stop":
    case "restart":
    case "status":
    case "logs":
      await serviceCommand(command);
      break;
    case "--help":
    case "-h":
    case "help":
      console.log(`Yggdrasil System CLI
Commands:
  install     Install Yggdrasil and set up background service
  update      Safely pull, backup, and rebuild Yggdrasil
  uninstall   Remove service and application (optionally --purge data)
  start       Start background service
  stop        Stop background service
  restart     Restart background service
  status      Check background service status
  logs        View recent application logs
`);
      break;
    default:
      console.error(`Unknown command: ${command}. Use "yggdrasil help" for usage.`);
      process.exit(1);
  }
}
