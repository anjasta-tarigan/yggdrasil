#!/usr/bin/env node
// scripts/build.mjs
//
// Cross-platform replacement for the POSIX-only npm "build" script:
//   NEXT_TELEMETRY_DISABLED=1 TURBOPACK_WORKERS=1 next build
//
// npm lifecycle scripts on Windows run under cmd.exe, which has no
// `VAR=value command` inline-env syntax. The old script therefore failed with:
//   'NEXT_TELEMETRY_DISABLED' is not recognized as an internal or external command
// This wrapper sets the variables in-process (never clobbering values the
// installers already exported through the environment) and delegates to Next.js.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let singleWorker = false;
let heapMb;
const nextArgs = [];
for (const arg of process.argv.slice(2)) {
  if (arg === "--single-worker") {
    singleWorker = true;
  } else if (arg.startsWith("--heap=")) {
    heapMb = Number(arg.slice("--heap=".length));
  } else {
    nextArgs.push(arg);
  }
}

// NEXT_TELEMETRY_DISABLED=1: keep the production build quiet (matched to the
// old script). Only set it when the caller hasn't supplied a value.
if (process.env.NEXT_TELEMETRY_DISABLED === undefined) {
  process.env.NEXT_TELEMETRY_DISABLED = "1";
}

// TURBOPACK_WORKERS=1: avoid spawning parallel page-data workers that each
// import @/db and race on additive migrations against the live database, and
// that blow past the heap ceiling on small-RAM hosts. This is the default the
// old `build` script pinned; `build:ci` omits --single-worker to keep
// auto-parallel workers for high-RAM CI.
if (singleWorker && process.env.TURBOPACK_WORKERS === undefined) {
  process.env.TURBOPACK_WORKERS = "1";
}

// NODE_OPTIONS heap ceiling, only when the caller hasn't set one already. The
// installers (install.ps1 / install.sh) and `yggdrasil update` pass their own
// adaptive or fixed ceiling through the environment and must not be overridden.
if (heapMb && Number.isFinite(heapMb) && process.env.NODE_OPTIONS === undefined) {
  process.env.NODE_OPTIONS = `--max-old-space-size=${heapMb}`;
}

// Resolve next relative to this script so the spawn works without relying on a
// shell PATH lookup on any platform.
const nextBin = fileURLToPath(
  new URL("../node_modules/next/dist/bin/next", import.meta.url),
);

const result = spawnSync(process.execPath, [nextBin, ...nextArgs], {
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
