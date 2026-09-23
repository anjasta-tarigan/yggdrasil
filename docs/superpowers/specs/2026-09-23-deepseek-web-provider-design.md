# DeepSeek Web Provider (Experimental) — Design

**Date:** 2026-09-23
**Status:** Draft for review
**Scope:** Experimental DeepSeek Chat Web session provider, structured session import, session validation, model discovery, normal chat integration, and experimental UX

## 1. Summary

Yggdrasil currently supports provider entries of kind `openai-compatible` and `ollama`. Credentials are API-key references resolved on the server. The normal chat route resolves a qualified model reference such as `providerId::modelId`, builds an AI SDK provider, and never accepts credentials from the browser.

This design adds a separate experimental provider for the DeepSeek consumer web interface. It is not a DeepSeek API integration and must not be represented as an ordinary OpenAI-compatible provider. The provider uses an explicitly imported web-session credential, a dedicated adapter, a fixed upstream policy, and a separate encrypted session store.

The first release is intentionally narrow:

- manual structured session import;
- explicit connection checking before save;
- server-side encrypted session storage;
- automatic, read-only browser `User-Agent` capture as request metadata;
- one dedicated DeepSeek Web adapter;
- manual model discovery through the saved session;
- persistence of discovered models in the existing provider registry;
- normal chat only;
- an always-visible experimental warning;
- an English contextual help panel.

It does not include silent browser credential extraction, browser-profile or HAR upload, password collection, embedded-browser cookie scraping, CAPTCHA/WAF/proof-of-work/fingerprint bypass, automatic cookie refresh, project-harness support, or silent provider fallback.

The exact DeepSeek Web endpoint, request shape, credential format, and stream format are not present in the current Yggdrasil repository and are not established by the official DeepSeek API documentation. A protocol spike is therefore a release gate. No production adapter implementation may guess these values.

## 2. Verified context and evidence

### 2.1 Yggdrasil

The following facts were verified in the current repository:

- `src/lib/ai/provider-config/schema.ts` defines `ProviderEntrySchema` with only `openai-compatible` and `ollama` kinds. It requires a user-configurable HTTP(S) `baseUrl` and models with complete capability fields.
- `src/lib/ai/provider-config/store.ts` loads and atomically writes `data/providers.json`, resolves API keys from process environment or `data/providers.secrets.env`, and returns redacted provider views.
- `src/lib/ai/provider-config/api-helpers.ts` handles write-only API-key fields, validates the full candidate registry, serializes writes only within the current process, and rolls back staged secrets when the registry write fails.
- `src/lib/ai/provider.ts` always constructs an OpenAI-compatible AI SDK provider. `src/lib/ai/provider-fetch.ts` injects a Bearer API key and guards the configured endpoint; it has no cookie or web-session transport.
- `src/app/api/providers/models/route.ts` accepts a client-supplied `baseUrl`, API key, and provider kind, then delegates to generic `/models` or `/api/tags` browsing. It is not suitable for a fixed web-session adapter.
- `src/lib/ai/models.ts` caches generic model browsing by provider kind and URL, collapses several upstream failures into stale or empty results, and does not persist discovered model IDs.
- `src/app/api/chat/route.ts` resolves models from the provider registry and uses `chatModelForEntry`. `src/app/api/projects/chat/route.ts` has a similar model-resolution path.
- `src/hooks/use-registered-models.ts` and the chat selectors use persisted provider models. A discovered model is not usable until it is written to the provider registry.
- `src/components/settings/tabs.tsx`, `src/components/settings-view.tsx`, and `src/components/settings/nim-provider-dialog.tsx` provide the existing provider settings UI. None supports web-session credentials, a separate check/save flow, an experimental banner, or a contextual help panel.
- `src/lib/security/encryption.ts` provides AES-256-GCM envelopes derived from `APP_SECRET`. Production already requires `APP_SECRET`; the Web Provider must additionally refuse to enable itself when the key is absent in any environment.
- `src/app/api/projects/guard.ts` provides a project API guard, but provider/settings routes do not currently use an equivalent shared management guard. The Web Provider routes must not rely on `Host: localhost` or loopback binding alone.

### 2.2 OmniRoute research

Current OmniRoute source and documentation show several credential onboarding patterns that informed this design:

