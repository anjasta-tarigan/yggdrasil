import { describe, it, expect } from "vitest";
import { runSmokeTest, ModelUnusableError } from "../smoke";

describe("runSmokeTest", () => {
  it("returns ok:false for a non-existent model without crashing the parent", async () => {
    const result = await runSmokeTest("/non/existent/model.onnx");
    expect(result.ok).toBe(false);
  });

  it("resolves to an object with ok:false and an error string", async () => {
    const result = await runSmokeTest("/non/existent/model.onnx");
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it("uses a configurable timeout", async () => {
    // A non-existent path fails fast; verify the timeout param is accepted.
    const result = await runSmokeTest("/non/existent/model.onnx", 10_000);
    expect(result.ok).toBe(false);
  });
});

describe("ModelUnusableError", () => {
  it("is an Error subclass with the correct name", () => {
    const err = new ModelUnusableError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ModelUnusableError");
    expect(err.message).toBe("test");
  });
});
