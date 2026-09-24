// @vitest-environment node
/**
 * Protocol-failure circuit breaker (Spec §11.3): three protocol parse
 * failures for one adapter version within 15 minutes disable the provider.
 *
 * The session store is mocked at the module boundary — the breaker's job is to
 * decide *when* to disable and *what* status to write, not to own persistence,
 * so these tests need no database and never touch a real session row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "@/env";
import { clearLogs, queryLogs } from "@/lib/observability/log-store";
import { recordProtocolFailure, resetProtocolFailures } from "../circuit-breaker";
import type { AdapterErrorCode } from "../adapter";

const updateWebSessionStatusMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/ai/web-provider/session-store", () => ({
  updateWebSessionStatus: updateWebSessionStatusMock,
}));

const PROVIDER = "deepseek-web";

/** Wall-clock policy, so every test drives a fake clock instead of sleeping. */
let clock = 0;

/**
 * Spec §12's closed event: one line per disablement, with providerId and the
 * closed adapter resultCode only.
 */
function failureEvents() {
  return queryLogs({ search: "web_provider.request.failed" });
}

describe("protocol failure circuit breaker", () => {
  beforeEach(() => {
    clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    updateWebSessionStatusMock.mockClear();
    resetProtocolFailures(PROVIDER);
    clearLogs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves the session untouched below the threshold", async () => {
    await recordProtocolFailure(PROVIDER, "protocol_error");
    await recordProtocolFailure(PROVIDER, "protocol_error");

    expect(updateWebSessionStatusMock).not.toHaveBeenCalled();
    expect(failureEvents()).toHaveLength(0);
  });

  it("trips to degraded on the third protocol_error and logs the event once", async () => {
    await recordProtocolFailure(PROVIDER, "protocol_error");
    await recordProtocolFailure(PROVIDER, "protocol_error");
    await recordProtocolFailure(PROVIDER, "protocol_error");

    expect(updateWebSessionStatusMock).toHaveBeenCalledTimes(1);
    expect(updateWebSessionStatusMock).toHaveBeenCalledWith(
      PROVIDER,
      "degraded",
      "protocol_error"
    );

    const events = failureEvents();
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe("warn");
    expect(events[0].scope).toBe("web-provider");
    expect(events[0].message).toContain(`providerId=${PROVIDER}`);
    expect(events[0].message).toContain("resultCode=protocol_error");
  });

  it("trips to unsupported when any failure in the window is unsupported_protocol", async () => {
    await recordProtocolFailure(PROVIDER, "protocol_error");
    await recordProtocolFailure(PROVIDER, "unsupported_protocol");
    await recordProtocolFailure(PROVIDER, "protocol_error");

    expect(updateWebSessionStatusMock).toHaveBeenCalledTimes(1);
    expect(updateWebSessionStatusMock).toHaveBeenCalledWith(
      PROVIDER,
      "unsupported",
      "unsupported_protocol"
    );
    expect(failureEvents()[0].message).toContain("resultCode=unsupported_protocol");
  });

  it("stays tripped without re-logging on further failures", async () => {
    for (let index = 0; index < 6; index += 1) {
      await recordProtocolFailure(PROVIDER, "protocol_error");
    }

    expect(updateWebSessionStatusMock).toHaveBeenCalledTimes(1);
    expect(failureEvents()).toHaveLength(1);
  });

  it("does not count a failure older than the window", async () => {
    await recordProtocolFailure(PROVIDER, "protocol_error");
    await recordProtocolFailure(PROVIDER, "protocol_error");

    clock += env.YGGDRASIL_WEB_PROVIDER_PROTOCOL_FAILURE_WINDOW_MS + 1;
    await recordProtocolFailure(PROVIDER, "protocol_error");

    expect(updateWebSessionStatusMock).not.toHaveBeenCalled();
    expect(failureEvents()).toHaveLength(0);
  });

  it.each(["session_rejected", "rate_limited", "network_error"] as const)(
    "never trips on the non-protocol code %s",
    async (code: AdapterErrorCode) => {
      for (let index = 0; index < 6; index += 1) {
        await recordProtocolFailure(PROVIDER, code);
      }

      expect(updateWebSessionStatusMock).not.toHaveBeenCalled();
      expect(failureEvents()).toHaveLength(0);
    }
  );

  it("clears the trip and the bucket on reset so counting starts fresh", async () => {
    for (let index = 0; index < 3; index += 1) {
      await recordProtocolFailure(PROVIDER, "protocol_error");
    }
    expect(updateWebSessionStatusMock).toHaveBeenCalledTimes(1);

    resetProtocolFailures(PROVIDER);

    await recordProtocolFailure(PROVIDER, "protocol_error");
    await recordProtocolFailure(PROVIDER, "protocol_error");
    expect(updateWebSessionStatusMock).toHaveBeenCalledTimes(1);

    await recordProtocolFailure(PROVIDER, "protocol_error");
    expect(updateWebSessionStatusMock).toHaveBeenCalledTimes(2);
    expect(failureEvents()).toHaveLength(2);
  });

  it("writes and logs exactly once when two failures trip concurrently", async () => {
    // Rule 17: the trip must be claimed synchronously, before the status-write
    // await, or two interleaved failures that both cross the threshold would
    // both pass the `tripped` check and both write and log.
    await recordProtocolFailure(PROVIDER, "protocol_error");
    await recordProtocolFailure(PROVIDER, "protocol_error");

    await Promise.all([
      recordProtocolFailure(PROVIDER, "protocol_error"),
      recordProtocolFailure(PROVIDER, "protocol_error"),
    ]);

    expect(updateWebSessionStatusMock).toHaveBeenCalledTimes(1);
    expect(failureEvents()).toHaveLength(1);
  });

  it("never lets a failed status write escape the caller's error path", async () => {
    // The caller is already handling an upstream protocol failure; a
    // bookkeeping write that throws must not replace it with an unhandled
    // rejection. The failure is logged, not swallowed.
    updateWebSessionStatusMock.mockRejectedValueOnce(new Error("db unavailable"));

    await recordProtocolFailure(PROVIDER, "protocol_error");
    await recordProtocolFailure(PROVIDER, "protocol_error");
    await expect(
      recordProtocolFailure(PROVIDER, "protocol_error")
    ).resolves.toBeUndefined();

    const events = failureEvents();
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe("error");
    expect(events[0].message).toContain("resultCode=protocol_error");
  });

  it("releases the claim after a failed write so a later failure can retry", async () => {
    updateWebSessionStatusMock.mockRejectedValueOnce(new Error("db unavailable"));

    for (let index = 0; index < 3; index += 1) {
      await recordProtocolFailure(PROVIDER, "protocol_error");
    }
    expect(updateWebSessionStatusMock).toHaveBeenCalledTimes(1);

    // The disablement did not land, so the next threshold crossing must try
    // again rather than stay permanently tripped.
    for (let index = 0; index < 3; index += 1) {
      await recordProtocolFailure(PROVIDER, "protocol_error");
    }
    expect(updateWebSessionStatusMock).toHaveBeenCalledTimes(2);
    expect(updateWebSessionStatusMock).toHaveBeenLastCalledWith(
      PROVIDER,
      "degraded",
      "protocol_error"
    );
  });
});
