#!/usr/bin/env node
// bin/yggdrasil.mjs
// Shebang-launched wrapper: registers tsx's TS loader, then runs the CLI router.
// Spawning node without a .ts file argument would apply no loader, so the only
// reliable path is to load tsx programmatically and then import the TS entry.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(__dirname, "../src/cli/index.ts");
const tsconfigPath = path.resolve(__dirname, "../tsconfig.json");

// Pin tsx's tsconfig to the app directory. tsx resolves tsconfig.json relative
// to process.cwd(), so running `yggdrasil` through the ~/.local/bin symlink
// from any other directory left the `@/*` path alias unresolved and every
// command died with `ERR_MODULE_NOT_FOUND: Cannot find package '@/lib'`.
// Setting this BEFORE importing tsx makes the alias resolve regardless of cwd.
// An explicit TSX_TSCONFIG_PATH from the environment still wins.
if (!process.env.TSX_TSCONFIG_PATH) {
  process.env.TSX_TSCONFIG_PATH = tsconfigPath;
}

try {
  // tsx is a devDependency; resolves through node_modules regardless of bin-link location.
  await import("tsx");
  const { main } = await import(cliEntry);
  await main();
} catch (err) {
  console.error("[Yggdrasil CLI Error]", err);
  process.exit(1);
}