- Browser OAuth and device-code flows for providers that support them.
- Explicit import-token flows.
- Local credential-file or keychain import for supported applications.
- Structured web-session credential requirements that distinguish token credentials from cookie credentials.
- Provider-specific model and executor behavior.

Relevant source and documentation reviewed:

- `src/shared/components/OAuthModal.tsx`
- `src/shared/providers/webSessionCredentials.ts`
- `src/app/api/oauth/[provider]/[action]/route.ts`
- `src/app/(dashboard)/dashboard/providers/[id]/components/WebSessionCredentialGuide.tsx`
- `src/app/(dashboard)/dashboard/providers/[id]/components/HarImportButton.tsx`
- `docs/reference/PROVIDER_REFERENCE.md`
- `docs/ARCHITECTURE.md`

These patterns demonstrate provider-specific onboarding, but they do not establish a supported DeepSeek Web contract for Yggdrasil. OmniRoute's reverse-engineered provider adapters and historical issue/PR discussions are evidence for design patterns, not permission to copy an undocumented private protocol or bypass provider controls.

### 2.3 DeepSeek evidence boundary

The official DeepSeek API documents a separate OpenAI-compatible API using API keys and `https://api.deepseek.com`. That API is outside this feature. Consumer web access does not establish a reusable API credential or an unlimited free programmatic quota.

Third-party projects claim that DeepSeek Web uses session material, private endpoints, anti-abuse controls, and provider-specific streaming. Those claims are not treated as a stable contract. The protocol spike must verify every request and response field against the current provider behavior and must stop if successful operation requires bypassing a security control.

## 3. Goals and non-goals

### 3.1 Goals

1. Add a clearly separated `DeepSeek Web (experimental)` provider.
2. Let a user explicitly import a structured web-session credential.
3. Check the credential before saving it and re-check it during save.
4. Store session material encrypted on the configured Yggdrasil server.
5. Capture the current browser's User-Agent only through an explicit UI choice.
6. Use a dedicated adapter for request construction, streaming, errors, and model discovery.
7. Discover models manually and persist valid results in the existing provider registry.
8. Keep chat credentials out of browser state, logs, URLs, traces, and workflow state.
9. Make the feature easy to disable without affecting standard providers.
10. Keep all user-facing UI text in English.

### 3.2 Non-goals

- DeepSeek API integration.
- A universal web-provider or cookie framework.
- Silent browser cookie or localStorage extraction.
- Browser-profile, HAR, or cookie-jar upload.
- Password collection or login automation.
- CAPTCHA, WAF, proof-of-work, rate-limit, or fingerprint bypass.
- Automatic refresh or rotation of undocumented web cookies/session tokens.
- A guarantee of free, unlimited, or uninterrupted access.
- Project-harness, background-job, tool-call, attachment, image, audio, or video support.
- Automatic provider fallback.
- Automatic selection of a Web Provider as the default model.

## 4. Architecture

### 4.1 Provider classification

Add an explicit provider discriminator rather than overloading `openai-compatible`:

```text
kind: "web-session"
preset: "deepseek-web"
transport: "web-session"
experimental: true
```

The exact persisted shape must be represented by a Zod discriminated union or equivalent explicit schema branch. A Web Provider must not require a user-editable `baseUrl`. The fixed endpoint belongs to the adapter and is validated in the adapter configuration.

Existing provider kinds retain their current behavior:

```text
openai-compatible
ollama
```

NVIDIA NIM continues using its existing OpenAI-compatible preset.

### 4.2 Module boundaries

| Unit | Responsibility |
|---|---|
| `src/lib/ai/web-provider/adapter.ts` | Provider-neutral Web Provider contract, normalized results, typed failures |
| `src/lib/ai/web-provider/deepseek.ts` | DeepSeek-specific credential validation, fixed endpoints, request/stream parsing, model discovery |
| `src/lib/ai/web-provider/session-store.ts` | Encrypted session payloads and lifecycle metadata; server-only |
| `src/lib/ai/web-provider/discovery.ts` | Bounded discovery cache, request coalescing, stale-result protection, registry upsert orchestration |
| `src/lib/ai/provider.ts` | Dispatch provider construction to API or Web Provider transport |
| `src/lib/ai/provider-config/schema.ts` | Validate explicit Web Provider metadata and existing model entries |
| `src/app/api/web-providers/route.ts` | Redacted Web Provider catalog and status |
| `src/app/api/web-providers/deepseek/session/*` | Check, save, revalidate, and delete session routes |
| `src/app/api/web-providers/deepseek/models/discover/route.ts` | Manual model discovery route |
| `src/components/settings/deepseek-web-provider-dialog.tsx` | Structured credential form, User-Agent selection, check/save flow |
| `src/components/settings/web-provider-help-panel.tsx` | Contextual right-side help content |
| `src/components/settings/experimental-provider-banner.tsx` | Shared experimental warning for provider card, form, and model context |

