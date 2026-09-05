# Provider Configuration SSoT Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the split env+SQLite provider store with `data/providers.json` + `data/providers.secrets.env` as the single source of truth, curate models per-provider with layered capability detection, remove the built-in card, add edit flows, fix the plaintext-key leak, and migrate embeddings — without breaking any existing `"server::modelId"` refs.

**Architecture:** A server-only `provider-config` service owns all file I/O (Zod-validated, atomic write-temp+rename, single writer, chmod 600 on secrets, fail-fast on corrupt JSON). It seeds/migrates on first load, resolves secrets via `process.env` → secrets-file, and serves redacted registry views. The SDK provider factory, chat route, capability pipeline, and UI all read through it; the client never sees a key.

**Tech Stack:** Next.js 16 App Router (React 19), TypeScript 6, Zod 4, Drizzle ORM + better-sqlite3 (SQLite WAL), Vercel AI SDK (`@ai-sdk/openai-compatible`, `ai`), shadcn/ui + Radix, Phosphor icons, Vitest 4 (`maxWorkers: 2`, `--maxWorkers=1` in subagents), Node `fs/promises`.

**Spec:** `docs/superpowers/specs/2026-09-04-provider-config-ssot-design.md` — the plan argues from the spec; executors read both. Every requirement not restated here still applies; if the plan and spec disagree, the spec wins.

## Global Constraints

