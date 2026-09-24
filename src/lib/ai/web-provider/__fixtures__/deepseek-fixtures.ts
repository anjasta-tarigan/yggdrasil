/**
 * Redacted DeepSeek Web protocol fixtures (Spec §13.1).
 *
 * Every value here is synthetic. No real token, cookie, account identifier,
 * session reference, or personal data appears in this file. The shapes are
 * derived from the reference implementations (OmniRoute `deepseek-web.ts`) and
 * are UNVERIFIED against the live service — the protocol spike must confirm them
 * before the adapter is enabled (Spec §16.1–§16.3). Tests assert adapter
 * *contract* behavior against these fixtures — never unverified provider payload
 * truth.
 */

/** `GET /api/v0/users/current` success: the operational access token lives in `biz_data`. */
export const sessionSuccessFixture = {
  code: 0,
  msg: "OK",
  biz_data: { token: "redacted-access-token", user_id: "redacted-user-id" },
} as const;

/** Rejected/expired session body returned behind an HTTP 200 (code !== 0). */
export const sessionRejectedFixture = {
  code: 40003,
  msg: "Unauthorized: session invalid or expired",
  biz_data: null,
} as const;

/** Rate-limited body; the `Retry-After` header carries the cooldown. */
export const rateLimitedFixture = {
  code: 42900,
  msg: "Too many requests",
  biz_data: null,
} as const;

/**
 * `GET /api/v0/client/settings?scope=model` model list. The exact envelope field
 * carrying models is UNVERIFIED; this fixture exercises the `biz_data` array path
 * and the `data.models` fallback the normalizer supports.
 */
export const modelDiscoverySuccessFixture = {
  code: 0,
  biz_data: [
    { id: "deepseek-chat", name: "DeepSeek Chat" },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
    { id: "deepseek-chat", name: "Duplicate DeepSeek Chat" },
  ],
} as const;

/** The `data.models` envelope variant the normalizer must also accept. */
export const modelDiscoveryDataModelsFixture = {
  code: 0,
  data: { models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }] },
} as const;

/** An empty settings payload — distinct from a failed request (Spec §8.2/§8.4). */
export const modelDiscoveryEmptyFixture = {
  code: 0,
  biz_data: [],
} as const;

/** A settings response with no mappable model list: "auto-discovery unavailable". */
export const modelDiscoveryUnavailableFixture = {
  code: 0,
  biz_data: { theme: "dark", locale: "en-US" },
} as const;

/** Records that must be dropped: blank id, whitespace-only id, non-string id, non-object. */
export const modelDiscoveryWithInvalidRecordsFixture = {
  code: 0,
  biz_data: [
    { id: "kept-model", name: "Kept Model" },
    { id: "   ", name: "Blank Id" },
    { id: 42, name: "Non String Id" },
    { name: "Missing Id" },
    "not-an-object",
    null,
    { id: "  trimmed-model  ", name: "  Trimmed Model  " },
  ],
} as const;

/** A record that claims default status; the adapter must never honour it (Spec §8.3). */
export const modelDiscoveryWithDefaultClaimFixture = {
  code: 0,
  biz_data: [{ id: "deepseek-chat", name: "DeepSeek Chat", is_default: true }],
} as const;

/** A successful catalog with no models — distinct from a failed request (Spec §8.4). */
export const modelDiscoveryEmptyCatalogFixture = {
  code: 0,
  biz_data: [],
} as const;

/** Syntactically invalid JSON; the adapter must classify it as a protocol error. */
export const modelDiscoveryMalformedFixture = "{ not-json";

/** A provider login page served instead of JSON: a session error, not an empty catalog. */
export const loginPageHtmlFixture = [
  "<!doctype html>",
  '<html lang="en">',
  "<head><title>Sign in - DeepSeek</title></head>",
  "<body>",
  '  <form id="login-form" method="post">',
  '    <input name="email" type="email" />',
  '    <input name="password" type="password" />',
  '    <button type="submit">Sign in</button>',
  "  </form>",
  "</body>",
  "</html>",
].join("\n");

