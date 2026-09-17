import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { setSettingsDb } from "@/lib/settings-service";
import {
  CUSTOM_TOOLS_KEY,
  listCustomTools,
  getCustomToolById,
  saveCustomTool,
  deleteCustomTool,
  setCustomToolEnabled,
  maskCustomToolSummary,
} from "../service";

describe("Custom Tools Service", () => {
  beforeEach(() => {
    setSettingsDb({ [CUSTOM_TOOLS_KEY]: undefined }, db);
  });

  const sampleInput = {
    name: "github_issue_fetch",
    description: "Fetch github issue",
    enabled: true,
    schema: {
      type: "object",
      properties: { repo: { type: "string" } },
      required: ["repo"],
    },
    execution: {
      type: "http" as const,
      url: "https://api.github.test/repos/{repo}/issues",
      method: "GET" as const,
      headers: {
        Authorization: "Bearer secret_token_xyz",
        "X-Custom-Header": "header_value",
      },
      timeoutMs: 5000,
    },
  };

  it("saves, lists, and reads custom tools", () => {
    const saved = saveCustomTool(sampleInput, undefined, db);
    expect(saved.id).toMatch(/^ctool_/);
    expect(saved.name).toBe("github_issue_fetch");
    expect(saved.createdAt).toBeGreaterThan(0);
    expect(saved.updatedAt).toBe(saved.createdAt);

    const tools = listCustomTools(db);
    expect(tools.some((t) => t.id === saved.id)).toBe(true);

    const fetched = getCustomToolById(saved.id, db);
    expect(fetched?.name).toBe("github_issue_fetch");
    expect(fetched?.execution.type === "http" && fetched.execution.headers?.Authorization).toBe("Bearer secret_token_xyz");
  });

  it("masks all header values in summary while setting hasSecrets flag", () => {
    const saved = saveCustomTool(sampleInput, undefined, db);
    const summary = maskCustomToolSummary(saved);

    expect(summary.execution.headers?.Authorization).toBe("••••••••");
    expect(summary.execution.headers?.["X-Custom-Header"]).toBe("••••••••");
    expect(summary.execution.hasSecrets).toBe(true);
  });

  it("marks hasSecrets false when no sensitive header exists", () => {
    const nonSensitiveInput = {
      ...sampleInput,
      name: "public_ping",
      execution: {
        type: "http" as const,
        url: "https://api.example.com/ping",
        method: "GET" as const,
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
      },
    };
    const saved = saveCustomTool(nonSensitiveInput, undefined, db);
    const summary = maskCustomToolSummary(saved);

    expect(summary.execution.headers?.["Content-Type"]).toBe("••••••••");
    expect(summary.execution.hasSecrets).toBe(false);
    expect(summary.execution.timeoutMs).toBe(10000);
  });

  it("updates and toggles custom tools", () => {
    const saved = saveCustomTool(sampleInput, undefined, db);
    const toggled = setCustomToolEnabled(saved.id, false, db);
    expect(toggled).toBe(true);

    const disabled = getCustomToolById(saved.id, db);
    expect(disabled?.enabled).toBe(false);

    saveCustomTool({ ...sampleInput, description: "Updated description" }, saved.id, db);
    const updated = getCustomToolById(saved.id, db);
    expect(updated?.description).toBe("Updated description");
    expect(updated?.createdAt).toBe(saved.createdAt);
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(saved.updatedAt);
  });

  it("preserves original secret headers when updating a tool with masked header values", () => {
    const saved = saveCustomTool(sampleInput, undefined, db);
    const summary = maskCustomToolSummary(saved);

    // Ensure summary masked the headers
    expect(summary.execution.headers?.Authorization).toBe("••••••••");

    // Simulate saving an edit from client with masked Authorization header
    const updateInput = {
      ...sampleInput,
      description: "Updated description without revealing secret",
      execution: {
        ...sampleInput.execution,
        headers: {
          Authorization: "••••••••",
          "X-Custom-Header": "••••••••",
          "X-New-Header": "fresh_token_123",
        },
      },
    };

    const updated = saveCustomTool(updateInput, saved.id, db);
    expect(updated.description).toBe("Updated description without revealing secret");
    expect(updated.execution.type === "http" && updated.execution.headers?.Authorization).toBe("Bearer secret_token_xyz");
    expect(updated.execution.type === "http" && updated.execution.headers?.["X-Custom-Header"]).toBe("header_value");
    expect(updated.execution.type === "http" && updated.execution.headers?.["X-New-Header"]).toBe("fresh_token_123");

    // Also verify persistence in DB
    const fetched = getCustomToolById(saved.id, db);
    expect(fetched?.execution.type === "http" && fetched.execution.headers?.Authorization).toBe("Bearer secret_token_xyz");
    expect(fetched?.execution.type === "http" && fetched.execution.headers?.["X-Custom-Header"]).toBe("header_value");
    expect(fetched?.execution.type === "http" && fetched.execution.headers?.["X-New-Header"]).toBe("fresh_token_123");
  });

  it("allows updating secret header when a new raw value is provided", () => {
    const saved = saveCustomTool(sampleInput, undefined, db);
    const updateInput = {
      ...sampleInput,
      execution: {
        ...sampleInput.execution,
        headers: {
          Authorization: "Bearer newly_rotated_secret",
        },
      },
    };

    const updated = saveCustomTool(updateInput, saved.id, db);
    expect(updated.execution.type === "http" && updated.execution.headers?.Authorization).toBe("Bearer newly_rotated_secret");
  });

  it("returns false when toggling a non-existent tool", () => {
    const result = setCustomToolEnabled("ctool_nonexistent", true, db);
    expect(result).toBe(false);
  });

  it("deletes custom tools", () => {
    const saved = saveCustomTool(sampleInput, undefined, db);
    const deleted = deleteCustomTool(saved.id, db);
    expect(deleted).toBe(true);

    const fetched = getCustomToolById(saved.id, db);
    expect(fetched).toBeNull();
  });

  it("returns false when deleting a non-existent tool", () => {
    const deleted = deleteCustomTool("ctool_nonexistent", db);
    expect(deleted).toBe(false);
  });

  it("throws validation error when saving invalid tool", () => {
    expect(() => {
      saveCustomTool({ ...sampleInput, name: "invalid name with spaces" }, undefined, db);
    }).toThrow();
  });

  it("throws error when updating a non-existent tool ID", () => {
    expect(() => {
      saveCustomTool(sampleInput, "ctool_nonexistent", db);
    }).toThrow(/not found/i);
  });

  it("handles empty or corrupted settings in listCustomTools", () => {
    setSettingsDb({ [CUSTOM_TOOLS_KEY]: "corrupted_non_array" }, db);
    expect(listCustomTools(db)).toEqual([]);

    setSettingsDb({
      [CUSTOM_TOOLS_KEY]: [
        null,
        123,
        { incomplete: true },
        {
          id: "ctool_valid",
          name: "valid_tool",
          description: "valid",
          enabled: true,
          schema: { type: "object" },
          execution: { type: "http", url: "https://example.com", method: "GET" },
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
    }, db);

    const tools = listCustomTools(db);
    expect(tools).toHaveLength(1);
    expect(tools[0].id).toBe("ctool_valid");
  });
});