The names above describe the intended boundaries. Exact filenames may change during the implementation plan if the repository's existing component organization provides a better location.

### 4.3 Session storage

Session metadata and encrypted credential payload use a dedicated SQLite table rather than `providers.json` or `providers.secrets.env`. The table is conceptually:

```text
web_provider_sessions
  id                    primary key
  provider_id           fixed provider id
  encrypted_payload     AES-256-GCM envelope
  status                not-configured | verified | expired | rejected | rate-limited | degraded
  last_checked_at       nullable timestamp
  last_failure_code     nullable safe error code
  user_agent_mode       browser | server-default | custom
  captured_at           nullable timestamp
  session_version       monotonic integer
  created_at             timestamp
  updated_at             timestamp
```

The encrypted payload contains only the fields needed by the adapter:

```text
{
  version: 1,
  userToken: "...",
  selectedUserAgent: "..."
}
```

The payload is encrypted with the existing AES-256-GCM primitive and a validated `APP_SECRET`. The Web Provider feature is disabled if `APP_SECRET` is absent, including development and test environments that exercise the feature. Tests provide an explicit test secret through the existing environment validation path.

The session token and selected User-Agent must not appear in:

- `data/providers.json`;
- `data/providers.secrets.env`;
- browser settings cache;
- `localStorage` or `sessionStorage`;
- chat request bodies or saved messages;
- durable workflow state or retry payloads;
- logs, traces, metrics, URLs, screenshots, or error responses.

A missing or undecryptable payload marks the session unavailable and requires re-import. It must not fall back to plaintext or silently use an empty credential.

Session replacement increments `session_version`, invalidates discovery cache entries for older versions, and replaces the encrypted payload and metadata in one SQLite transaction. Delete removes the payload and all related metadata. Delete does not log the user out of DeepSeek because Yggdrasil does not control the provider session.

### 4.4 Registry and model storage

`data/providers.json` remains the source of provider metadata and curated models. A DeepSeek Web provider entry contains no secret and no session token. Its `models` array uses the existing `ModelEntry` shape.

The session store and provider registry have separate responsibilities:

```text
web_provider_sessions  → encrypted credential + session lifecycle
providers.json          → provider metadata + curated model list
```

This allows existing `deepseek-web::model-id` resolution to work without introducing a second model resolver.

## 5. Credential onboarding

### 5.1 Form fields

The first pilot declares one required secret field:

```text
Internal id: userToken
Label: Web session token
Type: password input
Required: true
```

The first pilot does not accept a full Cookie header. A later adapter revision may declare a specifically named cookie field only if protocol verification proves it is required. It must never accept an unfiltered cookie bundle.

The server parser:

- trims surrounding whitespace;
- accepts the raw token or the explicitly supported `userToken=` form;
- rejects empty values;
- rejects CR, LF, and control characters;
- enforces a maximum length;
- rejects JSON, HAR, browser profiles, unknown credential fields, and arbitrary headers;
- never echoes the normalized token.

### 5.2 Request identity

The form presents:

```text
Request identity
○ Use this browser's User-Agent
○ Use Yggdrasil's default User-Agent
○ Use a custom User-Agent (Advanced)
```

The browser option reads `navigator.userAgent` only in a client component. It displays the value read-only and sends it only when the user presses `Check connection`. The value is not an authentication credential.

The selected value is stored encrypted with the session when the adapter requires it. The stored value is not returned in the redacted provider view. Opening the form from another browser never replaces it automatically.

User-Agent precedence is explicit:

1. saved custom value;
2. saved browser-captured value;
3. server default.

The adapter must apply the chosen value only to DeepSeek Web requests. It must not change the server-wide User-Agent or forward it to other providers. A matching User-Agent does not bypass IP, TLS, device, WAF, or account binding.

### 5.3 Check and save

The actions are separate:

