import { describe, it, expect } from "vitest";
import { estimateTokens, truncateToTokenBudget } from "../catalog";

describe("Language-aware token estimation", () => {
  it("estimates English at ~4 chars/token", () => {
    const en = "The quick brown fox jumps over the lazy dog";
    expect(estimateTokens(en)).toBe(Math.ceil(en.length / 4));
  });

  it("estimates Indonesian with higher chars/token (detected via common words)", () => {
    // Indonesian-specific words trigger 6 chars/token ratio
    const idText = "Saya ingin belajar tentang teknologi AI ini";
    const enEquivalent = "I want to learn about this AI technology";
    // Same semantic length, but Indonesian has ~6 chars/token vs English ~4
    expect(estimateTokens(idText)).toBeLessThan(Math.ceil(idText.length / 4));
    // English should be exactly chars/4
    expect(estimateTokens(enEquivalent)).toBe(Math.ceil(enEquivalent.length / 4));
  });

  it("estimates CJK at ~2.5 chars/token", () => {
    const cjk = "これはテスト用の日本語テキストです";
    const nonAscii = (cjk.match(/[^\u0000-\u007F]/g) ?? []).length;
    expect(nonAscii / cjk.length).toBeGreaterThan(0.3);
    expect(estimateTokens(cjk)).toBe(Math.ceil(cjk.length / 2.5));
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates very short strings without division errors", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("Hi")).toBe(1);
  });
});

describe("Edge-aware truncation", () => {
  it("truncates on sentence boundary when possible (Indonesian)", () => {
    // ~220 chars with Indonesian stopwords → ~37 tokens. Budget 25 → remaining=25 > 20.
    const items = [
      "Kalimat pertama tentang EMP yang cukup panjang untuk memaksa truncation di sini agar sistem benar-benar harus memotongnya. Kalimat kedua juga panjang sekali untuk memastikan truncation terjadi di tepi kalimat.",
    ];
    const result = truncateToTokenBudget(items, 25);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("... [truncated]");
    // Should cut at sentence boundary (the "." before "Kalimat kedua"), not mid-word
    expect(result[0]).toContain("EMP");
    expect(result[0]).not.toContain("Kalimat kedua");
  });

  it("truncates on newline boundary for markdown content", () => {
    // 150+ chars, English → ~38 tokens. Budget 40 → truncates.
    const items = [
      "# Heading\n\nThis is the first paragraph with enough content to matter here.\n\nSecond paragraph also has substantial content that we want to keep separate.\n\nThird paragraph rounds out the content for this test case.",
    ];
    const result = truncateToTokenBudget(items, 40);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("... [truncated]");
  });

  it("falls back to mid-string cut when no boundary exists", () => {
    // 200 chars, all ASCII no stopwords → ~50 tokens. Budget 25 → remaining=25 > 20.
    const items = [
      "xkbqzmxncbvpqwrtsdfghjklzxcvbnmqwertyuiopasdfghjklzxcvbnmqwertyuiopasdfghjklzxcvbnmqwertyuiopasdfghjklzxcvbnmqwertyuiopasdfghjklzxcvbnmqwertyuiopasdfghjklzxcvbnm",
    ];
    const result = truncateToTokenBudget(items, 25);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("... [truncated]");
  });

  it("keeps full item when within budget", () => {
    const items = ["Short item within budget"];
    const result = truncateToTokenBudget(items, 1000);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("Short item within budget");
  });

  it("stops after first item that exceeds remaining budget", () => {
    const items = ["short", "x".repeat(500), "short2"];
    const result = truncateToTokenBudget(items, 30);
    // "short" fits (1 token), then 500-char item is ~125 tokens, remaining ~29 > 20 → truncated
    // "short2" would be next but break already happened
    expect(result).toHaveLength(2);
    expect(result[1]).toContain("... [truncated]");
  });
});
