import { describe, it, expect } from "vitest";
import { validateCustomToolConfig } from "../validation";
import type { CustomToolConfig } from "../types";

describe("validateCustomToolConfig", () => {
  const validConfig = {
    name: "fetch_weather",
    description: "Get weather for location",
    enabled: true,
    schema: {
      type: "object",
      properties: {
        city: { type: "string" },
      },
      required: ["city"],
    },
    execution: {
      type: "http" as const,
      url: "https://api.weather.test/v1/{city}",
      method: "GET" as const,
      timeoutMs: 5000,
    },
  };

  it("accepts valid tool configuration", () => {
    const result = validateCustomToolConfig(validConfig, []);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("fetch_weather");
      expect(result.data.execution.timeoutMs).toBe(5000);
    }
  });

  it("rejects invalid tool name format", () => {
    const result = validateCustomToolConfig({ ...validConfig, name: "bad name with spaces" }, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/name/i);
    }
  });

  it("rejects collision with built-in protected tools", () => {
    const result = validateCustomToolConfig({ ...validConfig, name: "ask_user_question" }, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/collides with a built-in protected tool/i);
    }
  });

  it("rejects collision with built-in chat tools", () => {
    const result = validateCustomToolConfig({ ...validConfig, name: "bash" }, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/collides with a built-in protected tool/i);
    }
  });

  it("rejects duplicate tool names", () => {
    const existing: CustomToolConfig[] = [
      {
        id: "ctool_1",
        name: "fetch_weather",
        description: "old",
        enabled: true,
        schema: { type: "object" },
        execution: { type: "http", url: "https://api.test", method: "GET" },
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const result = validateCustomToolConfig(validConfig, existing);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/already exists/i);
    }
  });

  it("allows same name when editing the existing tool (currentToolId match)", () => {
    const existing: CustomToolConfig[] = [
      {
        id: "ctool_1",
        name: "fetch_weather",
        description: "old",
        enabled: true,
        schema: { type: "object" },
        execution: { type: "http", url: "https://api.test", method: "GET" },
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const result = validateCustomToolConfig(validConfig, existing, { currentToolId: "ctool_1" });
    expect(result.ok).toBe(true);
  });

  it("rejects missing description", () => {
    const result = validateCustomToolConfig({ ...validConfig, description: "" }, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/description/i);
    }
  });

  it("rejects non-object input", () => {
    const result = validateCustomToolConfig("invalid string", []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/must be an object/i);
    }
  });

  it("rejects invalid JSON schema", () => {
    const result = validateCustomToolConfig({ ...validConfig, schema: "not an object" as any }, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/schema/i);
    }
  });

  it("rejects JSON schema without type object", () => {
    const result = validateCustomToolConfig(
      { ...validConfig, schema: { type: "string" } },
      []
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/type must be 'object'/i);
    }
  });

  it("rejects missing or invalid execution config", () => {
    const resultNoExec = validateCustomToolConfig({ ...validConfig, execution: undefined as any }, []);
    expect(resultNoExec.ok).toBe(false);
    if (!resultNoExec.ok) {
      expect(resultNoExec.error).toMatch(/execution/i);
    }

    const resultBadType = validateCustomToolConfig(
      { ...validConfig, execution: { type: "javascript", code: "return 1;" } },
      []
    );
    expect(resultBadType.ok).toBe(false);
    if (!resultBadType.ok) {
      expect(resultBadType.error).toMatch(/http/i);
    }
  });

  it("rejects invalid HTTP methods", () => {
    const result = validateCustomToolConfig(
      {
        ...validConfig,
        execution: {
          ...validConfig.execution,
          method: "INVALID" as any,
        },
      },
      []
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/invalid http method/i);
    }
  });

  it("rejects malformed URLs", () => {
    const result = validateCustomToolConfig(
      {
        ...validConfig,
        execution: {
          ...validConfig.execution,
          url: "not-a-url",
        },
      },
      []
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/invalid url/i);
    }
  });

  it("rejects URL template placeholders missing from schema properties", () => {
    const result = validateCustomToolConfig(
      {
        ...validConfig,
        execution: {
          ...validConfig.execution,
          url: "https://api.weather.test/v1/{unknown_param}",
        },
      },
      []
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/unknown_param/i);
    }
  });

  it("rejects non-https URLs unless allowLoopback in development", () => {
    const resultHttp = validateCustomToolConfig(
      {
        ...validConfig,
        execution: {
          ...validConfig.execution,
          url: "http://api.weather.test/v1/{city}",
        },
      },
      []
    );
    expect(resultHttp.ok).toBe(false);
    if (!resultHttp.ok) {
      expect(resultHttp.error).toMatch(/https/i);
    }

    const resultLoopbackDev = validateCustomToolConfig(
      {
        ...validConfig,
        execution: {
          ...validConfig.execution,
          url: "http://localhost:3000/api/{city}",
          allowLoopback: true,
        },
      },
      [],
      { isProduction: false }
    );
    expect(resultLoopbackDev.ok).toBe(true);

    const resultLoopbackProd = validateCustomToolConfig(
      {
        ...validConfig,
        execution: {
          ...validConfig.execution,
          url: "http://localhost:3000/api/{city}",
          allowLoopback: true,
        },
      },
      [],
      { isProduction: true }
    );
    expect(resultLoopbackProd.ok).toBe(false);
  });

  it("clamps timeout between 1000 and 30000 ms with 10000 ms default", () => {
    const noTimeout = validateCustomToolConfig(
      {
        ...validConfig,
        execution: {
          type: "http",
          url: "https://api.weather.test/v1/{city}",
          method: "GET",
        },
      },
      []
    );
    expect(noTimeout.ok).toBe(true);
    if (noTimeout.ok) expect(noTimeout.data.execution.timeoutMs).toBe(10000);

    const lowTimeout = validateCustomToolConfig(
      {
        ...validConfig,
        execution: {
          ...validConfig.execution,
          timeoutMs: 100,
        },
      },
      []
    );
    expect(lowTimeout.ok).toBe(true);
    if (lowTimeout.ok) expect(lowTimeout.data.execution.timeoutMs).toBe(1000);

    const highTimeout = validateCustomToolConfig(
      {
        ...validConfig,
        execution: {
          ...validConfig.execution,
          timeoutMs: 999999,
        },
      },
      []
    );
    expect(highTimeout.ok).toBe(true);
    if (highTimeout.ok) expect(highTimeout.data.execution.timeoutMs).toBe(30000);
  });

  it("filters and preserves string headers", () => {
    const withHeaders = validateCustomToolConfig(
      {
        ...validConfig,
        execution: {
          ...validConfig.execution,
          headers: {
            Authorization: "Bearer token123",
            "X-Custom": "test",
            invalid: 123 as any,
          },
        },
      },
      []
    );
    expect(withHeaders.ok).toBe(true);
    if (withHeaders.ok && withHeaders.data.execution.type === "http") {
      expect(withHeaders.data.execution.headers).toEqual({
        Authorization: "Bearer token123",
        "X-Custom": "test",
      });
    }
  });
});
