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

if (process.env.NODE_OPTIONS === undefined) {
  process.env.NODE_OPTIONS = "--max-old-space-size=2048";
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
