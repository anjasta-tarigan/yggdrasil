import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const checkLatestVersionMock = vi.hoisted(() => vi.fn());
const getSettingDbMock = vi.hoisted(() => vi.fn());
const setSettingsDbMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/system/version", () => ({
  checkLatestVersion: checkLatestVersionMock,
}));

vi.mock("@/lib/settings-service", () => ({
  getSettingDb: getSettingDbMock,
  setSettingsDb: setSettingsDbMock,
}));

import { GET, POST } from "../update-check/route";

describe("GET & POST /api/system/update-check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GET returns version information and dismissed=false when release is not dismissed", async () => {
    checkLatestVersionMock.mockResolvedValueOnce({
      current: "0.1.0",
      latest: "0.2.0",
      available: true,
      channel: "release",
      releaseUrl: "https://github.com/release/v0.2.0",
      releaseNotes: "Some release notes",
      checkedAt: 12345,
      errored: false,
    });
    getSettingDbMock.mockReturnValue(null);

    const req = new Request("http://127.0.0.1:3000/api/system/update-check");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.current).toBe("0.1.0");
    expect(data.latest).toBe("0.2.0");
    expect(data.available).toBe(true);
    expect(data.dismissed).toBe(false);
  });

  it("GET returns dismissed=true when current latest version matches dismissed setting", async () => {
    checkLatestVersionMock.mockResolvedValueOnce({
      current: "0.1.0",
      latest: "0.2.0",
      available: true,
      channel: "release",
      releaseUrl: "https://github.com/release/v0.2.0",
      checkedAt: 12345,
      errored: false,
    });
    getSettingDbMock.mockReturnValue({ version: "0.2.0", dismissedAt: 12000 });

    const req = new Request("http://127.0.0.1:3000/api/system/update-check");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.dismissed).toBe(true);
  });

  it("GET returns dismissed=false when a newer version arrives after an older version was dismissed", async () => {
    checkLatestVersionMock.mockResolvedValueOnce({
      current: "0.1.0",
      latest: "0.3.0",
      available: true,
      channel: "release",
      releaseUrl: "https://github.com/release/v0.3.0",
      checkedAt: 12345,
      errored: false,
    });
    getSettingDbMock.mockReturnValue({ version: "0.2.0", dismissedAt: 12000 });

    const req = new Request("http://127.0.0.1:3000/api/system/update-check");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.dismissed).toBe(false);
  });

  it("POST dismiss saves the dismissed version to settings store", async () => {
    checkLatestVersionMock.mockResolvedValueOnce({
      current: "0.1.0",
      latest: "0.2.0",
      available: true,
      channel: "release",
      releaseUrl: "https://github.com/release/v0.2.0",
      checkedAt: 12345,
      errored: false,
    });

    const req = new Request("http://127.0.0.1:3000/api/system/update-check", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "dismiss" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(setSettingsDbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        system_update_dismissed: expect.objectContaining({
          version: "0.2.0",
        }),
      })
    );
  });

  it("POST rejects missing Origin on mutating requests", async () => {
    const req = new Request("http://127.0.0.1:3000/api/system/update-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "dismiss" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("POST allows a Bearer-authenticated caller with no Origin (non-browser client)", async () => {
    // A CLI or remote-management client has no Origin to send; its shared-secret
    // auth proves intent, so the CSRF check is skipped for it. Parity with the
    // web-providers guard.
    vi.stubEnv("APP_SECRET", "test-secret-at-least-32-chars-long-12345");
    checkLatestVersionMock.mockResolvedValueOnce({
      current: "0.1.0",
      latest: "0.2.0",
      available: true,
      channel: "release",
      releaseUrl: "https://github.com/release/v0.2.0",
      checkedAt: 12345,
      errored: false,
    });

    const req = new Request("http://127.0.0.1:3000/api/system/update-check", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-at-least-32-chars-long-12345",
      },
      body: JSON.stringify({ action: "dismiss" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    vi.unstubAllEnvs();
  });
});
