import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The cross-process registry lock is the single mutex every writer of
 * `data/providers.json` must hold (Spec §8.5, Rule 17): discovery's merge and
 * the Settings `PUT /api/providers` patch. These tests drive the lock directly
 * and through `applyRegistryPatch`, since a second, weaker lock on the patch
 * path is exactly the TOCTOU this task removes.
 */

let dataDir: string;
let lockFile: string;

describe("cross-process registry lock", () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ygg-registry-lock-"));
    const { setProviderConfigPathsForTest } = await import(
      "@/lib/ai/provider-config/store"
    );
    setProviderConfigPathsForTest(dataDir);
    lockFile = join(dataDir, "providers.json.lock");
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("acquires and releases, and a second acquisition times out with RegistryLockError", async () => {
    const { acquireRegistryLock, RegistryLockError } = await import(
      "@/lib/ai/provider-config/store"
    );

    const release = await acquireRegistryLock();
    await expect(acquireRegistryLock()).rejects.toBeInstanceOf(RegistryLockError);
    await release();
    await expect(stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });

    // The released lock is free again for the next writer.
    const next = await acquireRegistryLock();
    await next();
  });

  it("reclaims a stale lock left by a crashed process", async () => {
    const { acquireRegistryLock } = await import("@/lib/ai/provider-config/store");

    await writeFile(lockFile, "999999:0", "utf8");
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockFile, stale, stale);

    const release = await acquireRegistryLock();
    await release();
    await expect(stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applyRegistryPatch returns 503 while another process holds the lock", async () => {
    const { applyRegistryPatch } = await import(
      "@/lib/ai/provider-config/api-helpers"
    );

    // A fresh lock owned by "another process" must not be stolen.
    await writeFile(lockFile, "424242:0", "utf8");

    const result = await applyRegistryPatch({ providers: [] });
    expect(result).toEqual({
      ok: false,
      status: 503,
      error: expect.stringMatching(/lock/i),
    });
  });
});
