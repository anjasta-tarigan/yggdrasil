import { NextResponse } from "next/server";
import { ensureMigrated } from "@/lib/ai/provider-config/migrate";
import { getRegistryView, ProviderConfigError } from "@/lib/ai/provider-config/store";
import { applyRegistryPatch } from "@/lib/ai/provider-config/api-helpers";

/**
 * Provider registry API.
 *
 * The registry files (`data/providers.json` + `data/providers.secrets.env`)
 * are the SSOT for user-added AI providers; this route is its CRUD surface.
 *
 * - GET  → redacted view (`apiKeyConfigured` flags, never key values).
 * - PUT  → full-document replace (the body IS the next RegistryDocument),
 *          delegated to `applyRegistryPatch`.
 *
 * Responses never contain key values: the view is redacted by construction
 * and error messages carry paths/issues, not inputs.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // First load after a legacy (env / SQLite) deployment seeds the registry.
    await ensureMigrated();
    return NextResponse.json(await getRegistryView());
  } catch (error) {
    if (error instanceof ProviderConfigError) {
      // Message names the file and what is wrong with it — never a value.
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    console.error("[api/providers] GET failed:", error);
    return NextResponse.json(
      { error: "Failed to load provider registry" },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  let body: { providers?: unknown; embedding?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = await applyRegistryPatch(body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(await getRegistryView());
}