/**
 * A PoW challenge whose `challenge` is the DeepSeekHashV1 digest of
 * `prefix + KNOWN_ANSWER`. `solvePow` must recover exactly `KNOWN_ANSWER`, and
 * no other nonce in `[0, difficulty)` may match (fixed test vector, A1).
 */
export const POW_SALT = "fixture-salt-zzz";
export const POW_EXPIRE_AT = 1760000000000;
export const POW_KNOWN_ANSWER = 5;
export const POW_DIFFICULTY = 64;
export const POW_SIGNATURE = "fixture-signature-aaa";
export const POW_TARGET_PATH = "/api/v0/chat/completion";

/** `POST /api/v0/chat_session/create` success: the per-request session id. */
export const chatSessionCreateFixture = {
  code: 0,
  biz_data: { chat_session_id: "redacted-session-id" },
} as const;

/**
 * Stream frames for the real patch grammar (Spec A5). Each entry is a `data:`
 * payload; the parser maps THINK → reasoning, RESPONSE → text-delta, FINISHED →
 * completion, search_results → metadata. UNVERIFIED shapes; spike-gated.
 */
export const SSE_THINK_FRAGMENT_FIXTURE =
  '{"v":{"response":{"message_id":2,"thinking_enabled":true,"fragments":[{"id":1,"type":"THINK","content":""}]}}}';
export const SSE_THINK_DELTA_FIXTURE =
  '{"p":"response/fragments/-1/content","o":"APPEND","v":"Let me reason step by step. "}';
export const SSE_RESPONSE_SWITCH_FIXTURE =
  '{"p":"response/fragments","o":"APPEND","v":{"id":3,"type":"RESPONSE","content":""}}';
export const SSE_RESPONSE_DELTA_FIXTURE =
  '{"p":"response/fragments/-1/content","o":"APPEND","v":"The answer is 42."}';
export const SSE_STATUS_FINISHED_FIXTURE = '{"p":"response/status","o":"SET","v":"FINISHED"}';
export const SSE_SEARCH_RESULTS_FIXTURE =
  '{"p":"response/search_results","v":[{"title":"Source","url":"https://example.invalid"}]}';
export const SSE_EVENT_CLOSE_FIXTURE = "event: close";

/** Builds a catalog whose serialized body exceeds the 1 MiB discovery response cap. */
export function buildOversizedDiscoveryPayload(): string {
  const records: Array<{ id: string; name: string }> = [];
  // Each record serializes to roughly 200 bytes, so ~6k records clear 1 MiB.
  for (let i = 0; i < 6_000; i += 1) {
    records.push({ id: `oversized-${i}`, name: "x".repeat(150) });
  }
  return JSON.stringify({ code: 0, biz_data: records });
}

/** Builds a catalog larger than the model-count cap to prove truncation is bounded. */
export function buildOversizedModelCatalog(): { code: number; biz_data: Array<{ id: string; name: string }> } {
  const biz_data = Array.from({ length: 250 }, (_unused, i) => ({
    id: `model-${i}`,
    name: `Model ${i}`,
  }));
  return { code: 0, biz_data };
}

export const FIXTURES = {
  sessionSuccess: sessionSuccessFixture,
  sessionRejected: sessionRejectedFixture,
  rateLimited: rateLimitedFixture,
  modelDiscoverySuccess: modelDiscoverySuccessFixture,
  modelDiscoveryDataModels: modelDiscoveryDataModelsFixture,
  modelDiscoveryEmpty: modelDiscoveryEmptyFixture,
  modelDiscoveryUnavailable: modelDiscoveryUnavailableFixture,
  modelDiscoveryWithInvalidRecords: modelDiscoveryWithInvalidRecordsFixture,
  modelDiscoveryWithDefaultClaim: modelDiscoveryWithDefaultClaimFixture,
  modelDiscoveryEmptyCatalog: modelDiscoveryEmptyCatalogFixture,
  modelDiscoveryMalformed: modelDiscoveryMalformedFixture,
  loginPageHtml: loginPageHtmlFixture,
  chatSessionCreate: chatSessionCreateFixture,
  oversizedModelCatalog: buildOversizedModelCatalog(),
} as const;
