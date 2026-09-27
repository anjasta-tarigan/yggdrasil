import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, DELETE } from "@/app/api/system/logs/route";
import { GET as GET_DOWNLOAD } from "@/app/api/system/logs/download/route";
import type { LogEntry } from "@/lib/observability/log-store";

/**
 * The system-logs endpoint backs the Statistics page log viewer. The store
 * (ring buffer + filters) is covered by lib/observability tests; here it is
 * mocked so only the adapter contract is pinned: query parsing, level
 * validation, response shape, clear, and the text download.
 */

const mocks = vi.hoisted(() => ({
  queryLogs: vi.fn(),
  clearLogs: vi.fn(),
  logsAsText: vi.fn(),
}));

vi.mock("@/lib/observability/log-store", () => ({
  queryLogs: mocks.queryLogs,
  clearLogs: mocks.clearLogs,
  logsAsText: mocks.logsAsText,
}));

const sample: LogEntry[] = [
  { id: 1, at: "2026-09-28T00:00:00.000Z", level: "info", scope: "agent", message: "started" },
  { id: 2, at: "2026-09-28T00:00:01.000Z", level: "error", scope: "queue", message: "boom" },
];

const req = (qs: string) => new Request(`http://x/api/system/logs${qs}`);

beforeEach(() => {
  mocks.queryLogs.mockReset();
  mocks.clearLogs.mockReset();
  mocks.logsAsText.mockReset();
});

describe("GET /api/system/logs", () => {
  it("returns entries with the default query", async () => {
    mocks.queryLogs.mockReturnValue(sample);
    const res = await GET(req(""));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: LogEntry[] };
    expect(body.entries).toHaveLength(2);
    expect(mocks.queryLogs).toHaveBeenCalledWith({
      limit: undefined,
      minLevel: undefined,
      search: undefined,
    });
  });

  it("forwards limit, minLevel and search", async () => {
    mocks.queryLogs.mockReturnValue([]);
    await GET(req("?limit=50&minLevel=warn&search=boom"));
    expect(mocks.queryLogs).toHaveBeenCalledWith({
      limit: 50,
      minLevel: "warn",
      search: "boom",
    });
  });

  it("rejects an invalid minLevel", async () => {
    const res = await GET(req("?minLevel=loud"));
    expect(res.status).toBe(400);
    expect(mocks.queryLogs).not.toHaveBeenCalled();
  });

  it("rejects an invalid limit", async () => {
    const res = await GET(req("?limit=0"));
    expect(res.status).toBe(400);
    const res2 = await GET(req("?limit=abc"));
    expect(res2.status).toBe(400);
    expect(mocks.queryLogs).not.toHaveBeenCalled();
  });

  it("answers 500 when the store throws", async () => {
    mocks.queryLogs.mockImplementation(() => {
      throw new Error("store down");
    });
    const res = await GET(req(""));
    expect(res.status).toBe(500);
  });
});

describe("DELETE /api/system/logs", () => {
  it("clears logs and reports the count", async () => {
    mocks.clearLogs.mockReturnValue(7);
    const res = await DELETE();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cleared: number };
    expect(body.cleared).toBe(7);
  });

  it("answers 500 when clearing throws", async () => {
    mocks.clearLogs.mockImplementation(() => {
      throw new Error("store down");
    });
    const res = await DELETE();
    expect(res.status).toBe(500);
  });
});

describe("GET /api/system/logs/download", () => {
  it("returns the buffer as a plain-text attachment", async () => {
    mocks.logsAsText.mockReturnValue("line one\nline two");
    const res = await GET_DOWNLOAD();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(await res.text()).toBe("line one\nline two");
  });
});
