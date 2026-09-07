#!/usr/bin/env node
// bin/yggdrasil.mjs
// Shebang-launched wrapper: registers tsx's TS loader, then runs the CLI router.
// Spawning node without a .ts file argument would apply no loader, so the only
// reliable path is to load tsx programmatically and then import the TS entry.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(__dirname, "../src/cli/index.ts");

try {
  // tsx is a devDependency; resolves through node_modules regardless of bin-link location.
  await import("tsx");
  const { main } = await import(cliEntry);
  await main();
} catch (err) {
  console.error("[Yggdrasil CLI Error]", err);
  process.exit(1);
}