```text
Check connection
Save provider
```

`Check connection` is side-effect-free. It parses the candidate, calls the fixed adapter, and returns only a safe status.

`Save provider` performs the same validation again on the server. The client cannot submit a `verified: true` assertion to skip validation. The save transaction begins only after the second check succeeds.

A failed check preserves the in-memory draft and displays:

```text
The session was rejected. Your credentials were not saved.
```

A successful save displays:

```text
Connection verified.
```

After a successful save, the component clears the secret from local state. A failed save leaves the unsaved draft in the open form but never persists it across reloads.

## 6. Management API

The existing provider API remains for standard providers. Web Provider routes use a dedicated surface:

```text
GET    /api/web-providers
POST   /api/web-providers/deepseek/session/check
POST   /api/web-providers/deepseek/session
POST   /api/web-providers/deepseek/session/revalidate
DELETE /api/web-providers/deepseek/session
POST   /api/web-providers/deepseek/models/discover
```

### 6.1 Request boundary

All mutating routes must use a shared local-management guard with these rules:

- loopback binding remains the default operational mode;
- browser mutations require a matching configured application `Origin`;
- if `Origin` is absent, a matching `Referer` is required;
- missing or mismatched browser origin headers are rejected;
- non-browser remote management requires `Authorization: Bearer APP_SECRET`;
- `Host`, `X-Forwarded-For`, and `X-Forwarded-Host` are not proof of loopback access;
- forwarded headers are trusted only when an explicit trusted-proxy configuration exists;
- JSON mutations require `Content-Type: application/json`;
- request bodies are read with a hard byte limit, including chunked requests;
- route timeouts and rate limits are enforced;
- responses use stable safe error codes.

The existing project guard may inform the shared implementation, but the Web Provider routes must not inherit a header-derived loopback bypass.

### 6.2 `GET /api/web-providers`

Returns a redacted catalog and status:

```json
{
  "providers": [
    {
      "id": "deepseek-web",
      "name": "DeepSeek Web",
      "experimental": true,
      "enabled": true,
      "models": [],
      "session": {
        "status": "not-configured",
        "lastCheckedAt": null,
        "userAgentMode": null,
        "capturedAt": null
      }
    }
  ]
}
```

It never returns session tokens, credential references, cookie values, User-Agent values, upstream bodies, or raw errors.

### 6.3 `POST /api/web-providers/deepseek/session/check`

Request:

```json
{
  "userToken": "...",
  "userAgentMode": "browser",
  "userAgent": "Mozilla/5.0 ..."
}
```

Only declared fields are accepted. `baseUrl`, `endpoint`, `headers`, `cookies`, `cookieHeader`, `refreshToken`, `har`, and profile fields are rejected. The body and individual values are length-capped.

The route does not write the registry, session store, chat data, or discovery cache. It sends one bounded adapter validation request and returns:

```json
{ "ok": true, "provider": "deepseek-web", "status": "verified" }
```

or a safe error:

```json
{
  "ok": false,
  "code": "session_rejected",
  "message": "The session was rejected. Your credentials were not saved."
}
```

Allowed error codes:

```text
invalid_request
session_rejected
rate_limited
unsupported_protocol
upstream_timeout
network_error
feature_disabled
```

No upstream response body, `Set-Cookie`, authorization value, token-like text, or stack trace is returned.

### 6.4 `POST /api/web-providers/deepseek/session`

The route parses the candidate, revalidates it with the adapter, encrypts the payload, and commits session metadata in one database transaction. Upstream failure leaves all prior state unchanged.

The response contains only redacted status:

```json
{
  "ok": true,
  "provider": "deepseek-web",
  "status": "verified",
  "lastCheckedAt": "2026-09-23T..."
}
```

### 6.5 Revalidation and deletion

`POST /api/web-providers/deepseek/session/revalidate` loads the encrypted server-side session, calls the adapter, and updates only safe status metadata. It does not obtain a new token or extend an undocumented cookie.

`DELETE /api/web-providers/deepseek/session` deletes encrypted payload and metadata. It returns no credential material.

### 6.6 Model discovery

`POST /api/web-providers/deepseek/models/discover` accepts only:

```json
{ "force": false }
```

The route loads the verified server-side session. The client does not send the token, cookie, endpoint, upstream headers, or raw User-Agent value.

