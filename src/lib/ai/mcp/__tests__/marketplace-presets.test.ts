import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_PRESETS } from "../marketplace-presets";
import { maskMcpServerConfig, writeMcpSecret, resolveMcpSecret } from "../secrets";
import { __setSecretsPath } from "@/lib/ai/provider-config/secrets";
import type { McpServerConfig } from "../config";

describe("MCP Marketplace Presets & Secrets", () => {
  it("pins all stdio preset versions", () => {
    for (const preset of MCP_PRESETS) {
      if (preset.transport === "stdio" && preset.command) {
        expect(preset.command).toMatch(/@[0-9]+\.[0-9]+\.[0-9]+/);
      }
    }
  });

  it("includes all required preset servers", () => {
    const names = MCP_PRESETS.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "SQLite",
        "PostgreSQL",
        "GitHub",
        "Git",
        "Puppeteer",
        "Filesystem",
        "Brave Search",
        "Fetch",
        "Memory",
      ])
    );
  });

  it("masks sensitive environment variables in client view", () => {
    const config: McpServerConfig = {
      id: "srv-github",
      name: "GitHub",
      transport: "stdio",
      enabled: true,
      command: "npx -y @modelcontextprotocol/server-github@0.6.2",
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret123456789",
        DEBUG: "true",
      },
    };

    const masked = maskMcpServerConfig(config);
    expect(masked.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("••••••••");
    expect(masked.env?.DEBUG).toBe("true");
  });

  it("masks keys containing TOKEN, KEY, SECRET, PASSWORD", () => {
    const config: McpServerConfig = {
      id: "srv",
      name: "Test",
      transport: "stdio",
      enabled: true,
      command: "node server.js",
      env: {
        API_KEY: "secret",
        PASSWORD: "secret",
        TOKEN: "secret",
        SECRET: "secret",
        DEBUG: "true",
        PATH: "/usr/bin",
      },
    };

    const masked = maskMcpServerConfig(config);
    expect(masked.env?.API_KEY).toBe("••••••••");
    expect(masked.env?.PASSWORD).toBe("••••••••");
    expect(masked.env?.TOKEN).toBe("••••••••");
    expect(masked.env?.SECRET).toBe("••••••••");
    expect(masked.env?.DEBUG).toBe("true");
    expect(masked.env?.PATH).toBe("/usr/bin");
  });

  it("does not mutate the original config", () => {
    const config: McpServerConfig = {
      id: "srv",
      name: "Test",
      transport: "stdio",
      enabled: true,
      command: "node server.js",
      env: { TOKEN: "real-secret" },
    };

    const masked = maskMcpServerConfig(config);
    expect(masked).not.toBe(config);
    expect(config.env?.TOKEN).toBe("real-secret");
    expect(masked.env?.TOKEN).toBe("••••••••");
  });

  describe("writeMcpSecret / resolveMcpSecret", () => {
    let dataDir: string;

    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), "mcp-secrets-test-"));
      __setSecretsPath(join(dataDir, "providers.secrets.env"));
    });

    afterEach(async () => {
      await rm(dataDir, { recursive: true, force: true });
    });

    it("writes and resolves a secret", async () => {
      await writeMcpSecret("MCP_GITHUB_TOKEN", "ghp_abc123");
      expect(await resolveMcpSecret("MCP_GITHUB_TOKEN")).toBe("ghp_abc123");
    });

    it("returns undefined for a missing secret", async () => {
      expect(await resolveMcpSecret("DOES_NOT_EXIST")).toBeUndefined();
    });

    it("overwrites an existing value", async () => {
      await writeMcpSecret("MCP_TOKEN", "first");
      await writeMcpSecret("MCP_TOKEN", "second");
      expect(await resolveMcpSecret("MCP_TOKEN")).toBe("second");
    });

    it("preserves existing secrets when writing a new one", async () => {
      await writeMcpSecret("FIRST_KEY", "first-val");
      await writeMcpSecret("SECOND_KEY", "second-val");
      expect(await resolveMcpSecret("FIRST_KEY")).toBe("first-val");
      expect(await resolveMcpSecret("SECOND_KEY")).toBe("second-val");
    });
  });
});