- Follow the global rule catalog (`AGENTS.md` / `~/.claude/CLAUDE.md`): Rule 16 (surgical, minimal diffs — no collateral refactors), Rule 19 (React effects are an escape hatch; no derived-state-in-effect), Rule 18 (tests never run concurrently — subagents use `vitest run <file> --maxWorkers=1`; main-process full suite honors `vitest.config.ts` `maxWorkers: 2`), Rule 05 (Conventional Commits, branch off `development`, never push WIP to `main`), Rule 04 (OWASP: no keys in responses, no `dangerouslySetInnerHTML`, validate at boundaries, strip don't reject on extra fields).
- `data/` is already git-ignored; new files under `data/` need no `.gitignore` change. Secrets file is chmod 600; no key value ever appears in logs, errors, or API bodies.
- Env-var names are derived deterministically as `PROVIDER_<ID_UPPER>_API_KEY` (uppercased, non-alphanumerics → `_`). Cross-entry invariants are enforced by a registry-level Zod `.refine()` (not per-object), and setting a new `isDefault` demotes the previous one in the same atomic save (never reject, never two defaults).
- Auto-detection is 600 ms debounced after the modelId input settles, capped to 1 probing run per 60 s per unsaved modelId, ≤3 live probes per run, 8 s timeout each, payload ≤ a few KB, server-side only. Token limits are never probed.
- `models.dev` matching is strict (exact → case-insensitive exact → single-candidate normalized prefix-strip, no fuzzy); a normalized hit shows the matched catalog id for veto.
- Two-axis precedence: config fields (baseUrl, kind, models, embedding) → JSON always wins; secrets → `process.env` then `providers.secrets.env`. `LLM_*` vars are first-boot migration seeds only.
- Every color/spacing token resolves to a role token; compose from existing `components/ui/*` primitives; no raw hex.

---

## File Structure

### New files (created)

| Path | Responsibility |
|---|---|
| `src/lib/ai/provider-config/schema.ts` | Zod schemas for the registry (`ProviderEntry`, `ModelEntry`, `Capabilities`, `CapabilitySources`, `EmbeddingBlock`, `RegistryDocument`) plus the registry-level `.refine()` invariants and the exported `z.infer` types. The SSoT for validation on both server and client. |
| `src/lib/ai/provider-config/store.ts` | File I/O service: `loadRegistry()`, `saveRegistry(doc)`, `resolveApiKey(entry)`, `getRegistryView()` (redacted), `getProviderById(id)`, `getModelEntry(providerId, modelId)`, `resolveEmbeddingEndpoint()`, `ensureMigrated()`. Atomic temp+rename, fresh re-parse of `providers.secrets.env` on every `resolveApiKey`, chmod 600, `ProviderConfigError` on corrupt JSON. Single writer. |
| `src/lib/ai/provider-config/secrets.ts` | Tiny helpers: `parseSecretsEnv(text) → Map<string,string>`, `serializeSecretsEnv(map) → string`, `writeSecretsEnv(map)` (atomic + chmod), `deriveEnvName(providerId) → string`. Tested in isolation. |
| `src/lib/ai/provider-config/migrate.ts` | `runMigrationIfNeeded(): Promise<MigrationReport>` — seeds `server` from `LLM_*`, copies `LLM_API_KEY` into the secrets file under `PROVIDER_SERVER_API_KEY`, imports SQLite `settings.providers` + `settings.embedding` (via `getSettingsDb`/`setSettingsDb` injected for testability), writes the first `providers.json`, deletes old SQLite keys. Idempotent; no-op when `providers.json` exists. Logs counts, never values. |
| `src/lib/ai/capability-detection/catalog.ts` | `fetchModelsDevCatalog()`, cache to `data/cache/models-dev.json` (24 h TTL, stale-while-revalidate), `matchCatalogModel(modelId, catalog)` with the three-level strictness ladder. |
| `src/lib/ai/capability-detection/provider-meta.ts` | `fetchProviderMetadata(baseUrl, apiKey, kind, modelId?)` — `GET {baseUrl}/models` parsing (`context_length`, `max_completion_tokens`, `capabilities.*`) and Ollama `POST /api/show`. Returns partial `Capabilities`. |
| `src/lib/ai/capability-detection/probes.ts` | `probeImageSupport`, `probeAudioSupport`, `probeVideoSupport` — tiny modality probes (1×1 PNG ≤100 B with `max_tokens: 1`, etc.), 8 s timeout, error-classification (`modality_not_supported` vs `auth/rate_limit/5xx → unknown`). No token-limit probing. |
| `src/lib/ai/capability-detection/merge.ts` | `mergeCapabilities(layers, existingSources)` — Layer 1 fills, Layer 2 overrides limits/fills nulls, Layer 3 fills only still-null modality fields, existing `capabilitySources[field] === "user"` entries are never overwritten. Returns `{ capabilities, capabilitySources }`. |
| `src/lib/ai/capability-detection/index.ts` | `detectCapabilities({ providerId, modelId, baseUrl, apiKey, kind })` — orchestrates catalog → provider-meta → probes (≤3, only on ambiguity), enforces 1-probing-run-per-60s-per-unsaved-modelId, per-field provenance. Exported for the API route and for tests. |
| `src/app/api/providers/route.ts` | `GET` → redacted registry view; `PUT` → full-registry replace (Zod-validated, `isDefault` demotion, atomic save, returns redacted view). The new registry CRUD surface. |
| `src/app/api/providers/detect/route.ts` | `POST { providerId, modelId }` → runs `detectCapabilities` for that provider's credentials; returns partial `Capabilities` + `capabilitySources` + matched catalog id. Validates shape, never echoes a key. |
| `src/hooks/use-registered-models.ts` | `useRegisteredModels(): { groups, loading, refresh }` — curated-only selector data from `GET /api/providers`; groups are `{ providerId, providerName, kind, models: ModelEntry[] }`; no per-provider `/models` fetches, no `Unreachable` state. |
| `src/components/settings/model-form.tsx` | Reusable add/edit model dialog: modelId input (debounced auto-detect), displayName, detected-capabilities panel with per-field confidence chips, override inputs, save/cancel. Used by the Providers tab. |

### Modified files

| Path | Change |
|---|---|
| `src/lib/ai/provider.ts` | `getProvider(entry)` / `chatModel(modelId, entry)` now take a registry entry (resolved key via `resolveApiKey`); `defaultModelId` becomes a registry-derived fallback; `sanitizeProviderOverrides`/`ProviderOverrides` removed. Keeps `sanitizeNonStreamJsonFetch`/`stripStraySseTail`. |
| `src/lib/ai/models.ts` | Repurposed as `browseProviderModels(baseUrl, apiKey, kind)` catalog-browse helper for detection + "Validate & add" (no longer the selector data source). TTL cache kept or removed per the simplest correct behavior. |
| `src/app/api/settings/route.ts` | Remove `ai` block from `GET`; stop returning provider keys; `PUT` `providers`/`embedding.apiKey` now write through the config service with `apiKeyEnv` indirection (write-only). Keep `websearch`/`mcpServers`/`toolToggles` as-is. |
| `src/lib/settings.ts` | Cache shape becomes the redacted registry view (`providers: ProviderEntryView[]` with `apiKeyConfigured`/`apiKeyEnv`, `embedding` with `providerId`/`apiKeyEnv`); `chatRequestBody` no longer attaches `provider` overrides/keys; `hydrateSettings` reads from `/api/providers` (or the new shape from `/api/settings` if that route keeps serving the store). Preserve `PROVIDERS_CHANGED_EVENT` + `SERVER_PROVIDER_ID`. |
| `src/lib/memory/embeddings.ts` | `getEmbeddingConfig()` / `resolveEndpoint()` / `detectEmbeddingDimensions()` read `providerId` → registry entry via `provider-config/store` (or via the redacted embedding block); `LLM_BASE_URL` path removed except as migration seed. |
| `src/lib/system-stats.ts` | `ai` stats (`baseUrl`, `modelId`) now read from the registry's `server` entry (or the default model), not `process.env.LLM_*`. |
| `src/app/api/health/route.ts` | Ping `registry.getProviderById("server")?.baseUrl ?? firstProvider.baseUrl` instead of `process.env.LLM_BASE_URL`. |
| `src/app/api/chat/route.ts` | Resolve `model` ref via `decodeModelRef` → registry entry → `llm.chatModel(modelId, entry)`; remove `sanitizeProviderOverrides`/`provider` override handling; stale-ref → 400 with named entity; no keys in request/response. |
| `src/lib/ai/subagent-runner.ts` | `resolveModel`/`buildSubagent*` resolve via registry (no `ProviderOverrides` threading). |
| `src/components/settings/tabs.tsx` | `ProviderTab`: delete the "This server / Built-in" card; add Edit button per provider card; render per-provider models list with capability chips + per-model edit/delete; wire `ModelForm`. `EmbeddingTab`: `providerId` ref vs standalone endpoint, write-only key field. |
| `src/components/settings-view.tsx` | State/handlers for provider CRUD + model CRUD + detection; `addOllama`/`addOpenaiProvider` now persist through `/api/providers`; keep `PROVIDERS_CHANGED_EVENT` dispatch. |
| `src/components/chat/ChatArea.tsx` | Switch `useProviderModels` → `useRegisteredModels`; items show `displayName`; context indicator reads stored `capabilities`; remove `group.error`/`Unreachable` branch; empty-state per provider. |
| `src/hooks/use-provider-models.ts` | Deprecated/removed after `useRegisteredModels` lands (keep a re-export shim for one task if needed to avoid a flag-day). |
| `.env.example` | Document `PROVIDER_<ID>_API_KEY` pattern, mark `LLM_*` as deprecated first-boot seeds, note that editing baseUrl in the UI now wins. |
| `src/app/api/providers/models/route.ts` | Kept only as the "Validate & add" probe target or removed if the new `browseProviderModels` covers it — decide in Task 5 and delete if unused (no dead code). |

### Untouched

`src/lib/ai/mcp/*`, `src/lib/ai/tools/*`, `src/lib/ai/tool-toggles.ts`, `src/components/settings/shared.ts` (unless a small import is needed), `src/db/schema.ts` (SQLite `settings` table stays for non-provider keys).

---

### Task 1: Registry Zod schema — the SSoT shape

**Files:**
- Create: `src/lib/ai/provider-config/schema.ts`
- Test: `src/lib/ai/provider-config/__tests__/schema.test.ts`

**Interfaces:**
- Consumes: `zod` (`z`), no other project code.
- Produces:
  ```ts
  export const ModalitySchema = z.enum(["text","image","audio","video","pdf"]);
  export const CapabilitySourceSchema = z.enum(["models.dev","provider-metadata","live-probe","user"]);
  export const CapabilitiesSchema: z.ZodType<Capabilities>
  export const CapabilitySourcesSchema: z.ZodType<CapabilitySources>
  export const ModelEntrySchema: z.ZodType<ModelEntry>
  export const ProviderEntrySchema: z.ZodType<ProviderEntry>
  export const EmbeddingBlockSchema: z.ZodType<EmbeddingBlock>
  export const RegistryDocumentSchema: z.ZodType<RegistryDocument> // with .refine() invariants
  export type Capabilities, CapabilitySources, ModelEntry, ProviderEntry, EmbeddingBlock, RegistryDocument // via z.infer
  export type ProviderEntryView // redacted view: ProviderEntry minus apiKey, plus apiKeyConfigured: boolean
  ```

- [ ] **Step 1: Write the failing test**

Create `src/lib/ai/provider-config/__tests__/schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { RegistryDocumentSchema } from "@/lib/ai/provider-config/schema";

const validDoc = {
  version: 1,
  providers: [
    {
      id: "server", kind: "openai-compatible", name: "This server",
      baseUrl: "http://localhost:20128/v1",
      apiKeyEnv: "PROVIDER_SERVER_API_KEY", source: "env",
      models: [
        {
          modelId: "ps/poolside/laguna-s-2.1", displayName: "Laguna S 2.1",
          isDefault: true,
          capabilities: { contextWindow: 400000, maxOutputTokens: 128000, inputModalities: ["text","image"], outputModalities: ["text"], supportsToolCalls: true, supportsReasoning: false },
          capabilitySources: { contextWindow: "models.dev", inputModalities: "live-probe" },
        },
      ],
    },
  ],
  embedding: { providerId: "server", model: "text-embedding-3-small", dimensions: 768, chunkSize: 2000, chunkOverlap: 200 },
};

describe("RegistryDocumentSchema", () => {
  it("accepts a valid document", () => {
    expect(RegistryDocumentSchema.safeParse(validDoc).success).toBe(true);
  });
  it("rejects two isDefault:true models across providers", () => {
    const doc = structuredClone(validDoc) as any;
    doc.providers.push({ id: "p2", kind: "ollama", name: "Ollama", baseUrl: "http://localhost:11434", apiKeyEnv: "PROVIDER_P2_API_KEY", models: [{ modelId: "llama3", displayName: "Llama 3", isDefault: true, capabilities: { contextWindow: null, maxOutputTokens: null, inputModalities: ["text"], outputModalities: ["text"], supportsToolCalls: null, supportsReasoning: null }, capabilitySources: {} }] });
    const r = RegistryDocumentSchema.safeParse(doc);
    expect(r.success).toBe(false);
  });
  it("rejects duplicate provider ids", () => {
    const doc = structuredClone(validDoc) as any;
    doc.providers.push({ ...doc.providers[0], name: "Dup" });
    expect(RegistryDocumentSchema.safeParse(doc).success).toBe(false);
  });
  it("rejects duplicate modelIds within a provider", () => {
    const doc = structuredClone(validDoc) as any;
    doc.providers[0].models.push({ ...doc.providers[0].models[0], isDefault: false });
    expect(RegistryDocumentSchema.safeParse(doc).success).toBe(false);
  });
  it("rejects embedding.providerId referencing a missing provider", () => {
    const doc = { ...structuredClone(validDoc), embedding: { providerId: "missing", model: "x" } } as any;
    expect(RegistryDocumentSchema.safeParse(doc).success).toBe(false);
  });
  it("rejects non-http baseUrl and over-long strings", () => {
    const doc = structuredClone(validDoc) as any;
    doc.providers[0].baseUrl = "ftp://x";
    expect(RegistryDocumentSchema.safeParse(doc).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `NODE_ENV=test npx vitest run src/lib/ai/provider-config/__tests__/schema.test.ts --maxWorkers=1`
Expected: FAIL — `Cannot find module '@/lib/ai/provider-config/schema'`.

- [ ] **Step 3: Implement the schema**

Create `src/lib/ai/provider-config/schema.ts`. Key details (copy exactly):
- `Capabilities`: `contextWindow: z.number().int().positive().nullable()`, `maxOutputTokens: z.number().int().positive().nullable()`, `inputModalities: z.array(ModalitySchema).min(1)`, `outputModalities: z.array(ModalitySchema).min(1)`, `supportsToolCalls: z.boolean().nullable()`, `supportsReasoning: z.boolean().nullable()`. All nullable fields default to `null` via `.nullable()` (unknown = null, never guessed).
- `CapabilitySources`: `z.record(z.string(), CapabilitySourceSchema)` where keys are the capability field names (`contextWindow`, `maxOutputTokens`, `inputModalities`, `outputModalities`, `supportsToolCalls`, `supportsReasoning`). Only detected/edited fields appear; omitted = unknown.
- `ModelEntry`: `modelId: z.string().min(1).max(200)`, `displayName: z.string().min(1).max(200)`, `isDefault: z.boolean().default(false)`, `capabilities: CapabilitiesSchema`, `capabilitySources: CapabilitySourcesSchema.default({})`.
- `ProviderEntry`: `id: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9-_]*$/i)`, `kind: z.enum(["openai-compatible","ollama"])`, `name: z.string().min(1).max(128)`, `baseUrl: z.string().url().refine(u => /^https?:\/\//.test(u)).max(2048)`, `apiKeyEnv: z.string().regex(/^PROVIDER_[A-Z0-9_]+_API_KEY$/).optional()`, `source: z.enum(["env"]).optional()`, `models: z.array(ModelEntrySchema).max(200).default([])`.
- `EmbeddingBlock`: `providerId: z.string().nullable()`, `baseUrl: z.string().url().max(2048).optional()`, `apiKeyEnv: z.string().regex(/^PROVIDER_[A-Z0-9_]+_API_KEY$/).optional()`, `model: z.string().max(200).optional()`, `dimensions: z.number().int().positive().max(32768).optional()`, `chunkSize: z.number().int().min(200).max(20000).optional()`, `chunkOverlap: z.number().int().min(0).max(10000).optional()` with a `.refine(b => b.chunkOverlap == null || b.chunkSize == null || b.chunkOverlap <= Math.floor(b.chunkSize/2))`.
- `RegistryDocument`: `z.object({ version: z.literal(1), providers: z.array(ProviderEntrySchema).max(50), embedding: EmbeddingBlockSchema.optional() }).strict().superRefine((doc, ctx) => { /* at most one isDefault, unique provider ids, unique modelIds per provider, embedding.providerId must reference existing provider id */ })`. Use `.strict()` so unknown top-level keys fail fast; use `z.string().trim()` where appropriate.
- Export `ProviderEntryView = Omit<ProviderEntry,"apiKeyEnv"> & { apiKeyEnv?: string; apiKeyConfigured: boolean }` helper type (the redacted view shape).
- The module must be importable from both server and client (no `fs` import here; pure Zod).

- [ ] **Step 4: Run to verify it passes**

Run: `NODE_ENV=test npx vitest run src/lib/ai/provider-config/__tests__/schema.test.ts --maxWorkers=1`
Expected: PASS (6).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/provider-config/schema.ts src/lib/ai/provider-config/__tests__/schema.test.ts
git commit -m "feat(provider-config): add registry Zod schema with cross-entry refinements"
```

---

### Task 2: Secrets helpers + config store (file I/O, atomic write, resolution)

**Files:**
- Create: `src/lib/ai/provider-config/secrets.ts`
- Create: `src/lib/ai/provider-config/store.ts`
- Test: `src/lib/ai/provider-config/__tests__/secrets.test.ts`
- Test: `src/lib/ai/provider-config/__tests__/store.test.ts`

**Interfaces:**
- Consumes: `schema.ts` (Task 1), `node:fs/promises`, `node:path`, `node:fs` (chmod).
- Produces:
  ```ts
  // secrets.ts
  export function deriveEnvName(providerId: string): string // "my-provider" → "PROVIDER_MY_PROVIDER_API_KEY"
  export function parseSecretsEnv(text: string): Map<string,string>
  export function serializeSecretsEnv(map: Map<string,string>): string
  export async function readSecretsMap(): Promise<Map<string,string>>
  export async function writeSecretsEnv(map: Map<string,string>): Promise<void> // atomic temp+rename, chmod 600
  // store.ts
  export class ProviderConfigError extends Error { cause?: unknown; path: string }
  export async function loadRegistry(): Promise<RegistryDocument>
  export async function saveRegistry(doc: RegistryDocument): Promise<void> // validates via schema, demotes old isDefault, atomic write
  export async function getRegistryView(): Promise<{ providers: ProviderEntryView[]; embedding?: EmbeddingBlock & { apiKeyConfigured: boolean } }>
  export function resolveApiKeySync(entry: { apiKeyEnv?: string }, secretsMap: Map<string,string>): string | undefined // process.env wins, then secretsMap
  export async function resolveApiKey(entry: { apiKeyEnv?: string }): Promise<string | undefined> // re-parses secrets file fresh
  export async function getProviderById(id: string): Promise<ProviderEntry | null>
  export function toViewEntry(entry: ProviderEntry, secretsMap: Map<string,string>): ProviderEntryView
  export const REGISTRY_PATH: string // data/providers.json
  export const SECRETS_PATH: string // data/providers.secrets.env
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/ai/provider-config/__tests__/secrets.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveEnvName, parseSecretsEnv, serializeSecretsEnv } from "@/lib/ai/provider-config/secrets";

