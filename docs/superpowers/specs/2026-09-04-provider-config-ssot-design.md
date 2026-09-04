# Provider Configuration SSoT Refactor — Design

**Date:** 2026-09-04
**Status:** Final design — all brainstorming decisions locked, review revisions applied (2026-09-04)
**Scope:** Chat provider registry, model registry, capability detection, settings UI, embeddings settings

## Problem

Provider configuration is split across three stores with no single source of truth:

1. An implicit "This server" built-in provider defined by `LLM_*` env vars (`src/lib/ai/provider.ts`), rendered as a read-only "Built-in" card in the Providers tab.
2. User-added providers (Ollama / OpenAI-compatible) stored as a JSON array in the SQLite `settings` table.
3. Per-provider API keys sent to the browser in plaintext by `GET /api/settings` and carried back on every chat request as a `provider` override block.

Model loading auto-fetches every model from every provider at once (`/api/models`, `/api/providers/models`), giving the selector a full dump with capability data only for the server provider.

This refactor makes `data/providers.json` the single source of truth for all providers and their user-curated models, keeps secrets in env files referenced by name (the "symlink"), introduces accurate layered capability detection, curates the model selector, and fixes the plaintext-key leak.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| JSON↔env connection | Indirection by env var name (`apiKeyEnv`) — no literal filesystem symlinks |
| Built-in env provider | Becomes a normal editable entry in providers.json (id preserved as `"server"`) |
| Capability detection trigger | Auto-detect as you type (debounced) |
| Probe policy | Metadata first, live probe only on ambiguity, cost-capped |
| Migration | Automatic on boot, idempotent |
| Secrets in UI responses | Server-only — never sent to browser; write-only edit fields |
| Config file location | `data/providers.json` (+ `data/providers.secrets.env`) |
| Embeddings | Migrate too (same registry, same env-name indirection) |
| Runtime key entry (UI) | App-managed secrets file `data/providers.secrets.env` |
| Env var precedence post-migration | JSON value always wins; env vars are migration seeds only |
| Architecture | Approach A — unified provider registry with layered capability pipeline |

## 1. Architecture

### 1.1 Files

```
data/
  providers.json          # SSoT: provider entries + per-provider curated models
  providers.secrets.env   # app-managed, git-ignored: PROVIDER_*_API_KEY=... lines only
```

Both are covered by the existing `data/` entry in `.gitignore`. The secrets file is chmod 600 on write.

### 1.2 providers.json shape

Validated by a Zod schema (the single source for both server and client types via `z.infer`):

```jsonc
{
  "version": 1,
  "providers": [
    {
      "id": "server",                    // preserved from SERVER_PROVIDER_ID
      "kind": "openai-compatible",      // | "ollama"
      "name": "This server",
      "baseUrl": "http://localhost:20128/v1",
      "apiKeyEnv": "PROVIDER_SERVER_API_KEY",  // secret by name — the "symlink"
      "source": "env",                   // seeded from LLM_* env vars; nullable
      "models": [
        {
          "modelId": "ps/poolside/laguna-s-2.1",
          "displayName": "Laguna S 2.1",
          "isDefault": false,            // at most one per registry
          "capabilities": {
            "contextWindow": 400000,     // number | null (null = unknown)
            "maxOutputTokens": 128000,   // number | null
            "inputModalities": ["text", "image"],   // subset of text|image|audio|video|pdf
            "outputModalities": ["text"],
            "supportsToolCalls": true,   // boolean | null
            "supportsReasoning": false   // boolean | null
          },
          "capabilitySources": {         // per-field provenance; only fields that
            "contextWindow": "provider-metadata",  // were actually detected/edited
            "inputModalities": "live-probe"        // appear here. Values:
                                                  // "models.dev" | "provider-metadata"
                                                  // | "live-probe" | "user"
          }
        }
      ]
    }
  ],
  "embedding": {                          // migrated EmbeddingSettings shape
    "providerId": "server",               // references a providers[] entry by id;
                                          // null = standalone endpoint below
    "baseUrl": "http://localhost:11434/v1",  // used when providerId is null
    "apiKeyEnv": "PROVIDER_EMBEDDING_API_KEY", // used when providerId is null
    "model": "nomic-embed-text",
    "dimensions": 768,
    "chunkSize": 2000,
    "chunkOverlap": 200
  }
}
```

Nullable capability fields mean "unknown" — never guessed. Per-field provenance lives in `capabilitySources` (a map keyed by field name, omitting undetected fields). Any field a user edited is recorded there as `"user"` and all automated detection/refresh must preserve it.

