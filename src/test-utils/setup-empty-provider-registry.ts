import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

/**
 * Unit-test default: an EMPTY provider registry.
 *
 * The provider-config store resolves its `providers.json` from
 * `process.env.YGGDRASIL_PROVIDER_CONFIG_DIR` when the module is first
 * imported (see `src/lib/ai/provider-config/store.ts`), and that module is
 * imported lazily by the route under test — after setup files run. Pointing
 * the env var at a fresh temp directory makes a unit run match a clean
 * checkout: no developer `data/providers.json` is ever read, and a route test
 * that forgets to seed a registry fails locally the same way it would on CI.
 *
 * Tests that need models must call `seedTestProviderRegistry` (or
 * `setProviderConfigPathsForTest`) from `@/test-utils/provider-registry`;
 * both override the env-derived path.
 *
 * The integration project is intentionally NOT given this setup file.
 */
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-empty-registry-"));

process.env.YGGDRASIL_PROVIDER_CONFIG_DIR = dir;

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch((err) => {
    console.debug(
      `[setup-empty-provider-registry] Failed to remove ${dir}: ${err instanceof Error ? err.message : String(err)}`
    );
  });
});