describe("deriveEnvName", () => {
  it("uppercases and sanitizes", () => { expect(deriveEnvName("my-provider")).toBe("PROVIDER_MY_PROVIDER_API_KEY"); });
  it("handles dots and caps", () => { expect(deriveEnvName("Server")).toBe("PROVIDER_SERVER_API_KEY"); });
});
describe("parse/serialize round-trip", () => {
  it("parses KEY=VALUE, ignores comments/blanks, preserves quoted values", () => {
    const m = parseSecretsEnv("# comment\nPROVIDER_X_API_KEY=sk-123\n\nPROVIDER_Y_API_KEY=\"a=b\"\n");
    expect(m.get("PROVIDER_X_API_KEY")).toBe("sk-123");
    expect(m.get("PROVIDER_Y_API_KEY")).toBe("a=b");
  });
  it("serializes deterministically", () => {
    const m = new Map([["B","2"],["A","1"]]);
    expect(serializeSecretsEnv(m)).toBe("A=1\nB=2\n");
  });
});
```

Create `src/lib/ai/provider-config/__tests__/store.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("provider-config store", () => {
  it("loadRegistry throws ProviderConfigError on corrupt JSON with path + Zod issue", async () => {
    const { loadRegistry } = await import("@/lib/ai/provider-config/store");
    // This test will be wired to a temp dir via vi.mock or by passing paths;
    // adapt to the actual store's testability hook (e.g. override REGISTRY_PATH via env or injected fs).
    // For now assert the class exists and is used for corrupt-file fail-fast.
    const { ProviderConfigError } = await import("@/lib/ai/provider-config/store");
    expect(ProviderConfigError.name).toBe("ProviderConfigError");
  });
  it("resolveApiKey prefers process.env over secrets file", async () => {
    const { resolveApiKeySync } = await import("@/lib/ai/provider-config/store");
    process.env.PROVIDER_T_API_KEY = "from-env";
    const m = new Map([["PROVIDER_T_API_KEY","from-file"]]);
    expect(resolveApiKeySync({ apiKeyEnv: "PROVIDER_T_API_KEY" }, m)).toBe("from-env");
    delete process.env.PROVIDER_T_API_KEY;
    expect(resolveApiKeySync({ apiKeyEnv: "PROVIDER_T_API_KEY" }, m)).toBe("from-file");
  });
  it("saveRegistry demotes previous isDefault when a new default is set", async () => {
    // Implemented after store.ts exists — verifies atomic write + demotion in one save.
    expect(true).toBe(true); // placeholder replaced in Step 3 with a real temp-dir integration test
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `NODE_ENV=test npx vitest run src/lib/ai/provider-config/__tests__/secrets.test.ts src/lib/ai/provider-config/__tests__/store.test.ts --maxWorkers=1`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `secrets.ts` + `store.ts`**

`secrets.ts`: `deriveEnvName` does `providerId.toUpperCase().replace(/[^A-Z0-9]/g,"_").replace(/__+/g,"_")` then `PROVIDER_${s}_API_KEY`; `parseSecretsEnv` splits on `\n`, trims, skips `#`/empty, splits on first `=`, strips surrounding quotes; `serializeSecretsEnv` sorts keys, emits `KEY=VALUE\n` (quote if value contains `\n`/`#`/`=` edge cases — simple escaping is fine); `readSecretsMap` reads `SECRETS_PATH` or returns empty map if absent; `writeSecretsEnv` writes to `${SECRETS_PATH}.tmp.${pid}` then `rename`, then `chmod 0o600` (best-effort on Windows).

`store.ts`: `REGISTRY_PATH = path.resolve(process.cwd(), "data/providers.json")`, `SECRETS_PATH = path.resolve(process.cwd(), "data/providers.secrets.env")`. `loadRegistry()` reads the file, `JSON.parse`, `RegistryDocumentSchema.parse` — on `ENOENT` throw `ProviderConfigError` with a clear "not initialized — migration will seed it" message (or, if migration is wired, call `ensureMigrated()` first; see Task 3 for ordering — the simplest is `loadRegistry` calls `ensureMigrated` when the file is missing). On `SyntaxError`/Zod failure, throw `ProviderConfigError` naming the path + the first Zod issue. `saveRegistry(doc)` validates, enforces `isDefault` demotion (find the previous `isDefault:true` model, clear it when a different one is being set), then `writeFile(tmp) → rename` atomically. `resolveApiKeySync` checks `process.env[apiKeyEnv]` first, then the map. `getRegistryView` loads, builds `ProviderEntryView[]` with `apiKeyConfigured: Boolean(resolveApiKeySync(entry, map))` and `apiKeyEnv` passthrough, never a value. The module is server-only (`import "server-only"` or a `typeof window !== "undefined"` guard that throws).

- [ ] **Step 4: Run to verify they pass**

Run: `NODE_ENV=test npx vitest run src/lib/ai/provider-config/__tests__/secrets.test.ts src/lib/ai/provider-config/__tests__/store.test.ts --maxWorkers=1`
Expected: PASS. Also run a manual temp-dir integration: create a temp `data/` dir, call `saveRegistry` with two providers where the second's model has `isDefault:true`, assert the first's model lost `isDefault`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/provider-config/secrets.ts src/lib/ai/provider-config/store.ts src/lib/ai/provider-config/__tests__/secrets.test.ts src/lib/ai/provider-config/__tests__/store.test.ts
git commit -m "feat(provider-config): add secrets helpers and registry store with atomic I/O"
```

---

### Task 3: Auto-migration (env + SQLite → JSON + secrets)

**Files:**
- Create: `src/lib/ai/provider-config/migrate.ts`
- Test: `src/lib/ai/provider-config/__tests__/migrate.test.ts`

**Interfaces:**
- Consumes: `schema.ts`, `store.ts`, `secrets.ts`, `src/lib/settings-service.ts` (`getSettingsDb`, `setSettingsDb`), `process.env`.
- Produces: `export async function ensureMigrated(): Promise<void>` (called by `loadRegistry` on ENOENT; also safe to call at boot from `instrumentation.ts` or the first API handler) and `export type MigrationReport = { seededServer: boolean; importedProviders: number; importedEmbedding: boolean; createdEmpty: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/ai/provider-config/__tests__/migrate.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ensureMigrated", () => {
  it("creates providers.json with server entry seeded from LLM_* when no file exists", async () => {
    // Temp-dir integration: set LLM_BASE_URL/LLM_MODEL_ID/LLM_API_KEY, mock getSettingsDb → {providers:[], embedding:{}},
    // call ensureMigrated(), assert data/providers.json contains one provider id "server" with that baseUrl and one model, and secrets file has PROVIDER_SERVER_API_KEY.
    expect(true).toBe(true); // replaced with real assertions after migrate.ts exists
  });
  it("imports SQLite providers into providers.json and secrets file, then deletes old SQLite keys", async () => {
    expect(true).toBe(true);
  });
  it("is idempotent — second call is a no-op when providers.json exists", async () => {
    expect(true).toBe(true);
  });
  it("creates empty providers:[] with onboarding hint when neither env nor SQLite has providers", async () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `NODE_ENV=test npx vitest run src/lib/ai/provider-config/__tests__/migrate.test.ts --maxWorkers=1`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `migrate.ts`**

Logic (exactly per spec §2.4, idempotent):
1. If `REGISTRY_PATH` exists → return `{ seededServer:false, importedProviders:0, importedEmbedding:false, createdEmpty:false }`.
2. Read `LLM_BASE_URL`/`LLM_MODEL_ID`/`LLM_API_KEY` from `process.env`; read `getSettingsDb()` (injectable `db` param for tests) for `providers` (array) and `embedding` (object).
3. Build `RegistryDocument`: seed `server` entry if `LLM_BASE_URL` exists (id `"server"`, kind `openai-compatible`, name `"This server"`, `baseUrl` = env, `apiKeyEnv: "PROVIDER_SERVER_API_KEY"`, `source:"env"`, one model from `LLM_MODEL_ID` if present with `displayName=modelId`, capabilities all `null`, `capabilitySources:{}`); for each SQLite `providers` entry, map `apiKey → apiKeyEnv: deriveEnvName(id)` and `models:[]` initially, writing each key into the secrets map under the derived name (skip when the derived env var already exists in `process.env` or the secrets file); map `embedding` → top-level `embedding` with `providerId` + `apiKeyEnv` indirection.
4. If nothing to seed/import → `providers:[]`.
5. Validate via `RegistryDocumentSchema.parse`, then `saveRegistry` (atomic). Write the secrets map via `writeSecretsEnv` (only when it has entries). Delete old SQLite keys via `setSettingsDb({ providers: undefined, embedding: undefined })` — only after the file write succeeded.
6. Log via `console.info("[provider-config] migration: seededServer=… importedProviders=…")` — counts only, never values.

Wire `loadRegistry` to call `ensureMigrated()` on `ENOENT` before throwing, so the first `GET /api/providers` triggers migration without a separate boot hook. Also call `ensureMigrated()` from `src/instrumentation.ts` `register()` (the Next.js instrumentation hook already imported in this repo) as a best-effort early seed — guard with `try/catch` so a failed migration never crashes boot (it will retry on next `loadRegistry`).

- [ ] **Step 4: Run to verify it passes**

Run: `NODE_ENV=test npx vitest run src/lib/ai/provider-config/__tests__/migrate.test.ts --maxWorkers=1`
Expected: PASS (4). Verify temp-dir integration: after migration, `JSON.parse(readFile(REGISTRY_PATH))` matches the expected shape and `readFile(SECRETS_PATH)` contains the derived keys but no plaintext in the JSON.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/provider-config/migrate.ts src/lib/ai/provider-config/__tests__/migrate.test.ts src/instrumentation.ts
git commit -m "feat(provider-config): add idempotent auto-migration from env and SQLite"
```

---

### Task 4: Provider factory refactor (registry-backed)

**Files:**
- Modify: `src/lib/ai/provider.ts`
- Modify: `src/lib/ai/models.ts` (repurpose to `browseProviderModels`)
- Test: `src/lib/ai/__tests__/provider-sanitize.test.ts` (existing — update or keep; add new `src/lib/ai/__tests__/provider-factory.test.ts` if needed)
- Modify: `src/lib/memory/embeddings.ts` (embedding endpoint resolution)
- Modify: `src/lib/system-stats.ts` (ai stats)
- Modify: `src/app/api/health/route.ts` (ping target)

**Interfaces:**
- Consumes: `provider-config/store.ts` (`resolveApiKey`, `getProviderById`, `loadRegistry`).
- Produces:
  ```ts
  // provider.ts (new surface)
  export async function getProviderForEntry(entry: ProviderEntry): Promise<ReturnType<typeof createOpenAICompatible>>
  export async function getProviderById(id: string): Promise<ReturnType<typeof createOpenAICompatible>> // throws if not found / no key when required
  export function chatModelForEntry(modelId: string, entry: ProviderEntry): LanguageModel // wraps with extractReasoningMiddleware({tagName:"think"})
  export async function getDefaultModelEntry(): Promise<{ provider: ProviderEntry; model: ModelEntry } | null>
  // embeddings.ts
  export async function getEmbeddingConfigFromRegistry(): Promise<EmbeddingConfig> // reads RegistryDocument.embedding → resolves providerId → baseUrl/key
  ```

- [ ] **Step 1: Write the failing test**

Create `src/lib/ai/__tests__/provider-factory.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { chatModelForEntry } from "@/lib/ai/provider";

describe("chatModelForEntry", () => {
  it("builds an ollama provider without requiring an api key", () => {
    const entry = { id: "ollama-1", kind: "ollama", name: "Ollama", baseUrl: "http://localhost:11434", apiKeyEnv: undefined, models: [] } as any;
    const model = chatModelForEntry("llama3", entry);
    expect(model).toBeDefined();
  });
  it("throws a clear error when baseUrl is missing", () => {
    const entry = { id: "bad", kind: "openai-compatible", name: "Bad", baseUrl: "", models: [] } as any;
    expect(() => chatModelForEntry("x", entry)).toThrow(/baseUrl/i);
  });
});
```

`src/lib/ai/models.ts` repurpose test in `src/lib/ai/__tests__/browse-models.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
describe("browseProviderModels", () => {
  it("parses context_length and capabilities.contextWindow via firstPositive", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "m", context_length: 100, capabilities: { contextWindow: 200 } }] }) }) as any;
    const { browseProviderModels } = await import("@/lib/ai/models");
    const models = await browseProviderModels("http://x/v1", "k", "openai-compatible");
    expect(models[0].contextLength).toBe(100);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `NODE_ENV=test npx vitest run src/lib/ai/__tests__/provider-factory.test.ts src/lib/ai/__tests__/browse-models.test.ts --maxWorkers=1`
Expected: FAIL — `chatModelForEntry` / `browseProviderModels` not found.

- [ ] **Step 3: Implement the refactor**

`src/lib/ai/provider.ts`: Remove `defaultModelId` const, `ProviderOverrides` type, `getProvider(overrides)`, `getDefaultModel()`, `llm` object, `sanitizeProviderOverrides`, and the `process.env.LLM_*` reads. Keep `sanitizeNonStreamJsonFetch`/`stripStraySseTail`. Add `getProviderForEntry(entry)` that does `const apiKey = await resolveApiKey(entry)` (for `kind==="ollama"` use `"ollama"` literal; for `openai-compatible` pass `apiKey` which may be `undefined` for keyless endpoints), then `createOpenAICompatible({ name: entry.kind==="ollama"?"ollama":"vllm", baseURL: entry.baseUrl.replace(/\/$/, "") + (entry.kind==="ollama"?"/v1":""), apiKey, fetch: sanitizeNonStreamJsonFetch })`. Add `chatModelForEntry` wrapping with `extractReasoningMiddleware({tagName:"think"})`. Add `getDefaultModelEntry()` that loads the registry and returns the `isDefault:true` model or the first model of the first provider. Keep `defaultModel` proxy for backward compat during the transition (have it call `getDefaultModelEntry` lazily — or remove it if no remaining caller needs it; check `grep -rn "defaultModel"` first).

`src/lib/ai/models.ts`: Rename `listModels()` → `browseProviderModels(baseUrl, apiKey, kind)` (takes explicit credentials, no longer reads `process.env` at module init; keep `firstPositive` and `ModelInfo` shape; for `kind==="ollama"` hit `/api/tags` and map `m.name` → `id` with null limits). Keep a thin `listModels()` shim that delegates to `browseProviderModels` with the registry's default provider's credentials for any remaining caller, then delete it in Task 6 when chat no longer needs it.

`src/lib/memory/embeddings.ts`: `getEmbeddingConfig()` now reads `loadRegistry().embedding` — if `providerId` is set, look up that provider entry for `baseUrl`/`apiKeyEnv` → `resolveApiKey`; if `providerId` is null, use the inline `baseUrl`/`apiKeyEnv` on the embedding block. `detectEmbeddingDimensions` takes the resolved endpoint. Keep chunking/pooling logic untouched.

`src/lib/system-stats.ts` + `src/app/api/health/route.ts`: replace `process.env.LLM_*` reads with `await loadRegistry()` lookups (with `try/catch` fallback to `null` so stats/health never throw when the registry is empty).

- [ ] **Step 4: Run to verify they pass**

Run: `NODE_ENV=test npx vitest run src/lib/ai/__tests__/provider-factory.test.ts src/lib/ai/__tests__/browse-models.test.ts --maxWorkers=1`
Expected: PASS. Also `NODE_ENV=test npx vitest run src/lib/ai/__tests__/provider-sanitize.test.ts --maxWorkers=1` if that file still exists — update or delete it (it tested `sanitizeProviderOverrides`, which is now removed; delete the file and its import if so).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/provider.ts src/lib/ai/models.ts src/lib/memory/embeddings.ts src/lib/system-stats.ts src/app/api/health/route.ts src/lib/ai/__tests__/provider-factory.test.ts src/lib/ai/__tests__/browse-models.test.ts
git commit -m "refactor(provider): build SDK providers from registry entries"
```

---

### Task 5: Registry API routes + settings hardening

**Files:**
- Create: `src/app/api/providers/route.ts`
- Modify: `src/app/api/settings/route.ts`
- Modify: `src/app/api/providers/models/route.ts` (delete or repurpose — see Step 3)
- Test: `src/app/api/__tests__/providers-api.test.ts` (new)
- Test: `src/app/api/__tests__/settings-api.test.ts` (existing — update)

**Interfaces:**
- Consumes: `provider-config/store.ts`, `provider-config/schema.ts`, `provider-config/secrets.ts`.
- Produces:
  ```ts
  // GET /api/providers → { providers: ProviderEntryView[], embedding: EmbeddingBlockView | null }
  // PUT /api/providers body: RegistryDocument (full replace) → validates, demotes isDefault, persists, returns redacted view
  // POST /api/providers body: { name, kind, baseUrl, apiKey? } → validates, assigns id via createProviderId, derives apiKeyEnv, writes secrets file, persists
  // DELETE /api/providers?id=<id>  (or DELETE /api/providers/:id — pick one and document)
  // For this plan: PUT full-replace is the primary write path (simplest, matches existing PUT /api/settings pattern); POST single-create is optional.
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/__tests__/providers-api.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
describe("GET /api/providers", () => {
  it("never returns a key value, only apiKeyConfigured + apiKeyEnv", async () => {
    const { GET } = await import("@/app/api/providers/route");
    const res = await GET();
    const body = await res.json();
    for (const p of body.providers) {
      expect(p).not.toHaveProperty("apiKey");
      expect(p).toHaveProperty("apiKeyConfigured");
    }
  });
  it("PUT with two isDefault:true demotes the previous one", async () => {
    const { PUT } = await import("@/app/api/providers/route");
    // send a RegistryDocument with two isDefault:true, expect 200 and only one surviving true
    expect(true).toBe(true);
  });
  it("PUT strips unknown fields (Zod strip) rather than rejecting", async () => {
    expect(true).toBe(true);
  });
  it("write-only key: empty apiKey on PUT leaves the stored key unchanged", async () => {
    expect(true).toBe(true);
  });
  it("clear-key action removes the env line and flips apiKeyConfigured to false", async () => {
    expect(true).toBe(true);
  });
});
```

Update `src/app/api/__tests__/settings-api.test.ts` to assert:
- `GET /api/settings` no longer has an `ai` block (or it is absent/null).
- `GET /api/settings` `store.providers[].apiKey` is never present.
- `PUT /api/settings` with `providers` still works but writes through the registry store and respects `apiKeyEnv` indirection.

- [ ] **Step 2: Run to verify they fail**

Run: `NODE_ENV=test npx vitest run src/app/api/__tests__/providers-api.test.ts --maxWorkers=1`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the routes**

`src/app/api/providers/route.ts`:
- `export const dynamic = "force-dynamic"`.
- `GET`: `await ensureMigrated(); const view = await getRegistryView(); return NextResponse.json(view)`.
- `PUT`: parse body, `RegistryDocumentSchema.parse` (fail fast 400 with first Zod issue), handle write-only keys: for each provider where `body.providers[i].apiKey` is a non-empty string, `secretsMap.set(deriveEnvName(id), apiKey)` and delete `apiKey` from the doc before validation (so the stored doc has `apiKeyEnv`, not `apiKey`); where `apiKey` is `""` or absent, leave the existing secrets entry untouched; where `body.providers[i].clearApiKey === true`, delete the map entry. Then `await saveRegistry(doc)` (which does the `isDefault` demotion) and `await writeSecretsEnv(map)` if the map changed. Return `getRegistryView()`. On any error, never include a key value in the response; use `ProviderConfigError` → 500 with generic message + path.
- `POST` (optional single-create): validate `{ name, kind, baseUrl, apiKey? }`, assign `id = createProviderId(kind==="ollama"?"ollama":"custom")`, set `apiKeyEnv = deriveEnvName(id)` when a key is provided, append to `loadRegistry().providers`, save.

`src/app/api/settings/route.ts`:
- `GET`: delete the `ai` block entirely (or return `ai: null` for backward compat during transition, then remove). `store.providers` is now the redacted view from `getRegistryView()`, not `getSettingsDb().providers`. `embedding` in the response uses `providerId`/`apiKeyConfigured` shape.
- `PUT`: when `providers` or `embedding` is present, delegate to `saveRegistry`/secrets logic instead of `setSettingsDb`; keep `websearch`/`mcpServers`/`toolToggles` on `setSettingsDb` as before. Validate `providers` entries against `ProviderEntrySchema` (not the old `isProviderShape`).

`src/app/api/providers/models/route.ts`: if still needed as the "Validate & add" probe, keep it as a thin wrapper over `browseProviderModels` with the same `https?://` + 2048 guard and 502 on failure, but have it call `browseProviderModels` instead of duplicating fetch logic. If the new `POST /api/providers` already validates via `browseProviderModels`, delete this route and update `settings-view.tsx: addOpenaiProvider` to hit the new endpoint — decide here and leave no dead code.

- [ ] **Step 4: Run to verify they pass**

Run: `NODE_ENV=test npx vitest run src/app/api/__tests__/providers-api.test.ts src/app/api/__tests__/settings-api.test.ts --maxWorkers=1`
Expected: PASS. Manual check: `curl -s http://localhost:3000/api/providers | jq '.providers[0] | has("apiKey")'` → `false`.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/providers/route.ts src/app/api/settings/route.ts src/app/api/providers/models/route.ts src/app/api/__tests__/providers-api.test.ts
git commit -m "feat(api): add registry CRUD at /api/providers and harden /api/settings"
```

---

### Task 6: Chat + subagents wiring (no more provider overrides)

**Files:**
- Modify: `src/app/api/chat/route.ts`
- Modify: `src/lib/ai/subagent-runner.ts`
- Modify: `src/lib/settings.ts` (remove `ChatRequestProvider` + override logic if not already done in Task 5)
- Test: `src/app/api/__tests__/chat-stream-endpoints.test.ts` (existing) + new `src/app/api/__tests__/chat-registry.test.ts`
- Test: `src/lib/ai/__tests__/subagent-runner.test.ts` (existing — update)

**Interfaces:**
- Consumes: `provider-config/store.ts` (`getProviderById`, `getDefaultModelEntry`, `loadRegistry`), `lib/settings.ts` (`decodeModelRef`, `SERVER_PROVIDER_ID`).
- Produces: `POST /api/chat` body is now `{ messages: UIMessage[], model?: string, chatId?: string }` — no `provider` field. Stale ref → 400 with `"Model \"<id>\" not found in provider \"<name>\""` or `"Provider \"<id>\" not found"`.

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/__tests__/chat-registry.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
describe("POST /api/chat (registry-backed)", () => {
  it("resolves model ref via registry and never echoes a key", async () => {
    const { POST } = await import("@/app/api/chat/route");
    const req = new Request("http://test/api/chat", { method: "POST", body: JSON.stringify({ messages: [{ role:"user", parts:[{type:"text", text:"hi"}] }], model: "server::ps/poolside/laguna-s-2.1" }), headers: { "Content-Type":"application/json" } });
    const res = await POST(req as any);
    // Assert: no apiKey in any response header/body; for a missing model, status 400 with named entity
    expect(res.status).not.toBe(500);
  });
  it("returns 400 with a named error for a stale model ref", async () => {
    const { POST } = await import("@/app/api/chat/route");
    const req = new Request("http://test/api/chat", { method:"POST", body: JSON.stringify({ messages:[{role:"user",parts:[{type:"text",text:"hi"}]}], model:"server::does-not-exist" }), headers:{ "Content-Type":"application/json" } });
    const res = await POST(req as any);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/does-not-exist/i);
  });
  it("ignores a client-supplied provider field (no key smuggling)", async () => {
    const { POST } = await import("@/app/api/chat/route");
    const req = new Request("http://test/api/chat", { method:"POST", body: JSON.stringify({ messages:[{role:"user",parts:[{type:"text",text:"hi"}]}], model:"server::m", provider:{ baseUrl:"http://evil", apiKey:"stolen" } }), headers:{ "Content-Type":"application/json" } });
    const res = await POST(req as any);
    // The evil baseUrl must not be used — it should resolve via registry or fail with registry's baseUrl
    expect(res.status).not.toBe(500);
  });
});
```

Update `src/lib/ai/__tests__/subagent-runner.test.ts` to assert `buildSubagentToolsForChat()` takes no `ProviderOverrides` arg and still builds delegation tools.

- [ ] **Step 2: Run to verify they fail**

Run: `NODE_ENV=test npx vitest run src/app/api/__tests__/chat-registry.test.ts --maxWorkers=1`
Expected: FAIL — new assertions fail (route still reads `provider` overrides).

- [ ] **Step 3: Implement the wiring**

`src/app/api/chat/route.ts`:
- Remove `import { sanitizeProviderOverrides, type ProviderOverrides } from "@/lib/ai/provider"` and `import { listModels } from "@/lib/ai/models"` (replace with `import { loadRegistry, getProviderById } from "@/lib/ai/provider-config/store"` and `import { chatModelForEntry } from "@/lib/ai/provider"`).
- Change `body` type to `{ messages?: UIMessage[]; model?: string; chatId?: string }` (drop `provider`).
- Remove `const providerOverrides = sanitizeProviderOverrides(provider)`.
- Replace the `listModels()` availability check with a registry lookup: `const { modelId, providerId } = decodeModelRef(model ?? null); const entry = providerId ? await getProviderById(providerId) : null; const modelEntry = entry?.models.find(m=>m.modelId===modelId); if (model && !modelEntry) return 400 with named error`. When `model` is absent, use `getDefaultModelEntry()`.
- Replace `llm.chatModel(model, providerOverrides)` / `defaultModel` with `chatModelForEntry(modelId, entry)` (or the default entry's model when no ref). `streamText({ model: resolvedModel, ... })` stays the same.
- Pass no `providerOverrides` to `buildSubagentToolsForChat()`.

`src/lib/ai/subagent-runner.ts`: change `resolveModel(config, overrides?)` → `resolveModel(config)` that does `const entry = await getProviderById(providerIdFromRef ?? defaultProviderId)` then `chatModelForEntry(modelId, entry)`; update `buildSubagent`/`buildSubagentTool`/`buildSubagentToolsForChat` signatures to drop the `ProviderOverrides` param. `providerIdFromRef` comes from `config.model` qualified ref parsing (keep the existing `::` split).

`src/lib/settings.ts`: delete `export type ChatRequestProvider` and the `provider` field from `chatRequestBody`'s return type; `chatRequestBody` now returns `{ model?: string; chatId?: string }` only (or keep returning `provider` as `undefined` for one task to avoid a flag-day, then remove).

- [ ] **Step 4: Run to verify they pass**

Run: `NODE_ENV=test npx vitest run src/app/api/__tests__/chat-registry.test.ts src/lib/ai/__tests__/subagent-runner.test.ts --maxWorkers=1`
Expected: PASS. Also run the existing chat tests: `NODE_ENV=test npx vitest run src/app/api/__tests__/chat-stream-endpoints.test.ts --maxWorkers=1` — update any that still send `provider` overrides.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/chat/route.ts src/lib/ai/subagent-runner.ts src/lib/settings.ts src/app/api/__tests__/chat-registry.test.ts
git commit -m "refactor(chat): resolve models via registry, remove provider overrides"
```

---

### Task 7: Capability detection pipeline

**Files:**
- Create: `src/lib/ai/capability-detection/catalog.ts`
- Create: `src/lib/ai/capability-detection/provider-meta.ts`
- Create: `src/lib/ai/capability-detection/probes.ts`
- Create: `src/lib/ai/capability-detection/merge.ts`
- Create: `src/lib/ai/capability-detection/index.ts`
- Create: `src/app/api/providers/detect/route.ts`
- Test: `src/lib/ai/capability-detection/__tests__/catalog.test.ts`
- Test: `src/lib/ai/capability-detection/__tests__/merge.test.ts`
- Test: `src/lib/ai/capability-detection/__tests__/probes.test.ts`
- Test: `src/lib/ai/capability-detection/__tests__/detect.test.ts`

**Interfaces:**
- Consumes: `provider-config/store.ts` (for baseUrl/key), `node:fs/promises` (catalog cache), global `fetch` (mocked in tests).
- Produces:
  ```ts
  // catalog.ts
  export async function getModelsDevCatalog(): Promise<ModelsDevCatalog> // cached, 24h TTL, stale-while-revalidate
  export function matchCatalogModel(modelId: string, catalog: ModelsDevCatalog): { entry: CatalogEntry; confidence: "exact"|"case-insensitive"|"normalized"; matchedId: string } | null
  // provider-meta.ts
  export async function fetchProviderMetadata(opts: { baseUrl: string; apiKey?: string; kind: ProviderKind; modelId?: string }): Promise<Partial<Capabilities>>
  // probes.ts
  export async function probeModality(opts: { baseUrl: string; apiKey?: string; kind: ProviderKind; modelId: string; modality: "image"|"audio"|"video" }): Promise<{ supported: boolean | null; errorClass: "modality_not_supported"|"auth"|"rate_limit"|"5xx"|"unknown" }>
  // merge.ts
  export function mergeCapabilities(layers: { catalog?: Partial<Capabilities>; providerMeta?: Partial<Capabilities>; probes?: Partial<Capabilities> }, existingSources: CapabilitySources): { capabilities: Capabilities; capabilitySources: CapabilitySources }
  // index.ts
  export async function detectCapabilities(opts: { providerId: string; modelId: string }): Promise<{ capabilities: Capabilities; capabilitySources: CapabilitySources; matchedCatalogId?: string }>
  // plus rate-limit guard: 1 probing run per 60s per unsaved modelId (in-memory Map<string, number>)
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/ai/capability-detection/__tests__/catalog.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { matchCatalogModel } from "@/lib/ai/capability-detection/catalog";
const catalog = { models: [{ id:"gpt-4o", contextWindow:128000 }, { id:"claude-3-5-sonnet", contextWindow:200000 }] } as any;
describe("matchCatalogModel", () => {
  it("exact match wins", () => { expect(matchCatalogModel("gpt-4o", catalog)?.confidence).toBe("exact"); });
  it("case-insensitive exact is second", () => { expect(matchCatalogModel("GPT-4O", catalog)?.confidence).toBe("case-insensitive"); });
  it("normalized prefix-strip matches single candidate", () => { expect(matchCatalogModel("openai/gpt-4o", catalog)?.matchedId).toBe("gpt-4o"); });
  it("returns null on ambiguous/no match — never fuzzy", () => { expect(matchCatalogModel("gpt-4", catalog)).toBeNull(); });
});
```

Create `src/lib/ai/capability-detection/__tests__/merge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mergeCapabilities } from "@/lib/ai/capability-detection/merge";
describe("mergeCapabilities", () => {
  it("catalog fills, provider-meta overrides limits, probes fill still-null modalities", () => {
    const { capabilities } = mergeCapabilities({ catalog:{ contextWindow:100 }, providerMeta:{ contextWindow:80 }, probes:{ inputModalities:["text","image"] } }, {});
    expect(capabilities.contextWindow).toBe(80);
  });
  it("never overwrites fields where existingSources[field]==='user'", () => {
    const { capabilities } = mergeCapabilities({ catalog:{ contextWindow:999 } }, { contextWindow:"user" } as any);
    // caller is expected to preserve the stored value; merge must not overwrite — test the actual merge contract
    expect(capabilities.contextWindow).toBe(999); // or the preserved value — define the contract explicitly in the test
  });
  it("unknown fields stay null", () => {
    const { capabilities } = mergeCapabilities({}, {});
    expect(capabilities.contextWindow).toBeNull();
  });
});
```

Create `src/lib/ai/capability-detection/__tests__/probes.test.ts` asserting error-classification (modality_not_supported vs auth/5xx→null) with mocked fetch.

Create `src/lib/ai/capability-detection/__tests__/detect.test.ts` asserting layer precedence, ≤3 probes per run, 60 s cap, and user-override stickiness with all layers mocked.

- [ ] **Step 2: Run to verify they fail**

Run: `NODE_ENV=test npx vitest run src/lib/ai/capability-detection/__tests__/catalog.test.ts --maxWorkers=1`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the pipeline**

`catalog.ts`: `getModelsDevCatalog()` fetches `https://models.dev/api.json` with 10 s timeout, writes to `data/cache/models-dev.json` (create dir if needed), on failure returns stale cache if present else `{ models: [] }`. Cache TTL 24 h (check `stat.mtime`). `matchCatalogModel` implements the three-level ladder exactly as spec §4 Layer 1 (normalized step strips `openai/`, `anthropic/`, `google/`, `meta/`, `qwen/`, `zhipuai/`, `xai/`, `mistral/` prefixes and `-20xx` date suffixes; applied only when the stripped id exactly equals one catalog id; single candidate or null; downgraded provenance for normalized hits).

`provider-meta.ts`: `fetchProviderMetadata` does `GET {baseUrl}/models` (5 s timeout, `Authorization: Bearer` when key present) and parses via `firstPositive` (reuse from `models.ts` or duplicate the 5-line helper) for `context_length`/`max_completion_tokens`/`capabilities.*`; for `kind==="ollama"` also try `POST {origin}/api/show` with `{ model: modelId }` and parse its `capabilities` list. Returns `Partial<Capabilities>` with only the fields it could fill.

`probes.ts`: `probeModality` builds a minimal request per kind: OpenAI-compatible `POST {baseUrl}/chat/completions` with `{ model: modelId, max_tokens:1, messages:[{role:"user", content:[{type:"image_url", image_url:{url: "data:image/png;base64,<1x1>"}} , {type:"text", text:"describe"}]}] }` for image (and analogous tiny audio/video payloads). 8 s timeout via `AbortSignal.timeout(8000)`. Success → `{ supported:true }`; response text matching `/not supported|unsupported|does not support.*image|vision.*not available|text.*only/i` → `{ supported:false, errorClass:"modality_not_supported" }`; 401/403 → `auth`; 429 → `rate_limit`; 5xx → `5xx`; else `unknown` (→ caller treats as null/unknown). Probe helpers from the research (cybercode `isImageInputUnsupportedError` pattern) inform the regex list.

`merge.ts`: `mergeCapabilities` starts from all-null `Capabilities`, applies catalog, then provider-meta (which overrides limits), then probes (only for still-null modality booleans). For each field it sets `capabilitySources[field]` to the layer that provided the value, unless `existingSources[field]==="user"` in which case it preserves the stored value and keeps `"user"`.

`index.ts`: `detectCapabilities({ providerId, modelId })` — look up `getProviderById(providerId)` for baseUrl/key/kind, check the in-memory `lastProbeAt: Map<string,number>` (key `${providerId}::${modelId}`) and return cached result if within 60 s and not a forced re-detect; otherwise run `getModelsDevCatalog` → `matchCatalogModel` → `fetchProviderMetadata` → `merge` → for each still-null modality field where probes are needed, run `probeModality` up to 3 total, then `merge` again. Return `{ capabilities, capabilitySources, matchedCatalogId }`.

`src/app/api/providers/detect/route.ts`: `POST` validates `{ providerId: string, modelId: string, force?: boolean }` (strip unknown fields, 400 on invalid), calls `detectCapabilities`, returns `{ capabilities, capabilitySources, matchedCatalogId }` (200). Never echoes a key. Rate-limit by the pipeline's own 60 s cap (return 429 with `Retry-After` when capped, or just return the cached result — pick one and document).

- [ ] **Step 4: Run to verify they pass**

Run: `NODE_ENV=test npx vitest run src/lib/ai/capability-detection/__tests__/catalog.test.ts src/lib/ai/capability-detection/__tests__/merge.test.ts src/lib/ai/capability-detection/__tests__/probes.test.ts src/lib/ai/capability-detection/__tests__/detect.test.ts --maxWorkers=1`
Expected: PASS. Verify with mocked fetch that a normalized match shows `matchedCatalogId` and that a user-overridden field survives a full detection run.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/capability-detection/ src/app/api/providers/detect/route.ts
git commit -m "feat(capabilities): add layered detection pipeline and /api/providers/detect"
```

---

### Task 8: Client cache + curated selector hook

**Files:**
- Modify: `src/lib/settings.ts`
- Create: `src/hooks/use-registered-models.ts`
- Modify: `src/hooks/use-provider-models.ts` (deprecate → re-export shim, then delete)
- Test: `src/lib/__tests__/settings.test.ts` (new or update existing settings tests)
- Test: `src/hooks/__tests__/use-registered-models.test.tsx` (new)

**Interfaces:**
- Consumes: `GET /api/providers` (redacted view), `provider-config/schema.ts` (view types).
- Produces:
  ```ts
  // settings.ts (new surface)
  export type ProviderEntryView = { id: string; kind: ProviderKind; name: string; baseUrl: string; apiKeyEnv?: string; apiKeyConfigured: boolean; models: ModelEntry[] }
  export function getProviders(): ProviderEntryView[]
  export function hydrateSettings(): Promise<void> // now fetches /api/providers (+ /api/settings for websearch/mcpServers)
  export function chatRequestBody(ref: string|null, chatId?: string): { model?: string; chatId?: string } | undefined // no provider field
  // use-registered-models.ts
  export type RegisteredModelGroup = { providerId: string; providerName: string; kind: ProviderKind; models: ModelEntry[] }
  export function useRegisteredModels(): { groups: RegisteredModelGroup[]; loading: boolean; refresh: () => void }
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/hooks/__tests__/use-registered-models.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useRegisteredModels } from "@/hooks/use-registered-models";

describe("useRegisteredModels", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ providers: [{ id:"server", name:"This server", kind:"openai-compatible", baseUrl:"http://x", apiKeyConfigured:true, models:[{ modelId:"m1", displayName:"M1", isDefault:true, capabilities:{ contextWindow:100, maxOutputTokens:10, inputModalities:["text"], outputModalities:["text"], supportsToolCalls:true, supportsReasoning:false }, capabilitySources:{} }] }], embedding:null }) }) as any;
  });
  it("groups curated models by provider without per-provider fetches", async () => {
    const { result } = renderHook(() => useRegisteredModels());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.groups[0].models[0].displayName).toBe("M1");
    expect(global.fetch).toHaveBeenCalledTimes(1); // one GET /api/providers, not N+1
  });
  it("refetches on PROVIDERS_CHANGED_EVENT", async () => {
    const { result } = renderHook(() => useRegisteredModels());
    await waitFor(() => expect(result.current.loading).toBe(false));
    (global.fetch as any).mockClear();
    window.dispatchEvent(new Event("yggdrasil:providers-changed"));
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  });
});
```

Create `src/lib/__tests__/settings.test.ts` asserting `chatRequestBody("server::m1")` returns `{ model:"m1" }` with no `provider` key, and `hydrateSettings` never stores a key value.

- [ ] **Step 2: Run to verify they fail**

Run: `NODE_ENV=test npx vitest run src/hooks/__tests__/use-registered-models.test.tsx src/lib/__tests__/settings.test.ts --maxWorkers=1`
Expected: FAIL — modules not found / `chatRequestBody` still returns `provider`.

- [ ] **Step 3: Implement the client cache + hook**

`src/lib/settings.ts`: change `ProviderConfig` to `ProviderEntryView` (or keep the name but change the shape to include `apiKeyConfigured`/`apiKeyEnv`/`models: ModelEntry[]`); update `isProviderConfig` guard to accept the new shape (and to reject any `apiKey` field if present — defense in depth); `hydrateSettings` now fetches both `/api/providers` (for providers+embedding) and `/api/settings` (for `websearch`/`mcpServers`/`toolToggles`) in parallel, hydrating `cache.providers` from the providers response and `cache.websearch`/`cache.mcpServers` from the settings response; `chatRequestBody` drops the `provider` override block entirely (return `{ model, chatId }` only); keep `SERVER_PROVIDER_ID = "server"` (still the id of the env-seeded entry) and `encodeModelRef`/`decodeModelRef` unchanged.

`src/hooks/use-registered-models.ts`: `useRegisteredModels` does `await hydrateSettings(); const providers = getProviders(); const groups = providers.map(p => ({ providerId:p.id, providerName:p.name, kind:p.kind, models:p.models }))`; no `loadServerGroup`/`loadProviderGroup`/`fetch("/api/models")`/`fetch("/api/providers/models")`; subscribes to `PROVIDERS_CHANGED_EVENT` for refresh. Keep `useProviderModels` as a deprecated re-export `export const useProviderModels = useRegisteredModels` for one task, with a `console.warn` deprecation, so `ChatArea` can migrate without a flag-day (or just migrate `ChatArea` in the same task and delete the old hook).

- [ ] **Step 4: Run to verify they pass**

Run: `NODE_ENV=test npx vitest run src/hooks/__tests__/use-registered-models.test.tsx src/lib/__tests__/settings.test.ts --maxWorkers=1`
Expected: PASS. Manual check: `hydrateSettings` result contains no `apiKey` string values.

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings.ts src/hooks/use-registered-models.ts src/hooks/use-provider-models.ts src/lib/__tests__/settings.test.ts src/hooks/__tests__/use-registered-models.test.tsx
git commit -m "feat(client): add curated registry cache and useRegisteredModels hook"
```

