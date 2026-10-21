#!/usr/bin/env node
// scripts/dev.mjs
//
// Cross-platform replacement for the POSIX-only npm "dev" script:
//   NODE_OPTIONS='--max-old-space-size=2048' next dev -H 127.0.0.1
//
// npm lifecycle scripts on Windows run under cmd.exe, which has no
// `VAR=value command` inline-env syntax, so the old script cannot run there.
// Set the heap ceiling in-process (never clobbering a value the caller already
// exported) and delegate to Next.js.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.env.NODE_OPTIONS === undefined) {
  process.env.NODE_OPTIONS = "--max-old-space-size=2048";
}
process.env.NODE_ENV = "development";

// Mirror the production service: load the install's .env (~/.yggdrasil/.env) into
// the dev server's environment. Without this, `pnpm dev` boots without APP_SECRET
// (or any managed key) and the app throws the cryptic "APP_SECRET is required"
// ZodError. Next.js refuses to override an already-set process env var with a .env
// value, so we only inject keys that are not already present.
const envFile = path.join(os.homedir(), ".yggdrasil", ".env");
if (fs.existsSync(envFile)) {
  for (const raw of fs.readFileSync(envFile, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    // These settings belong to the installed production service. Inheriting
    // them makes `pnpm dev` run in production mode on the service's port.
    if (key === "NODE_ENV" || key === "PORT") continue;
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

// Resolve next relative to this script so the spawn works without relying on a
// shell PATH lookup on any platform.
const nextBin = fileURLToPath(
  new URL("../node_modules/next/dist/bin/next", import.meta.url),
);

const result = spawnSync(
  process.execPath,
  [nextBin, "dev", "-H", "127.0.0.1", ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env },
);

process.exit(result.status ?? 1);