The route invokes the adapter's `discoverModels()` capability, normalizes the response, merges valid models into the existing DeepSeek Web provider entry, validates the complete registry, and atomically saves the registry. It returns normalized model records and cache status, never raw upstream data.

## 7. Adapter contract

The provider-neutral adapter must expose equivalent capabilities to:

```text
validateSession(candidate, requestIdentity, signal)
discoverModels(session, requestIdentity, signal)
createTextStream(session, requestIdentity, request, signal)
classifyFailure(responseOrError)
```

The DeepSeek adapter owns:

- fixed HTTPS origin and paths;
- request construction;
- credential injection;
- selected User-Agent application;
- response parsing;
- streaming frame parsing;
- cancellation and timeout behavior;
- session, rate-limit, protocol, and network error classification;
- model discovery normalization.

The generic OpenAI-compatible factory, `/api/providers/models`, and user-configured base URL transport must not be used by this adapter.

### 7.1 Fixed upstream policy

The adapter uses only endpoints verified by the protocol spike. It does not accept an endpoint from the request, registry, or Settings UI.

Default policy:

- HTTPS only;
- `redirect: "error"`;
- no incoming browser cookies forwarded;
- no arbitrary client headers forwarded;
- no upstream `Set-Cookie` returned to the browser;
- no private, loopback, metadata, or arbitrary URL targets;
- no generic DNS-check-then-fetch flow for credential-bearing requests;
- no request after a session has been marked rejected until explicit re-import/revalidation.

If a redirect is proven necessary, it must be revalidated against the same fixed-origin allowlist at every hop and must never carry sensitive headers to an unapproved target.

### 7.2 Chat support

The first adapter release supports only verified text streaming and cancellation. Tools, attachments, multimodal inputs, arbitrary provider parameters, and reasoning-specific fields remain disabled until separate fixtures and tests prove them.

The adapter converts upstream frames to the existing Yggdrasil UI stream format. It does not pass raw provider frames to the client. A malformed frame terminates the stream with a typed protocol error; it is not silently discarded.

Retry policy:

- at most one bounded network retry before any content is emitted;
- no retry after `401` or `403`;
- `401`/`403` marks the session expired or rejected;
- `429` marks the session rate-limited and respects cooldown;
- timeouts and network errors may be explicitly retried by the user;
- no retry with a different session or silent provider fallback.

### 7.3 Session status

The adapter maps failures to:

```text
verified
expired
rejected
rate-limited
degraded
unsupported
```

A session status is updated only by a server operation. Client-provided status is never trusted.

There is no automatic cookie/session refresh. Re-authentication means explicit **Re-import session** or a provider-supported flow added in a later design.

## 8. Model auto-discovery

### 8.1 Timing and UI

After a successful save, the UI performs one discovery request. It does not poll on render or at a fixed background interval.

The provider dialog shows:

```text
Models
[Discover models]
[Add model manually]
```

States:

```text
Discover models
Discovering models…
4 models discovered
Last discovered just now
Refresh models
Last known list
```

The UI preserves the last known list when refresh fails and clearly labels it stale.

### 8.2 Protocol gate

The protocol spike must verify a current model discovery endpoint and payload. If no stable, permitted endpoint exists, automatic discovery is disabled and the UI shows:

```text
Automatic model discovery is unavailable for this provider.
```

Manual model entry remains available.

### 8.3 Normalization

The adapter converts provider records into the existing `ModelEntry` shape:

- non-empty `modelId`, capped length;
- normalized display name;
- deterministic first-seen deduplication;
- unsupported model families filtered;
- maximum 200 models;
- unknown numeric and capability values remain `null`;
- text input/output defaults are explicit;
- discovery never sets `isDefault: true`;
- capability provenance is `provider-metadata` only for values actually supplied by the provider.

### 8.4 Merge rules

Discovery writes into `ProviderEntry.models`:

- new valid models are added;
- existing models retain user capability overrides;
- existing `isDefault` values are preserved;
- empty, malformed, unsupported-only, 401, 403, and 429 results do not clear existing models;
- a successful empty catalog is distinguishable from a failed request and is a no-op for persistence;
- models become selectable only after the registry write succeeds.

### 8.5 Cache and concurrency

Cache entries contain normalized model candidates and safe metadata only. They do not contain raw response bodies or credential values.

Cache key:

