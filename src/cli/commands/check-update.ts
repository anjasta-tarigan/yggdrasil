import { resolveInstallPaths } from "../utils/paths";
import { checkLatestVersion } from "@/lib/system/version";
import type { CliOptions } from "../types";

export async function checkUpdateCommand(options: CliOptions): Promise<void> {
  const paths = resolveInstallPaths(options.dir);
  const check = await checkLatestVersion({ appDir: paths.appDir });

  if (check.channel === "main") {
    console.log(
      `[Yggdrasil] Running main branch (development build). Update checking skipped.`
    );
    process.exitCode = 0;
    return;
  }

  if (check.errored) {
    console.error(
      `[Yggdrasil] Could not verify the latest release from GitHub. (Current installed version: v${check.current})`
    );
    process.exitCode = 2;
    return;
  }

  if (check.available && check.latest) {
    console.log(
      `[Yggdrasil] Update available: v${check.latest} (installed: v${check.current})`
    );
    console.log(`[Yggdrasil] Run "yggdrasil update" or visit ${check.releaseUrl ?? "GitHub"} to update.`);
    process.exitCode = 1;
    return;
  }

  console.log(`[Yggdrasil] Yggdrasil is up to date (v${check.current}).`);
  process.exitCode = 0;
}
