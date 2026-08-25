import { describe, expect, it } from "vitest";
import { formatErrorDetail } from "@/lib/ai/errors";
import { APICallError } from "ai";

describe("formatErrorDetail", () => {
  it("extracts message and code from APICallError with JSON responseBody", () => {
    const error = new APICallError({
      message: "Rate limit reached",
      url: "https://openrouter.ai/api/v1/chat/completions",
      statusCode: 429,
      requestBodyValues: {},
      responseBody: JSON.stringify({
        error: {
          message: "No available upstream providers for model",
          code: 429,
        },
      }),
    });

    expect(formatErrorDetail(error)).toBe(
      "No available upstream providers for model (429)"
    );
  });

  it("handles string error fields in JSON responseBody", () => {
    const error = new APICallError({
      message: "Bad Request",
      url: "https://api.example.com",
      statusCode: 400,
      requestBodyValues: {},
      responseBody: JSON.stringify({
        error: "Model is currently overloaded",
      }),
    });

    expect(formatErrorDetail(error)).toBe("Model is currently overloaded");
  });

  it("extracts message property from flat JSON responseBody", () => {
    const error = new APICallError({
      message: "Gateway Timeout",
      url: "https://api.example.com",
      statusCode: 504,
      requestBodyValues: {},
      responseBody: JSON.stringify({
        message: "Endpoint timed out",
      }),
    });

    expect(formatErrorDetail(error)).toBe("Endpoint timed out");
  });

  it("formats statusCode when responseBody is non-JSON or empty", () => {
    const error = new APICallError({
      message: "Payment Required",
      url: "https://api.example.com",
      statusCode: 402,
      requestBodyValues: {},
      responseBody: "",
    });

    expect(formatErrorDetail(error)).toBe("Payment Required (status: 402)");
  });

  it("handles nested Error.cause recursively", () => {
    const rootError = new Error("Failed to call upstream");
    rootError.cause = new APICallError({
      message: "Service Unavailable",
      url: "https://api.example.com",
      statusCode: 503,
      requestBodyValues: {},
      responseBody: JSON.stringify({
        error: { message: "All providers busy" },
      }),
    });

    expect(formatErrorDetail(rootError)).toBe(
      "Failed to call upstream: All providers busy"
    );
  });

  it("handles plain Error with string message", () => {
    expect(formatErrorDetail(new Error("Connection refused"))).toBe(
      "Connection refused"
    );
  });

  it("serializes raw plain objects instead of stringifying to [object Object]", () => {
    const rawObj = { error: { message: "Quota exceeded" } };
    expect(formatErrorDetail(rawObj)).toBe(
      JSON.stringify(rawObj)
    );
  });

  it("guards against literal [object Object] and Error: [object Object]", () => {
    expect(formatErrorDetail(new Error("[object Object]"))).toBe(
      "An unexpected upstream error occurred"
    );
    expect(formatErrorDetail("[object Object]")).toBe(
      "An unexpected upstream error occurred"
    );
  });

  it("handles null and undefined gracefully", () => {
    expect(formatErrorDetail(null)).toBe("Unknown error");
    expect(formatErrorDetail(undefined)).toBe("Unknown error");
  });
});
