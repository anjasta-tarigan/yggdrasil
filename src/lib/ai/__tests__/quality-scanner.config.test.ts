import { describe, it, expect } from "vitest";
import {
  TIER_1_TERMS,
  TIER_2_TERMS,
  TIER_3_TERMS,
  BANNED_PHRASES,
  ANTI_AI_RULES,
} from "@/lib/ai/pipeline/quality-scanner.config";

describe("quality-scanner.config — drift guard", () => {
  it("TIER_1 includes SlopDetector kill-on-sight words", () => {
    expect(TIER_1_TERMS).toContain("delve");
    expect(TIER_1_TERMS).toContain("tapestry");
    expect(TIER_1_TERMS).toContain("underscores");
  });

  it("TIER_2 includes SlopDetector suspicious cluster words", () => {
    expect(TIER_2_TERMS).toContain("robust");
    expect(TIER_2_TERMS).toContain("enhance");
    expect(TIER_2_TERMS).toContain("optimize");
  });

  it("TIER_3 includes light signal words", () => {
    expect(TIER_3_TERMS).toContain("additionally");
    expect(TIER_3_TERMS).toContain("consequently");
    expect(TIER_3_TERMS).toContain("ultimately");
  });

  it("BANNED_PHRASES includes structural opener clichés", () => {
    // Phrases that already exist in STRUCTURAL_PATTERNS are intentionally
    // absent from BANNED_PHRASES (see comment in config) to avoid
    // double-counting. Only non-overlapping phrases are asserted here.
    expect(BANNED_PHRASES).toContain("let's dive into");
    expect(BANNED_PHRASES).toContain("when it comes to");
    expect(BANNED_PHRASES).toContain("in today's digital age");
    expect(BANNED_PHRASES).toContain("the key is to find balance");
    expect(BANNED_PHRASES).toContain("move the needle");
    expect(BANNED_PHRASES).not.toContain("in today's fast-paced world");
  });

  it("drift guard: every TIER_1_TERMS entry appears in ANTI_AI_RULES prose", () => {
    const prose = ANTI_AI_RULES.toLowerCase();
    for (const term of TIER_1_TERMS) {
      expect(
        prose.includes(term.toLowerCase()),
        `Term "${term}" missing from prose rules`
      ).toBe(true);
    }
  });

  it("drift guard: every TIER_2_TERMS entry appears in ANTI_AI_RULES prose", () => {
    const prose = ANTI_AI_RULES.toLowerCase();
    for (const term of TIER_2_TERMS) {
      expect(
        prose.includes(term.toLowerCase()),
        `Term "${term}" missing from prose rules`
      ).toBe(true);
    }
  });

  it("drift guard: every TIER_3_TERMS entry appears in ANTI_AI_RULES prose", () => {
    const prose = ANTI_AI_RULES.toLowerCase();
    for (const term of TIER_3_TERMS) {
      expect(
        prose.includes(term.toLowerCase()),
        `Term "${term}" missing from prose rules`
      ).toBe(true);
    }
  });

  it("drift guard: every BANNED_PHRASES entry appears in ANTI_AI_RULES prose", () => {
    const prose = ANTI_AI_RULES.toLowerCase();
    for (const phrase of BANNED_PHRASES) {
      expect(
        prose.includes(phrase.toLowerCase()),
        `Phrase "${phrase}" missing from prose rules`
      ).toBe(true);
    }
  });
});
