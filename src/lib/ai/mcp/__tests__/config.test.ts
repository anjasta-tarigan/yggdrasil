import { describe, expect, it } from "vitest";
import {
  createMcpServerId,
  sanitizeMcpServerConfig,
  sanitizeMcpServerList,
  slugifyServerName,
} from "../config";

const validHttp = {
  id: "mcp-1",
  name: "Weather",
  transport: "http",
  url: "https://mcp.example.com/mcp",
  enabled: true,
};

const validStdio = {
  id: "mcp-2",
  name: "Local files",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  enabled: true,
};

describe("sanitizeMcpServerConfig", () => {
  it("accepts a valid http config and keeps headers", () => {
    const clean = sanitizeMcpServerConfig({
      ...validHttp,
      headers: { Authorization: "Bearer token" },
    });
    expect(clean).toEqual({
      id: "mcp-1",
      name: "Weather",
      transport: "http",
      enabled: true,
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer token" },
    });
  });

  it("accepts a valid sse config", () => {
    const clean = sanitizeMcpServerConfig({
      ...validHttp,
      transport: "sse",
      url: "https://mcp.example.com/sse",
    });
    expect(clean?.transport).toBe("sse");
  });

  it("accepts a valid stdio config with args and env", () => {
    const clean = sanitizeMcpServerConfig({
      ...validStdio,
      env: { API_KEY: "abc" },
    });
    expect(clean).toEqual({
      id: "mcp-2",
      name: "Local files",
      transport: "stdio",
      enabled: true,
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      env: { API_KEY: "abc" },
    });
  });

  it("defaults enabled to true when omitted", () => {
    const rest = {
      id: validHttp.id,
      name: validHttp.name,
      transport: validHttp.transport,
      url: validHttp.url,
    };
    expect(sanitizeMcpServerConfig(rest)?.enabled).toBe(true);
  });

  it("drops transport-specific fields from the cleaned output", () => {
    // stdio fields on an http server must not survive sanitization
    const clean = sanitizeMcpServerConfig({
      ...validHttp,
      command: "rm",
      args: ["-rf"],
      env: { X: "1" },
    });
    expect(clean).not.toBeNull();
    expect(clean?.command).toBeUndefined();
    expect(clean?.args).toBeUndefined();
    expect(clean?.env).toBeUndefined();

    const cleanStdio = sanitizeMcpServerConfig({
      ...validStdio,
      url: "https://evil.example.com",
      headers: { X: "y" },
    });
    expect(cleanStdio?.url).toBeUndefined();
    expect(cleanStdio?.headers).toBeUndefined();
  });

  it("rejects missing or malformed urls for http transports", () => {
    expect(sanitizeMcpServerConfig({ ...validHttp, url: undefined })).toBeNull();
    expect(sanitizeMcpServerConfig({ ...validHttp, url: "" })).toBeNull();
    expect(
      sanitizeMcpServerConfig({ ...validHttp, url: "file:///etc/passwd" })
    ).toBeNull();
    expect(
      sanitizeMcpServerConfig({ ...validHttp, url: "javascript:alert(1)" })
    ).toBeNull();
  });

  it("rejects unknown transports and bad shapes", () => {
    expect(
      sanitizeMcpServerConfig({ ...validHttp, transport: "websocket" })
    ).toBeNull();
    expect(sanitizeMcpServerConfig(null)).toBeNull();
    expect(sanitizeMcpServerConfig("http")).toBeNull();
    expect(sanitizeMcpServerConfig({ ...validHttp, id: "" })).toBeNull();
    expect(sanitizeMcpServerConfig({ ...validHttp, name: "" })).toBeNull();
  });

  it("rejects invalid header names and oversized values", () => {
    expect(
      sanitizeMcpServerConfig({
        ...validHttp,
        headers: { "Bad Header": "x" },
      })
    ).toBeNull();
    expect(
      sanitizeMcpServerConfig({
        ...validHttp,
        headers: { Authorization: 42 },
      })
    ).toBeNull();
    expect(
      sanitizeMcpServerConfig({
        ...validHttp,
        headers: { Authorization: "x".repeat(2049) },
      })
    ).toBeNull();
  });

  it("rejects stdio configs without a command or with control chars", () => {
    expect(
      sanitizeMcpServerConfig({ ...validStdio, command: undefined })
    ).toBeNull();
    expect(
      sanitizeMcpServerConfig({ ...validStdio, command: "bad\x00cmd" })
    ).toBeNull();
    expect(
      sanitizeMcpServerConfig({ ...validStdio, args: [123] })
    ).toBeNull();
  });

  it("rejects invalid env variable names", () => {
    expect(
      sanitizeMcpServerConfig({
        ...validStdio,
        env: { "NOT-VALID": "x" },
      })
    ).toBeNull();
    expect(
      sanitizeMcpServerConfig({ ...validStdio, env: { OK: 1 } })
    ).toBeNull();
  });
});

describe("sanitizeMcpServerList", () => {
  it("accepts a list of valid configs", () => {
    expect(sanitizeMcpServerList([validHttp, validStdio])).toHaveLength(2);
  });

  it("accepts an empty list (clears the registry)", () => {
    expect(sanitizeMcpServerList([])).toEqual([]);
  });

  it("rejects duplicate ids", () => {
    expect(
      sanitizeMcpServerList([validHttp, { ...validStdio, id: "mcp-1" }])
    ).toBeNull();
  });

  it("rejects when any entry is invalid", () => {
    expect(
      sanitizeMcpServerList([validHttp, { ...validStdio, command: "" }])
    ).toBeNull();
  });

  it("rejects non-arrays and oversized lists", () => {
    expect(sanitizeMcpServerList("nope")).toBeNull();
    const many = Array.from({ length: 21 }, (_, i) => ({
      ...validHttp,
      id: `mcp-${i}`,
    }));
    expect(sanitizeMcpServerList(many)).toBeNull();
  });
});

describe("slugifyServerName", () => {
  it("lowercases and replaces non-alphanumerics with hyphens", () => {
    expect(slugifyServerName("My Weather Server!")).toBe("my-weather-server");
  });

  it("falls back to 'server' for unusable names", () => {
    expect(slugifyServerName("///")).toBe("server");
    expect(slugifyServerName("")).toBe("server");
  });

  it("bounds long names", () => {
    expect(slugifyServerName("a".repeat(100)).length).toBeLessThanOrEqual(40);
  });
});

describe("createMcpServerId", () => {
  it("creates unique prefixed ids", () => {
    const a = createMcpServerId();
    const b = createMcpServerId();
    expect(a).toMatch(/^mcp-/);
    expect(a).not.toBe(b);
  });
});