```text
providerId + sessionId + sessionVersion + adapterVersion
```

Policy:

- successful result TTL: 15 minutes;
- explicit refresh may bypass TTL but obeys a per-session cooldown;
- cache size is bounded;
- one active request is coalesced per cache key;
- session replacement invalidates older entries;
- `401`, `403`, and `429` never become successful model-list cache entries;
- stale last-known data is used only under the explicit stale-if-error policy;
- a newer discovery result cannot be overwritten by an older in-flight response.

Registry upsert uses a durable lock or optimistic version check. A module-level Promise queue is insufficient for multiple workers or processes.

## 9. Chat and model resolution

The browser sends only:

```json
{ "model": "deepseek-web::model-id" }
```

The server:

1. resolves the qualified model reference;
2. checks the feature flag;
3. checks the provider model exists in the registry;
4. checks the session is verified;
5. decrypts the session immediately before the upstream call;
6. invokes the dedicated adapter;
7. normalizes the stream;
8. releases sensitive local references after completion.

The credential never enters `ChatUIMessage`, persisted chat content, retry state, project workflow payloads, or telemetry.

The normal chat route is supported after integration tests pass. Project-harness chat is explicitly rejected in the MVP because its durable model path currently serializes provider initialization fields. The server must enforce this even if the UI hides the model.

Error copy:

```text
DeepSeek Web is not available in project chat.
```

A Web Provider cannot become the default model automatically. `Use default provider` is an explicit user action after a Web Provider failure.

## 10. UI information architecture

### 10.1 Provider entry

The Providers page lists Web Providers separately from API providers:

```text
Providers
  Ollama
  OpenAI-Compatible
  NVIDIA NIM

Experimental Web Providers
  DeepSeek Web (experimental)
```

Card states:

```text
DeepSeek Web
Experimental Web Provider
Session: Not configured
Models: 0
[Configure]
```

and:

```text
DeepSeek Web
Experimental Web Provider
Session: Verified
Models: 4
Last checked just now
[Manage session]
```

### 10.2 Banner

Persistent banner copy:

```text
Experimental: DeepSeek Web uses the web interface, not the official API.
It may stop working when DeepSeek changes its web client. Use an account you
control. Credentials and request identity are sent to the configured Yggdrasil
server.
```

Limitations copy:

```text
This integration is unofficial and may be affected by session expiry, device
binding, rate limits, security checks, or provider changes.

Yggdrasil does not collect browser credentials automatically, upload browser
profiles, or bypass provider security controls. Session credentials cannot be
refreshed automatically.
```

The banner is server-derived from provider metadata and remains visible after refresh. A dismissal preference may hide only the expanded details for the current browser; it must not remove the experimental label or alter the safety behavior.

### 10.3 Help panel

Desktop uses a right-side `<aside>` that opens without resetting the form. At narrow widths it becomes a disclosure below the form:

```text
Need help?
```

Field help is contextual. Example:

```text
How to get your session token

Use a session credential from your own DeepSeek Web account. Follow the
provider's documented export or account instructions when available. Paste
only the value requested by this form.

Do not share it in screenshots, issue reports, chat messages, or logs.
Yggdrasil does not read your browser or collect credentials automatically.
```

The final provider-specific acquisition steps must be filled only from the protocol spike's verified, permitted flow. The help panel must not provide instructions for silent extraction, password capture, profile export, or security-control bypass.

Accessibility requirements:

- keyboard navigation and visible focus;
- `aria-invalid` and `aria-describedby` for fields;
- `aria-live="polite"` for connection/model status;
- `role="alert"` for submit errors;
- no color-only status distinction;
- minimum 44px interactive targets;
- no horizontal scroll at 360px;
- two-column layout only when the panel and form have sufficient width;
- stacked layout on smaller screens.

## 11. Migration, feature flag, and rollback

### 11.1 Migration

The migration creates the session table and registers fixed provider metadata without importing a credential. It must be idempotent and must not alter existing API provider secrets or model entries.

The existing provider registry version remains compatible for standard providers. If the Web Provider discriminator requires a registry version update, the migration must define an explicit version transformation and reject unsupported versions rather than silently stripping Web Provider fields.

### 11.2 Feature flag

Environment variable:

```text
YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS
```

Default: disabled.

When disabled:

