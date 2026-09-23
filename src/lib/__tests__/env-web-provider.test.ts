import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("Web Provider Environment Configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("defaults YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS to false", async () => {
    delete process.env.YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS;
    const { refreshEnv } = await import("@/env");
    const parsed = refreshEnv();
    expect(parsed.YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS).toBe(false);
  });

  it("exposes validated numeric limits with safe defaults", async () => {
    const { refreshEnv } = await import("@/env");
    const parsed = refreshEnv();
    expect(parsed.YGGDRASIL_WEB_PROVIDER_MAX_TOKEN_CHARS).toBe(8192);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_MAX_USER_AGENT_CHARS).toBe(1024);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_MAX_BODY_BYTES).toBe(16384);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_CHECK_ATTEMPTS_PER_IP).toBe(5);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_CHECK_ATTEMPTS_PER_CREDENTIAL).toBe(10);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_CHECK_ATTEMPTS_WINDOW_MS).toBe(900000);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_CHECK_COOLDOWN_MS).toBe(900000);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_CHECK_MAX_CONCURRENT).toBe(3);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_ATTEMPT_TIMEOUT_MS).toBe(10000);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_ROUTE_TIMEOUT_MS).toBe(20000);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_RETRY_BACKOFF_MS).toBe(250);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_RETRY_BUDGET_MS).toBe(15000);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_RETRY_AFTER_MAX_SECONDS).toBe(900);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_RETRY_AFTER_FALLBACK_SECONDS).toBe(60);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_DISCOVERY_TTL_MS).toBe(900000);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_DISCOVERY_REFRESH_COOLDOWN_MS).toBe(30000);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_STALE_MS).toBe(86400000);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_CACHE_ENTRIES).toBe(100);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_MODELS).toBe(200);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_RESPONSE_BYTES).toBe(1048576);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_STREAM_FRAME_MAX_BYTES).toBe(262144);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_STREAM_IDLE_TIMEOUT_MS).toBe(30000);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_PROTOCOL_FAILURE_THRESHOLD).toBe(3);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_PROTOCOL_FAILURE_WINDOW_MS).toBe(900000);
  });
});
