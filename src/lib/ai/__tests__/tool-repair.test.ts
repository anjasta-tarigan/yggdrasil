import { describe, it, expect } from "vitest";
import { repairToolCallInput } from "../tool-repair";
import type { JSONSchema7 } from "ai";

const parallelSearchSchema: JSONSchema7 = {
  type: "object",
  properties: {
    objective: { type: "string" },
    search_queries: { type: "array", items: { type: "string" } },
    session_id: { type: "string" },
  },
  required: ["objective", "search_queries"],
  additionalProperties: false,
};

const call = (input: Record<string, unknown>) =>
  JSON.stringify(input);

describe("repairToolCallInput", () => {
  it("wraps a single string into the required array", () => {
    const out = repairToolCallInput(
      { toolCallId: "c1", toolName: "parallel-search__web_search", input: call({ objective: "test mcp", search_queries: "gold price" }) },
      parallelSearchSchema
    );
    expect(out).not.toBeNull();
    expect(JSON.parse(out!.input)).toEqual({
      objective: "test mcp",
      search_queries: ["gold price"],
    });
    expect(out!.toolCallId).toBe("c1");
    expect(out!.toolName).toBe("parallel-search__web_search");
  });

  it("splits a comma-separated string into array entries", () => {
    const out = repairToolCallInput(
      { toolCallId: "c1", toolName: "t", input: call({ search_queries: "gold price, silver price" }) },
      parallelSearchSchema
    );
    expect(JSON.parse(out!.input)).toEqual({
      search_queries: ["gold price", "silver price"],
    });
  });

  it("splits a newline-separated string into array entries", () => {
    const out = repairToolCallInput(
      { toolCallId: "c1", toolName: "t", input: call({ search_queries: "gold price\nsilver price\nplatinum" }) },
      parallelSearchSchema
    );
    expect(JSON.parse(out!.input)).toEqual({
      search_queries: ["gold price", "silver price", "platinum"],
    });
  });

  it("coerces a number sent for a string field", () => {
    const out = repairToolCallInput(
      { toolCallId: "c1", toolName: "t", input: call({ session_id: 12345 }) },
      parallelSearchSchema
    );
    expect(JSON.parse(out!.input)).toEqual({ session_id: "12345" });
  });

  it("leaves a correct array untouched (no repair)", () => {
    const out = repairToolCallInput(
      { toolCallId: "c1", toolName: "t", input: call({ search_queries: ["a", "b"] }) },
      parallelSearchSchema
    );
    expect(out).toBeNull();
  });

  it("returns null for non-JSON input", () => {
    const out = repairToolCallInput(
      { toolCallId: "c1", toolName: "t", input: "not json {" },
      parallelSearchSchema
    );
    expect(out).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    const out = repairToolCallInput(
      { toolCallId: "c1", toolName: "t", input: "[1,2,3]" },
      parallelSearchSchema
    );
    expect(out).toBeNull();
  });

  it("returns null when the value cannot be coerced (nested object for array)", () => {
    const out = repairToolCallInput(
      { toolCallId: "c1", toolName: "t", input: call({ search_queries: { deep: "nope" } }) },
      parallelSearchSchema
    );
    expect(out).toBeNull();
  });

  it("returns null when schema has no properties", () => {
    const out = repairToolCallInput(
      { toolCallId: "c1", toolName: "t", input: call({ anything: "x" }) },
      { type: "object" }
    );
    expect(out).toBeNull();
  });
});
