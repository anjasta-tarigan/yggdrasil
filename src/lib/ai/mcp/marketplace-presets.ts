/**
 * MCP marketplace presets — curated, pinned MCP server configurations.
 *
 * Each preset uses a pinned npm version (no floating tags) so that tool
 * definitions and transport behavior remain stable across installs.
 * Versions are pinned with `@<major>.<minor>.<patch>`.
 */

import type { McpServerConfig } from "./config";

export type McpPreset = {
  /** Display name shown in the marketplace UI. */
  name: string;
  /** Short human-readable description. */
  description: string;
  /** Grouping for filtering (e.g. "Database", "Development"). */
  category: string;
  /** A pre-built, sanitized McpServerConfig the user can import directly. */
  config: McpServerConfig;
  /**
   * Environment variables this server expects from the user, with
   * human-readable descriptions. These map to the secret store keys.
   */
  envVars: Array<{ name: string; description: string; required: boolean }>;
};

const PINNED_VERSION = "0.6.2";

export const MCP_PRESETS: McpPreset[] = [
  {
    name: "SQLite",
    description: "Query SQLite databases with read-only or read-write access.",
    category: "Database",
    config: {
      id: "mcp-sqlite",
      name: "SQLite",
      transport: "stdio",
      enabled: true,
      command: `uv tool run mcp-sqlite@${PINNED_VERSION}`,
    },
    envVars: [],
  },
  {
    name: "PostgreSQL",
    description: "Connect to a PostgreSQL database and run queries.",
    category: "Database",
    config: {
      id: "mcp-postgres",
      name: "PostgreSQL",
      transport: "stdio",
      enabled: true,
      command: `npx -y @modelcontextprotocol/server-postgres@${PINNED_VERSION}`,
    },
    envVars: [
      { name: "DATABASE_URL", description: "PostgreSQL connection string (e.g. postgres://user:pass@host:5432/db)", required: true },
      { name: "POSTGRES_USER", description: "PostgreSQL username (optional if embedded in DATABASE_URL)", required: false },
    ],
  },
  {
    name: "GitHub",
    description: "Search and interact with GitHub repositories and issues.",
    category: "Development",
    config: {
      id: "mcp-github",
      name: "GitHub",
      transport: "stdio",
      enabled: true,
      command: `npx -y @modelcontextprotocol/server-github@${PINNED_VERSION}`,
    },
    envVars: [
      { name: "GITHUB_PERSONAL_ACCESS_TOKEN", description: "A GitHub personal access token with repo and read:org scopes", required: true },
    ],
  },
  {
    name: "Git",
    description: "Run git commands and inspect repositories.",
    category: "Development",
    config: {
      id: "mcp-git",
      name: "Git",
      transport: "stdio",
      enabled: true,
      command: `npx -y @modelcontextprotocol/server-git@${PINNED_VERSION}`,
    },
    envVars: [],
  },
  {
    name: "Puppeteer",
    description: "Automate browser interactions and scrape web pages.",
    category: "Web",
    config: {
      id: "mcp-puppeteer",
      name: "Puppeteer",
      transport: "stdio",
      enabled: true,
      command: `npx -y @modelcontextprotocol/server-puppeteer@${PINNED_VERSION}`,
    },
    envVars: [],
  },
  {
    name: "Filesystem",
    description: "Read, write, and list files and directories on the local filesystem.",
    category: "System",
    config: {
      id: "mcp-filesystem",
      name: "Filesystem",
      transport: "stdio",
      enabled: true,
      command: `npx -y @modelcontextprotocol/server-filesystem@${PINNED_VERSION}`,
      args: ["<BASE_PATH>"],
    },
    envVars: [],
  },
  {
    name: "Brave Search",
    description: "Search the web using Brave's search API.",
    category: "Web",
    config: {
      id: "mcp-brave-search",
      name: "Brave Search",
      transport: "stdio",
      enabled: true,
      command: `npx -y @modelcontextprotocol/server-brave-search@${PINNED_VERSION}`,
    },
    envVars: [
      { name: "BRAVE_API_KEY", description: "A Brave Search API key (get from brave.com/search/apis)", required: true },
    ],
  },
  {
    name: "Fetch",
    description: "Fetch content from URLs (HTTP/HTTPS).",
    category: "Web",
    config: {
      id: "mcp-fetch",
      name: "Fetch",
      transport: "stdio",
      enabled: true,
      command: `npx -y @modelcontextprotocol/server-fetch@${PINNED_VERSION}`,
    },
    envVars: [],
  },
  {
    name: "Memory",
    description: "Persist and query knowledge across conversations using a local knowledge graph.",
    category: "Productivity",
    config: {
      id: "mcp-memory",
      name: "Memory",
      transport: "stdio",
      enabled: true,
      command: `npx -y @modelcontextprotocol/server-memory@${PINNED_VERSION}`,
    },
    envVars: [],
  },
];
