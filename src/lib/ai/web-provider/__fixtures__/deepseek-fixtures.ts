/**
 * Redacted DeepSeek Web protocol fixtures (Spec §13.1).
 *
 * Every value here is synthetic. No real token, cookie, account identifier,
 * session reference, or personal data appears in this file, and the shapes are
 * placeholders the protocol spike must confirm before the adapter is enabled
 * (Spec §16.1–§16.3). Tests assert adapter *contract* behavior against these
 * fixtures — never unverified provider payload truth.
 */

/** Shaped like a plausible credential-validation success, not a verified contract. */
export const sessionSuccessFixture = {
  code: 0,
  msg: "OK",
  data: { id: "redacted-user-id", email: "redacted@example.invalid", token: "redacted" },
} as const;

/** Rejected/expired session body. */
export const sessionRejectedFixture = {
  code: 40100,
  msg: "Unauthorized: session invalid or expired",
  data: null,
} as const;

/** Rate-limited body; the `Retry-After` header carries the cooldown. */
export const rateLimitedFixture = {
  code: 42900,
  msg: "Too many requests",
  data: null,
} as const;

/** A successful catalog carrying a duplicate id to exercise deterministic dedup. */
export const modelDiscoverySuccessFixture = {
  code: 0,
  data: [
    { id: "deepseek-chat", name: "DeepSeek Chat" },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
    { id: "deepseek-chat", name: "Duplicate DeepSeek Chat" },
  ],
} as const;

/** Records that must be dropped: blank id, whitespace-only id, non-string id, non-object. */
export const modelDiscoveryWithInvalidRecordsFixture = {
  code: 0,
  data: [
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
  data: [{ id: "deepseek-chat", name: "DeepSeek Chat", isDefault: true }],
} as const;

/** A successful catalog with no models — distinct from a failed request (Spec §8.4). */
export const modelDiscoveryEmptyFixture = {
  code: 0,
  data: [],
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

/** Builds a catalog whose serialized body exceeds the 1 MiB discovery response cap. */
export function buildOversizedDiscoveryPayload(): string {
  const records: Array<{ id: string; name: string }> = [];
  // Each record serializes to roughly 200 bytes, so ~6k records clear 1 MiB.
  for (let i = 0; i < 6_000; i += 1) {
    records.push({ id: `oversized-${i}`, name: "x".repeat(150) });
  }
  return JSON.stringify({ code: 0, data: records });
}

/** Builds a catalog larger than the model-count cap to prove truncation is bounded. */
export function buildOversizedModelCatalog(): { code: number; data: Array<{ id: string; name: string }> } {
  const data = Array.from({ length: 250 }, (_unused, i) => ({
    id: `model-${i}`,
    name: `Model ${i}`,
  }));
  return { code: 0, data };
}

export const FIXTURES = {
  sessionSuccess: sessionSuccessFixture,
  sessionRejected: sessionRejectedFixture,
  rateLimited: rateLimitedFixture,
  modelDiscoverySuccess: modelDiscoverySuccessFixture,
  modelDiscoveryWithInvalidRecords: modelDiscoveryWithInvalidRecordsFixture,
  modelDiscoveryWithDefaultClaim: modelDiscoveryWithDefaultClaimFixture,
  modelDiscoveryEmpty: modelDiscoveryEmptyFixture,
  modelDiscoveryMalformed: modelDiscoveryMalformedFixture,
  loginPageHtml: loginPageHtmlFixture,
  oversizedModelCatalog: buildOversizedModelCatalog(),
} as const;