**Cross-entry invariants are enforced at the registry level via Zod `.refine()` on the whole document** (per-object shapes alone can't express them): at most one `isDefault: true` model across all providers; unique provider ids; unique modelIds within a provider; `embedding.providerId`, when set, must reference an existing provider id.

### 1.3 Module boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `src/lib/ai/provider-config.ts` (new, server-only) | Load/validate/save providers.json; read/write providers.secrets.env; resolve API keys; run migration; serve sanitized registry views | Zod, fs/promises |
| `src/lib/ai/provider.ts` (refactor) | Build SDK providers from registry entries; `chatModel(modelId, entry)`; default-model resolution from registry | provider-config |
| `src/lib/ai/capability-detection/` (new) | Layered detection pipeline (see §4) | provider-config (for baseUrl/key), models.dev client, probe runners |
| `src/app/api/providers/*` (new routes) | Registry CRUD + model CRUD + detection endpoint | provider-config |
| `src/lib/settings.ts` (refactor) | Client cache of the registry view (no secrets), same event contract | /api/providers responses |
| `src/hooks/use-registered-models.ts` (new) | Selector data: registry models only | settings cache |

`src/lib/ai/models.ts` (`listModels`) is repurposed as the *catalog browse* call used by capability detection and "Validate & add" — no longer the selector's data source.

## 2. Data flow

### 2.1 Model selector (curated only)

1. `GET /api/providers` returns the registry view: all providers with their curated models, keys reduced to `apiKeyConfigured: boolean` (+ the env var name, for display).
2. `useProviderModels` is replaced by `useRegisteredModels` — no per-provider `/models` fetching, no "Unreachable" group states.
3. Selector groups by provider; items show `displayName`; the context indicator reads stored `capabilities` from the entry — no fetch per message.

### 2.2 Chat request

1. Client sends `{ messages, model: "abc123::gpt-4o" }` — no `provider` override block, no keys, ever.
2. Chat route resolves the ref → registry entry → `getProvider(entry)` with the server-side resolved key → `llm.chatModel(modelId)`.
3. Invalid/stale ref (provider or model deleted) → 4xx error naming the missing entity; UI falls back to the registry default model with a toast.
4. `sanitizeProviderOverrides` and `ChatRequestProvider` are removed. Subagent delegation resolves providers via the same registry path — no override threading.

### 2.3 Settings writes

1. UI action → `PUT /api/providers` (provider CRUD) / model sub-resources — validated by the same Zod schema (SSoT for validation too).
2. Server persists providers.json atomically (write-temp + rename). If an API key was submitted: write/update the `PROVIDER_<ID>_API_KEY` line in providers.secrets.env; never log it; redact from error messages.
3. Response carries the updated registry view; client refreshes cache and dispatches `PROVIDERS_CHANGED_EVENT` (name unchanged).

Env var names are derived deterministically from the provider id: `PROVIDER_<ID_UPPER>_API_KEY`. **Precedence is two independent axes — do not conflate them:**

- **Config fields** (baseUrl, kind, models, embedding settings): the JSON value in `providers.json` is authoritative, always. `LLM_*` env vars are migration seeds, consulted once at first boot, never again.
- **Secret values** (API keys): resolution checks `process.env[apiKeyEnv]` first, then `data/providers.secrets.env`. This lets a deployment override a UI-entered key via real env vars without the app touching hand-managed files.

So a user may pre-set `PROVIDER_X_API_KEY` in their own `.env.local` and it wins for that secret — but editing a provider's `baseUrl` in the UI always wins over any env var.

### 2.4 Migration (auto, idempotent, on boot)

Runs inside provider-config's first load when `data/providers.json` is absent:

1. Seed the `server` entry (id `"server"`, `source: "env"`) from `LLM_BASE_URL` / `LLM_MODEL_ID` / `LLM_API_KEY`. Copy `LLM_API_KEY`'s value into providers.secrets.env under `PROVIDER_SERVER_API_KEY` (only if that var is not already set in process.env or the secrets file). Seed `LLM_MODEL_ID` as the server entry's first model (displayName = modelId, capabilities left unknown/null for later detection).
2. Read SQLite `settings.providers` (old store); append each entry to providers.json, rewriting its `apiKey` into providers.secrets.env under the derived name and dropping the plaintext field.
3. Migrate the `settings.embedding` block into the top-level `embedding` key with `apiKeyEnv` indirection; delete the old SQLite keys.
4. Preserve ids exactly — existing `"server::modelId"` refs in localStorage and DB rows keep resolving.
5. Idempotent: if providers.json exists, migration is a no-op. Safe under dev double-boot/Strict Mode. Logs each migration step with counts (never values).
6. If neither env vars nor SQLite providers exist, create providers.json with an empty `providers: []` and a UI-visible onboarding hint ("Add your first provider").

## 3. Security model

- **No key values in any API response.** Per provider: `apiKeyConfigured: boolean` + `apiKeyEnv` name. `GET /api/settings`'s `ai` block is removed along with its env-derived key boolean.
- **Keys are write-only in the UI.** Edit dialog shows an empty key field; empty on save = unchanged; typed = update (secrets file); explicit "clear key" action removes the line and flips the boolean.
- **Chat carries no keys.** The `provider` override field is removed from `ChatRequestProvider` / chat request handling and from the `/api/providers/models` validation proxy (which now runs server-side with resolved keys).
- Secrets file: git-ignored (via existing `data/` rule), chmod 600, never logged, no values in errors. Zod-strip rather than reject on any accidental extra fields in API payloads (OWASP A08).
- Provider base URLs are validated as `https?://` and length-capped (as today, 2048) at the Zod boundary (fail fast).
- **SSRF posture** (verified against the codebase): the existing provider routes (`/api/providers/models`, `/api/models`, `/api/ollama`) use **no SSRF guard** — deliberately, because `src/lib/security/ssrf.ts` (`assertSafeUrl`) blocks loopback/private IPs, which would break the first-class localhost Ollama/vLLM use cases. The new detection surfaces inherit exactly this posture: **no `secureFetch`/`assertSafeUrl` on provider baseUrls** (localhost must work), probing runs server-side only. Mitigations for the raised trigger frequency: (a) detection targets are limited to URLs the user explicitly configured as providers — not arbitrary strings — since baseUrl comes from the registry, not the request body; (b) the 1-probing-run-per-60s-per-modelId cap (§4) bounds the rate; (c) probe payload ≤ a few KB, 8s timeout. Any future provider-registration flow that accepts a baseUrl over the network is the point where stricter SSRF rules (private-IP opt-in allowlist for local runtimes) should be revisited — noted, out of scope here.

## 4. Capability detection pipeline

**Trigger:** auto-detect as the user types modelId — debounced 600ms after the input settles, only when the field is non-empty and shaped like an id. Manual "Re-detect" button on the model edit form; background refresh is NOT in scope (sticky overrides make a future refresh safe).

**Policy:** metadata first, probe fallback. Each detection **run** is one debounce-settle firing (or one manual re-detect click) for one modelId. A run may spend ≤3 live probes, each with an 8s timeout, against the provider's own baseUrl. Runs are additionally capped **per modelId while unsaved: 1 probing run per 60 seconds** — pausing three times while typing the same id does not buy three probe rounds. A cached result for the same modelId is returned without re-probing; only a modelId *change* or an explicit "Re-detect" opens a fresh budget. Per-modelId results persist in the registry entry once saved.

### Layer 1 — models.dev catalog (free, instant)

- Fetch `https://models.dev/api.json`, cache 24h on disk (`data/cache/models-dev.json`, stale-while-revalidate; on fetch failure use stale cache if present).
- **Matching, in order of strictness — a wrong match is worse than no match:**
  1. Exact id match (case-sensitive) — trusted, provenance `models.dev`.
  2. Case-insensitive exact id — trusted, provenance `models.dev`.
  3. Normalized match: strip well-known provider qualifier prefixes (`openai/`, `anthropic/`, `google/`, `meta/`, `qwen/`, `zhipuai/`, `xai/`, `mistral/`, plus date-ish suffixes like `-20xx`) — applied only when the stripped id *exactly* equals a catalog id. **Single candidate or no match — never a fuzzy/similarity match.** A normalized hit is marked lower-confidence (`provider-metadata`) and the UI shows the matched catalog id so the user can see and veto what it resolved to.
- Fills: contextWindow, maxOutputTokens, input/output modalities, tool-call, reasoning. Fuzzy guessing is excluded by construction; unresolved ids stay unknown.

### Layer 2 — provider metadata (free, one request)

- OpenAI-compatible: `GET {baseUrl}/models` — parse `context_length` / `max_completion_tokens` / `capabilities.contextWindow` / `capabilities.maxOutput` (the existing `listModels()` parsing).
- Ollama: `POST {baseUrl}/api/show` for the specific model → capabilities list.
- Provider-served limits override Layer 1 limits (a provider may cap context below the model's native max). Fills only fields Layer 1 left null.

### Layer 3 — live probe (cost-capped, ambiguity-only)

Only for fields still null after 1+2:

- **Modality probes:** tiny 1x1 PNG (~100 bytes) with `max_tokens: 1` for image; a ~0.1s silent audio clip for audio; a 1-frame tiny video for video. A successful response proves support; an explicit "modality not supported" error class proves lack (error-message classification, like the cybercode probe pattern). Non-modality errors (auth, rate limit, 5xx) leave the field unknown — never inferred.
- **Token limits are never probed by sampling** — they cannot be measured accurately by probing. If layers 1+2 miss them, they stay `null` (unknown, user-settable).
- Probe requests use the provider's own credentials and the minimum viable payload.

### Accuracy semantics

- Every detected capability field records provenance in `capabilitySources[field]` (`models.dev` | `provider-metadata` | `live-probe` | `user`).
- UI shows a confidence chip per detected field (e.g. "context: 400k · from provider", "image: yes · probed").
- **User overrides always win** — any field the user edited is marked `source: "user"` and is never overwritten by detection or future refreshes.
- Fields that no layer can confirm show as "unknown — set manually" — honest unknowns, never guesses.

## 5. UI changes

### 5.1 Providers tab

- The "This server / Built-in" card is **removed**. The env-seeded `server` entry renders as a normal provider card (editable, deletable like all others).
- **Edit button added** to every provider card (pencil icon alongside the existing delete).
- Provider edit dialog (same one used for add, prefilled): name, kind, baseUrl, write-only API key field.
- Per-provider **models list** (in the edit dialog or expandable card section): each row shows displayName, modelId, capability chips (context/output numbers; icons for image/audio/video/tool/reasoning), capability-source badge, edit + delete per model.
- **Add model form:** modelId input (auto-detection fires debounced as you type), displayName input, detected-capabilities panel with per-field confidence chips, override inputs before save.
- "Validate & add" pre-save connection test stays (it becomes a `GET {baseUrl}/models` browse under the hood).

### 5.2 Chat model selector

- Groups = providers; items = curated models; label = `displayName`.
- Context indicator reads stored capabilities — no per-message fetch.
- Empty state per provider: "No models added — add one in Settings → Providers."
- The "Unreachable — check the provider in Settings" state is removed (obsolete under curated models).

### 5.3 Default model

- At most one model across the registry carries `isDefault: true` (enforced by the registry-level `.refine()`; shown as "(default)" in the selector). If none is flagged, the first model of the first provider is the effective default. Setting a new default **auto-clears the previous flag** (the write handler demotes the old default in the same atomic save) — it never rejects the write or produces two defaults.
- No stored ref / stale ref → UI falls back to the effective default model.
- First model added to an empty registry becomes default automatically.

### 5.4 Embedding tab

- "Server" option becomes a reference to the `server` registry entry (`providerId`); Ollama / custom options use a standalone endpoint (`providerId: null` + inline baseUrl/key with `apiKeyEnv` indirection). Key field write-only. Dimension auto-probe flow unchanged.

## 6. Error handling & edge cases

- **Corrupt/invalid providers.json at boot** → fail fast with a named `ProviderConfigError` naming the file path + Zod issue. No silent empty-registry operation.
- **Secrets missing/invalid** → provider loads with `apiKeyConfigured: false`; chat through it fails with "API key not set for <name> (PROVIDER_X_API_KEY)" — never a generic 500.
- **Detection layer failures are isolated:** Layer 1 offline → 2 → 3 proceed; a probe error = that field unknown, not a failed detection run. models.dev unreachable with no cache → Layer 1 skipped silently-but-logged.
- **File write races:** atomic write (temp + rename); the config service is the single server-side writer.
- **Provider deleted while chats reference its models** → refs resolve at chat time to a clear error + UI fallback to default.
- **`source: "env"` entries:** fully editable in the UI; after save the JSON value wins. `LLM_*` env vars matter only on first boot (seed). Document this in `.env.example`.
- **Secrets file absent** → treated as empty (keys simply unconfigured).
- **Registry with zero providers** → onboarding hint; chat composer disabled with an explanatory message.

## 7. Testing

Vitest, per the OOM-safe worker config; single-file targeted runs in subagents (`vitest run <file> --maxWorkers=1`).

| Area | Coverage |
|---|---|
| `provider-config.ts` | Zod validation (valid/invalid fixtures); atomic write; secret resolution precedence (process.env > secrets file); migration idempotency + seed paths; corrupt-file fail-fast; chmod 600 |
| capability pipeline | Layer precedence/merge with each layer mocked; probe fallback fires only on ambiguity; budget cap (≤3 probes); timeout handling; error-classification (non-modality errors → unknown); user-override stickiness; models.dev cache stale-while-revalidate |
| settings/providers API routes | key redaction in every response; write-only key update (empty = unchanged); clear-key; provider CRUD; model CRUD; default-model invariant (at most one `isDefault`, enforced by registry-level `.refine()`; setting a new default demotes the old one) |
| chat route | ref resolution; stale-ref error; no keys in request/response bodies |
| UI | Providers tab renders registry; edit dialog prefills; model add with mocked detection; selector shows only curated models; default fallback |

## 8. Out of scope

- Background/periodic capability re-detection (design keeps overrides sticky so this can be added later without data migration).
- Multi-tenancy, per-user provider registries.
- Custom (non models.dev) catalog sources.
- Changing the tool/MCP/subagent systems beyond routing their provider resolution through the registry.
