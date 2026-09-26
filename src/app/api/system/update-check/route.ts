import { NextResponse } from "next/server";
import { checkLatestVersion } from "@/lib/system/version";
import { getSettingDb, setSettingsDb } from "@/lib/settings-service";
import { validateProjectApiRequest } from "@/lib/security/api-guard";

export const dynamic = "force-dynamic";

const DISMISSED_SETTING_KEY = "system_update_dismissed";

interface DismissedSetting {
  version: string;
  dismissedAt: number;
}

/**
 * Latest-version badge state for the running install.
 *
 * `dismissed` is true only while the stored dismissal names the *current*
 * latest release — a newer release re-surfaces the badge.
 */
export async function GET(req: Request) {
  const guard = validateProjectApiRequest(req);
  if (guard) return guard;

  const check = await checkLatestVersion();
  const dismissedSetting = getSettingDb(DISMISSED_SETTING_KEY) as DismissedSetting | null;

  const isDismissed = Boolean(
    check.latest &&
      dismissedSetting &&
      typeof dismissedSetting.version === "string" &&
      dismissedSetting.version === check.latest
  );

  return NextResponse.json({
    current: check.current,
    latest: check.latest,
    available: check.available,
    channel: check.channel,
    releaseUrl: check.releaseUrl,
    releaseNotes: check.releaseNotes ?? null,
    dismissed: isDismissed,
    errored: check.errored,
  });
}

/**
 * Dismiss the badge for the current latest release.
 *
 * Records the version rather than a bare boolean so the next release (a
 * different `latest`) is not silently hidden. Never downloads or installs.
 */
export async function POST(req: Request) {
  const guard = validateProjectApiRequest(req, { requireJsonBody: true });
  if (guard) return guard;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    (body as { action?: string }).action !== "dismiss"
  ) {
    return NextResponse.json(
      { error: "Invalid action. Expected { action: 'dismiss' }" },
      { status: 400 }
    );
  }

  const check = await checkLatestVersion();

  // No known latest release (errored, rate-limited with no cache, or on the
  // main channel): there is nothing to dismiss. Report honestly rather than
  // claiming a dismissal that was never persisted — a later GET would
  // contradict it by returning `dismissed: false`.
  if (!check.latest) {
    return NextResponse.json(
      { ok: false, dismissed: false, version: null },
      { status: 200 }
    );
  }

  setSettingsDb({
    [DISMISSED_SETTING_KEY]: {
      version: check.latest,
      dismissedAt: Date.now(),
    },
  });

  return NextResponse.json({ ok: true, dismissed: true, version: check.latest });
}