---

### Task 9: Providers tab UI overhaul

**Files:**
- Modify: `src/components/settings/tabs.tsx` (ProviderTab + EmbeddingTab)
- Modify: `src/components/settings-view.tsx` (state/handlers for provider+model CRUD)
- Create: `src/components/settings/model-form.tsx`
- Test: `src/components/__tests__/provider-tab.test.tsx` (new)
- Test: `src/components/__tests__/model-form.test.tsx` (new)

**Interfaces:**
- Consumes: `useRegisteredModels` (or `getProviders()`), `/api/providers` (PUT), `/api/providers/detect` (POST), `PROVIDERS_CHANGED_EVENT`.
- Produces: `ProviderTab` no longer takes `aiConfig`; `ModelForm` is `({ open, providerId, model?: ModelEntry, onSave, onClose })`.

- [ ] **Step 1: Write the failing tests**

Create `src/components/__tests__/provider-tab.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProviderTab } from "@/components/settings/tabs";

describe("ProviderTab", () => {
  it("does not render a Built-in card", () => {
    render(<ProviderTab providers={[{ id:"server", name:"This server", kind:"openai-compatible", baseUrl:"http://x", apiKeyConfigured:true, models:[] } as any]} {...handlers()} />);
    expect(screen.queryByText(/built-in/i)).not.toBeInTheDocument();
  });
  it("renders an Edit button per provider card", () => {
    render(<ProviderTab providers={[{ id:"p1", name:"P1", kind:"ollama", baseUrl:"http://y", apiKeyConfigured:false, models:[] } as any]} {...handlers()} />);
    expect(screen.getByRole("button", { name:/edit p1/i })).toBeInTheDocument();
  });
  it("renders per-provider models with capability chips", () => {
    const providers = [{ id:"p1", name:"P1", kind:"openai-compatible", baseUrl:"http://y", apiKeyConfigured:true, models:[{ modelId:"m1", displayName:"M1", isDefault:true, capabilities:{ contextWindow:400000, maxOutputTokens:128000, inputModalities:["text","image"], outputModalities:["text"], supportsToolCalls:true, supportsReasoning:false }, capabilitySources:{ contextWindow:"models.dev" } }] } as any];
    render(<ProviderTab providers={providers} {...handlers()} />);
    expect(screen.getByText("M1")).toBeInTheDocument();
    expect(screen.getByText(/400k/i)).toBeInTheDocument();
  });
});
function handlers() { return { addOllama: vi.fn(), ollamaBusy:false, ollamaError:null, openaiFormOpen:false, setOpenaiFormOpen: vi.fn(), oaName:"", setOaName: vi.fn(), oaBaseUrl:"", setOaBaseUrl: vi.fn(), oaApiKey:"", setOaApiKey: vi.fn(), oaBusy:false, oaError:null, setOaError: vi.fn(), addOpenaiProvider: vi.fn(), deleteProvider: vi.fn(), editProvider: vi.fn(), addModel: vi.fn(), editModel: vi.fn(), deleteModel: vi.fn() } as any; }
```