- the UI does not offer a new session action;
- existing encrypted sessions are retained;
- Web Provider chat returns `feature_disabled`;
- model discovery is rejected;
- standard providers continue to work;
- no session secret is loaded unnecessarily.

### 11.3 Rollback

The kill switch is the feature flag. Disabling it must not delete sessions or mutate standard provider configuration. Re-enabling requires the normal verified-session check before chat.

A provider protocol failure triggers disablement when any of these occur:

- repeated protocol parse failures;
- unexpected credential-bearing redirects;
- upstream response includes a security challenge the adapter cannot support;
- secret redaction test fails;
- stale discovery results overwrite newer state;
- session data is written outside the encrypted store;
- account-impact or ToS concerns cannot be resolved.

## 12. Observability

Allowed structured events:

```text
web_provider.check.started
web_provider.check.succeeded
web_provider.check.failed
web_provider.session.saved
web_provider.session.deleted
web_provider.session.expired
web_provider.models.discovered
web_provider.models.discovery_failed
web_provider.request.failed
```

Allowed metadata:

```text
providerId
resultCode
latencyMs
httpStatusClass
streamStarted
modelCount
cacheState
```

Never log:

```text
userToken
Cookie
Authorization
User-Agent value
request body
response body
session reference
```

No raw upstream request/response dump is permitted for this adapter.

## 13. Protocol spike and release gates

### 13.1 Protocol spike deliverables

Before adapter implementation, the spike must produce local, redacted fixtures for:

```text
credential validation success
model discovery success
streaming text success
401
403
429 and Retry-After
login/expired-session response
malformed discovery payload
malformed stream frame
timeout
cancellation
```

Fixtures must not contain real tokens, cookies, account identifiers, or personal data. The spike must record the verified endpoint origin and path policy without embedding secrets.

### 13.2 Stop conditions

The pilot stops at research status if:

- the only working path requires silent browser extraction;
- the provider requires bypassing CAPTCHA, WAF, proof-of-work, rate limits, or fingerprint controls;
- the credential format cannot be safely isolated to the declared fields;
- the provider does not expose a stable, permitted model discovery path and manual fallback is insufficient;
- the session cannot be used without forwarding unrelated browser cookies;
- the provider's terms or behavior make the integration unsuitable for user-controlled accounts.

## 14. Test plan

All test runs follow the repository's memory-safe Vitest configuration and run sequentially when a targeted file is required. No subagent runs concurrent Vitest processes.

### 14.1 Session store

- AES-256-GCM envelope contains no plaintext token;
- missing `APP_SECRET` disables the feature;
- corrupt envelope returns a safe unavailable state;
- session replacement increments version and invalidates discovery cache;
- delete removes encrypted payload and metadata;
- redacted status never returns token or User-Agent;
- transaction rollback leaves prior state unchanged;
- concurrent update/delete cannot leave a dangling reference.

### 14.2 API boundary

- malformed JSON and oversized chunked bodies are rejected;
- unknown fields are rejected;
- empty, overlong, control-character, and multiline tokens are rejected;
- missing or mismatched Origin/Referer is rejected;
- `Host: localhost` does not bypass authentication;
- remote management requires the configured bearer secret;
- invalid content type is rejected;
- upstream bodies, headers, `Set-Cookie`, and credentials never appear in responses;
- check is side-effect-free;
- save revalidates and is atomic;
- delete and revalidate require the same management guard.

### 14.3 Adapter

- fixed origin/path dispatch;
- arbitrary endpoint and redirect targets are rejected;
- selected User-Agent precedence is correct;
- no incoming browser cookies are forwarded;
- successful response normalization;
- streaming frame normalization;
- malformed frame classification;
- timeout and cancellation cleanup;
- 401/403/429 classification;
- no authentication retry after rejection;
- no automatic refresh;
- no secret logging.

### 14.4 Model discovery

Fixtures:

```text
success.json
duplicate-and-unsupported.json
malformed-null.json
malformed-records.json
empty.json
unsupported-only.json
session-rejected.json
login-page.html
rate-limited.json
```

Tests:

