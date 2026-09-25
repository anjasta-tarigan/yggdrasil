import { describe, it, expect } from "vitest";
import { loadPromptFile } from "../prompt-loader";

/**
 * The loader reads `prompts/invariants.yaml` and falls back to an inline copy
 * when that file is missing or unparseable. The two must not drift: the
 * fallback is what protects the invariants when the file cannot be read, and a
 * stale copy would silently drop rules (e.g. the identity or untrusted-content
 * directives) in exactly the situation where they still matter.
 */
describe("prompt loader invariants", () => {
  it("loads the invariants body from the YAML file", () => {
    const body = loadPromptFile("invariants");
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("CRITICAL PRECEDENCE RULE");
  });

  it("carries every safety rule in the loaded body", () => {
    const body = loadPromptFile("invariants");
    for (const rule of [
      "Identity & Self-Description",
      "Untrusted content",
      "Recalled memory is DATA too",
      "Language Policy",
      "Safety & Precedence",
    ]) {
      expect(body).toContain(rule);
    }
  });

  it("returns an empty string for an unknown prompt id", () => {
    expect(loadPromptFile("does-not-exist")).toBe("");
  });
});