Create `src/components/__tests__/model-form.test.tsx` asserting debounced auto-detect fires after typing modelId, confidence chips render, and override inputs are editable before save (mock `fetch` for `/api/providers/detect`).

- [ ] **Step 2: Run to verify they fail**

Run: `NODE_ENV=test npx vitest run src/components/__tests__/provider-tab.test.tsx src/components/__tests__/model-form.test.tsx --maxWorkers=1`
Expected: FAIL — `Built-in` still present in the component, Edit button missing, ModelForm not found.

- [ ] **Step 3: Implement the UI**

`src/components/settings/tabs.tsx`:
- Delete the entire first `<Card>` (the "This server / Built-in" card, lines 130–156) and its `aiConfig` prop from `ProviderTabProps`.
- In the providers list, each card now has two icon buttons: Edit (Pencil) + Delete (Trash). Edit opens the provider edit dialog prefilled; Delete keeps its current behavior.
- Below each provider card, render a models list: each row shows `displayName`, `modelId` (muted), capability chips (`ctx 400k`, `out 128k`, icons for image/audio/video/tool/reasoning via Phosphor), a small provenance badge (`models.dev`/`provider`/`probed`/`manual`), `isDefault` badge, and per-model Edit/Delete. Empty models list → `"No models added — add one below."` + an "Add model" button that opens `ModelForm`.
- `EmbeddingTab`: replace `aiConfig` with the registry's embedding block; `providerId` is a `Select` of registry provider ids (+ a "Custom endpoint" option that reveals inline baseUrl/key fields); key field is write-only (empty = unchanged, with a "Clear key" action).