- valid payload maps to `ModelEntry` candidates;
- duplicates are removed deterministically;
- unsupported records are filtered;
- malformed, empty, and unsupported-only responses preserve existing models;
- HTML login response is a session error, not an empty catalog;
- 401/403/429 never poison the successful cache;
- `Retry-After` is bounded and exposed only as safe metadata;
- fresh cache avoids a fetch;
- expired cache refetches;
- cache is bounded and keyed by session version;
- identical concurrent requests coalesce;
- an older response cannot overwrite a newer result;
- registry write failure leaves registry and cache unchanged;
- user capability overrides and default model remain unchanged;
- model references resolve only after persistence succeeds.

### 14.5 Chat integration

- `deepseek-web::model-id` resolves in normal chat;
- disabled feature is rejected server-side;
- missing or invalid session produces an actionable error;
- project-harness route rejects Web Provider models;
- standard providers remain unaffected;
- no credential enters chat messages, workflow state, or traces;
- stream cancellation releases the upstream response.

### 14.6 UI

- all visible copy is English;
- experimental banner appears on card, form, and model context;
- check and save are separate actions;
- failed checks preserve the draft;
- User-Agent is captured only in the browser and is read-only by default;
- switching browsers does not overwrite stored metadata automatically;
- contextual help opens on the right and becomes a mobile disclosure;
- focus and accessible descriptions work;
- duplicate checks/discovery requests are prevented;
- stale async results cannot overwrite newer form state;
- discovery failure preserves last known models and exposes manual entry;
- Web Provider is never selected as default automatically.

## 15. Acceptance criteria

The experimental release is acceptable only when:

1. DeepSeek Web is visibly separate from DeepSeek API and standard providers.
2. No session credential appears in registry JSON, secret API responses, browser storage, URLs, logs, traces, screenshots, or durable workflow state.
3. `Check connection` has no persistence side effect.
4. `Save provider` performs server-side revalidation and commits atomically.
5. The session store is encrypted and refuses to operate without `APP_SECRET`.
6. Web Provider routes enforce authentication, origin/CSRF policy, content type, body limits, timeout, and rate limits.
7. The adapter uses fixed HTTPS endpoints and rejects unsafe redirects and arbitrary URLs.
8. The adapter does not silently collect browser credentials or bypass provider controls.
9. User-Agent capture requires an explicit choice and applies only to the Web Provider.
10. `401` and `403` stop the request and require explicit re-import; no automatic refresh or auth retry occurs.
11. Model discovery uses the saved server-side session and persists only normalized valid models.
12. Failed or empty discovery does not delete the last known model list.
13. Model discovery cache is bounded, session-versioned, coalesced, and race-safe.
14. Manual model entry remains available if discovery is unsupported.
15. DeepSeek Web models never become the default automatically.
16. Project-harness chat rejects Web Provider models on the server.
17. All UI copy is English, and the help panel works at desktop and mobile widths.
18. The feature flag disables Web Provider behavior without breaking standard providers.
19. Targeted tests cover storage, API security, adapter fixtures, discovery races, model resolution, chat integration, and UI states.
20. The protocol spike produces redacted fixtures and a supported/unsupported decision before the adapter is enabled.

## 16. Open decisions before implementation

These are deliberate gates, not implementation placeholders:

1. **Protocol support decision:** Does the current DeepSeek Web behavior provide a stable, permitted credential, chat, stream, and model-discovery contract that meets Section 13?
2. **Exact credential fields:** Does the verified protocol require only `userToken`, or one or more specifically named additional fields? Full Cookie headers remain disallowed unless a later security review explicitly approves a narrowly scoped field.
3. **Exact model discovery contract:** Which fixed endpoint and response payload are supported by the provider at implementation time?
4. **Feature activation:** Keep `YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS` disabled by default in production until all release gates pass.

No implementation plan should begin until the protocol spike resolves these decisions without requiring bypass behavior.

## 17. Related repository decisions

- Provider registry and secret indirection: `docs/superpowers/specs/2026-09-04-provider-config-ssot-design.md`
- Existing encryption primitive: `src/lib/security/encryption.ts`
- Provider schema: `src/lib/ai/provider-config/schema.ts`
- Provider storage: `src/lib/ai/provider-config/store.ts`
- Provider write boundary: `src/lib/ai/provider-config/api-helpers.ts`
- Generic provider factory: `src/lib/ai/provider.ts`
- Generic model browsing: `src/lib/ai/models.ts`
- Standard provider API: `src/app/api/providers/route.ts`
- Normal chat route: `src/app/api/chat/route.ts`
- Project chat route: `src/app/api/projects/chat/route.ts`
