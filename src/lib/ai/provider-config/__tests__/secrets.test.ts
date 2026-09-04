import { describe, it, expect } from "vitest";
import { deriveEnvName, parseSecretsEnv, serializeSecretsEnv } from "@/lib/ai/provider-config/secrets";

describe("deriveEnvName", () => {
  it("uppercases and sanitizes", () => { expect(deriveEnvName("my-provider")).toBe("PROVIDER_MY_PROVIDER_API_KEY"); });
  it("handles dots and caps", () => { expect(deriveEnvName("Server")).toBe("PROVIDER_SERVER_API_KEY"); });
});
describe("parse/serialize round-trip", () => {
  it("parses KEY=VALUE, ignores comments/blanks, preserves quoted values", () => {
    const m = parseSecretsEnv("# comment\nPROVIDER_X_API_KEY=sk-123\n\nPROVIDER_Y_API_KEY=\"a=b\"\n");
    expect(m.get("PROVIDER_X_API_KEY")).toBe("sk-123");
    expect(m.get("PROVIDER_Y_API_KEY")).toBe("a=b");
  });
  it("serializes deterministically", () => {
    const m = new Map([["B","2"],["A","1"]]);
    expect(serializeSecretsEnv(m)).toBe("A=1\nB=2\n");
  });
});