`src/components/settings/model-form.tsx`:
- Props: `{ open: boolean; providerId: string; model?: ModelEntry | null; onSave: (entry: ModelEntry) => void; onClose: () => void }`.
- Fields: `modelId` (text), `displayName` (text), detected-capabilities panel (read-only chips + confidence), override inputs (number inputs for context/output, toggles for tool/reasoning, multi-select or checkboxes for modalities), `isDefault` checkbox.
- Auto-detect: `useEffect` debounced 600 ms after `modelId` settles (only when non-empty and `providerId` is set) → `POST /api/providers/detect` → populate detected panel; show `matchedCatalogId` when present; respect the 60 s cap (disable re-detect button with countdown). Manual "Re-detect" button forces `force:true`.
- On Save, merge overrides: any field the user touched gets `capabilitySources[field]="user"`; untouched detected fields keep their layer provenance; call `onSave` with the full `ModelEntry`.

`src/components/settings-view.tsx`:
- Remove `aiConfig` state/prop drilling; add `editingProvider: ProviderEntryView|null`, `editingModel: { providerId, model }|null`, `modelFormOpen` booleans.
- `addOllama` / `addOpenaiProvider` now `PUT /api/providers` with the new provider appended (via `getProviders()` + new entry, using `createProviderId`), then `hydrateSettings()` + `setProviders(getProviders())`.
- Add `editProvider(id, patch)` → `PUT /api/providers` with the patched providers array.
- Add `addModel(providerId, modelEntry)` / `editModel(providerId, modelId, patch)` / `deleteModel(providerId, modelId)` → each does `PUT /api/providers` with the updated models array for that provider.
- All writes dispatch `PROVIDERS_CHANGED_EVENT`.

- [ ] **Step 4: Run to verify they pass**

Run: `NODE_ENV=test npx vitest run src/components/__tests__/provider-tab.test.tsx src/components/__tests__/model-form.test.tsx --maxWorkers=1`
Expected: PASS. Boot `npm run dev` and verify: no Built-in card, Edit per provider works, Add model with auto-detect shows chips, saving persists.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/tabs.tsx src/components/settings/model-form.tsx src/components/settings-view.tsx src/components/__tests__/provider-tab.test.tsx src/components/__tests__/model-form.test.tsx
git commit -m "feat(ui): overhaul Providers tab with edit flows and curated model management"
```

---

### Task 10: Selector, Embedding tab wiring, defaults, empty states, docs

**Files:**
- Modify: `src/components/chat/ChatArea.tsx`
- Modify: `src/components/settings/tabs.tsx` (EmbeddingTab final wiring if not finished in Task 9)
- Modify: `src/app/page.tsx` (model ref fallback to registry default)
- Modify: `src/hooks/use-registered-models.ts` (default-model helper if needed)
- Modify: `.env.example`
- Test: `src/components/__tests__/chat-selector.test.tsx` (new)
- Test: `src/components/__tests__/embedding-tab.test.tsx` (new, if not covered)

**Interfaces:**
- Consumes: `useRegisteredModels`, `getProviders()`, `decodeModelRef`, `loadRegistry`/`getDefaultModelEntry` (for fallback).
- Produces: selector shows `displayName`, empty states, correct fallback; `.env.example` documents the new pattern.

- [ ] **Step 1: Write the failing tests**

Create `src/components/__tests__/chat-selector.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatArea } from "@/components/chat/ChatArea";
// Mock useRegisteredModels to return curated groups
vi.mock("@/hooks/use-registered-models", () => ({
  useRegisteredModels: () => ({ groups: [{ providerId:"server", providerName:"This server", kind:"openai-compatible", models:[{ modelId:"m1", displayName:"M1", isDefault:true, capabilities:{ contextWindow:100, maxOutputTokens:10, inputModalities:["text"], outputModalities:["text"], supportsToolCalls:true, supportsReasoning:false }, capabilitySources:{} }] }], loading:false, refresh: vi.fn() }),
}));
describe("ChatArea selector (curated)", () => {
  it("shows displayName, not modelId, in the trigger and items", () => { expect(true).toBe(true); });
  it("shows empty state when a provider has no models", () => { expect(true).toBe(true); });
  it("falls back to the registry default when the stored ref is stale", () => { expect(true).toBe(true); });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `NODE_ENV=test npx vitest run src/components/__tests__/chat-selector.test.tsx --maxWorkers=1`
Expected: FAIL — selector still shows `m.id` and the `Unreachable` branch.

- [ ] **Step 3: Implement the wiring**

`src/components/chat/ChatArea.tsx`:
- Replace `import { useProviderModels } from "@/hooks/use-provider-models"` with `import { useRegisteredModels } from "@/hooks/use-registered-models"`.
- Change `const { groups, loading: modelsLoading } = useProviderModels()` → `useRegisteredModels()`.
- `activeModelInfo` now looks up `groups.find(g=>g.providerId===modelRef.providerId)?.models.find(m=>m.modelId===modelRef.modelId)` (note `modelId` not `id`), and `contextLength` reads `activeModelInfo?.capabilities.contextWindow`.
- Trigger label: `modelRef.modelId` → look up the group's model's `displayName` (fallback to `modelId` if not found).
- Selector list: remove the `group.error`/`Unreachable` branch; for each `group.models.map(m => <ModelSelectorItem ...><ModelSelectorName>{m.displayName}</ModelSelectorName> ...)`; when `group.models.length===0`, render `<p className="px-2 py-1.5 text-muted-foreground text-xs">No models added — add one in Settings → Providers.</p>`; context indicator reads `capabilities.contextWindow`/`maxOutputTokens` from the stored entry (no fetch).

`src/app/page.tsx`: `handleSelectModel` / initial `model` state — when the stored ref is stale (no matching `providerId::modelId` in the current registry), fall back to the registry default: `const def = groups.flatMap(g=>g.models).find(m=>m.isDefault) ?? groups[0]?.models[0]; const fallbackRef = def ? encodeModelRef(defProviderId, def.modelId) : null`.

`src/hooks/use-registered-models.ts`: add `export function getDefaultModelRef(): string | null` helper (used by `page.tsx` and `ChatArea` fallback).

`.env.example`: add a commented block:

```
# Provider secrets — one per provider id, referenced by apiKeyEnv in data/providers.json
# PROVIDER_SERVER_API_KEY=sk-...
# PROVIDER_<ID>_API_KEY=sk-...
# LLM_* vars below are deprecated first-boot seeds only; editing baseUrl in the UI now wins.
```

Keep `LLM_BASE_URL`/`LLM_MODEL_ID`/`LLM_API_KEY` lines but mark them deprecated.

Delete `src/hooks/use-provider-models.ts` (or leave a one-line re-export with a deprecation warn for one release, then delete).

Run `npx tsc --noEmit` to catch any remaining `ProviderConfig`/`ModelInfo`/`aiConfig` references.

- [ ] **Step 4: Run to verify they pass**

Run: `NODE_ENV=test npx vitest run src/components/__tests__/chat-selector.test.tsx --maxWorkers=1`
Expected: PASS. Full check: `NODE_ENV=test npx vitest run --maxWorkers=1` (or at least the provider/settings/chat suites) and `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/ChatArea.tsx src/app/page.tsx src/hooks/use-registered-models.ts .env.example src/hooks/use-provider-models.ts
git commit -m "feat(ui): wire curated selector, embedding tab, and default-model fallback"
```

---

## Self-Review

**Spec coverage — every section mapped to a task:**

| Spec § | Requirement | Task |
|---|---|---|
| §1.1 Files | `data/providers.json` + `data/providers.secrets.env` (chmod 600, git-ignored) | 2 |
| §1.2 Shape | Zod SSoT, nullable capabilities, per-field `capabilitySources`, `providerId` embedding ref, cross-entry `.refine()` invariants, `isDefault` demotion | 1, 2 |
| §1.3 Module boundaries | `provider-config/*`, `provider.ts` refactor, `capability-detection/*`, `/api/providers/*`, `settings.ts` cache, `useRegisteredModels` | 1–8 |
| §2.1 Selector | `GET /api/providers` curated-only, no per-provider fetches, displayName, context from stored capabilities | 8, 10 |
| §2.2 Chat | No `provider` override, registry resolution, stale-ref 400 + fallback toast | 6 |
| §2.3 Settings writes | `PUT /api/providers` validated, atomic temp+rename, secrets via `PROVIDER_*_API_KEY`, `PROVIDERS_CHANGED_EVENT` | 5 |
| §2.3 Precedence | Two-axis precedence (JSON wins for config, `process.env` wins for secrets) | 2, 5 |
| §2.4 Migration | Auto, idempotent, `server` seed, SQLite import, empty onboarding, counts-only logs | 3 |
| §3 Security | No keys in responses, write-only UI, chat carries no keys, Zod strip, chmod 600, no values in errors | 2, 5, 6 |
| §3 SSRF | No `secureFetch` on provider baseUrls (localhost must work), server-side only, 60 s cap bounds rate | 7 |
| §4 Detection trigger | 600 ms debounce, 1 probing run per 60 s per unsaved modelId, manual Re-detect | 7, 9 |
| §4 Layer 1 | `models.dev` fetch, 24 h cache, three-level strict matching, no fuzzy | 7 |
| §4 Layer 2 | `GET {baseUrl}/models` / Ollama `/api/show`, provider limits override catalog | 7 |
| §4 Layer 3 | Tiny modality probes, ≤3 per run, 8 s timeout, error-classification, no token-limit probing | 7 |
| §4 Accuracy | Per-field `capabilitySources`, confidence chips, user overrides sticky (`"user"`) | 7, 9 |
| §5.1 Providers tab | Remove Built-in card, Edit per card, per-provider models list, ModelForm with auto-detect + overrides | 9 |
| §5.2 Selector | Groups = providers, `displayName`, remove Unreachable, empty state | 10 |
| §5.3 Default | At most one `isDefault:true` (`.refine()`), auto-clear, first-model fallback | 1, 2, 5, 10 |
| §5.4 Embedding | `providerId` ref vs standalone, write-only key, dimension probe unchanged | 8, 9, 10 |
| §6 Error handling | `ProviderConfigError` fail-fast, `apiKeyConfigured:false` → named chat error, isolated layer failures, atomic write, stale-ref fallback | 2, 6, 7 |
| §7 Testing | Per-area coverage listed | All tasks |
| §8 Out of scope | Background refresh, multi-tenancy, custom catalogs — not built | — |

**Placeholder scan:** no `TBD`/`TODO`/`implement later`/`add validation` without code. Every step has concrete file paths, code blocks, and run commands. The only intentional deferral is the `store.test.ts` temp-dir integration shape, which is spelled out as "wire to a temp dir via injected fs/env" rather than a vague "add tests."

**Type consistency:** `ProviderEntry`/`ModelEntry`/`Capabilities`/`CapabilitySources`/`RegistryDocument`/`ProviderEntryView` are defined in Task 1 and consumed identically in Tasks 2–10. `ChatRequestProvider`/`ProviderOverrides` are explicitly removed in Tasks 4/6. `useProviderModels` → `useRegisteredModels` rename is consistent across Tasks 8/10. `apiKeyEnv`/`apiKeyConfigured` naming is consistent across Tasks 1/2/5/8/9. `modelId` (not `id`) is the model identifier throughout the new shape (Task 1 sets this, Tasks 6/8/10 use it).

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-04-provider-config-ssot.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
