/**
 * Real-time, lightweight AI Slop Scanner & Scoring Engine.
 *
 * Derived from empirical LLM tell studies (Paech et al., ICLR 2026 Antislop;
 * Format Bias study 2024; global rule 22-anti-slop.md).
 *
 * Fast enough to run during live message streaming (sub-millisecond regex checks).
 */

export interface SlopScoreResult {
  /** 0 to 100 score. 0 = pure concise signal, 100 = heavy AI filler / slop */
  score: number;
  /** Quality badge tier: 'clean' (0-15), 'low' (16-35), 'moderate' (36-65), 'high' (66+) */
  tier: "clean" | "low" | "moderate" | "high";
  /** Word count analyzed */
  wordCount: number;
  /** Summary of detections for tooltip breakdown */
  detections: {
    tier1Count: number;
    tier1Matches: string[];
    tier2Count: number;
    tier2Matches: string[];
    structuralCount: number;
    structuralMatches: string[];
    formattingExcess: boolean;
  };
  /** Human-readable explanation */
  summary: string;
}

// Tier 1: High confidence markers — rare in unforced direct human speech
const TIER_1_TERMS: string[] = [
  "delve",
  "delving",
  "tapestry",
  "underscore",
  "underscores",
  "underscoring",
  "testament to",
  "multifaceted",
  "multifarious",
  "kaleidoscope",
  "myriad of",
  "plethora",
  "cornerstone",
  "bedrock",
  "linchpin",
  "panacea",
  "holistic",
  "synergy",
  "paradigm shift",
  "game-changer",
  "game changer",
  "unleash",
  "navigate the complexities",
  "embark on a journey",
  "foster growth",
  "harness the power",
  "intricacies",
  "in the realm of",
];

// Tier 2: Fluff / promotional register — suspicious when clustering
const TIER_2_TERMS: string[] = [
  "robust",
  "seamless",
  "seamlessly",
  "vibrant",
  "dynamic",
  "comprehensive",
  "streamline",
  "streamlined",
  "leverage",
  "leveraging",
  "utilize",
  "utilizing",
  "facilitate",
  "pivotal",
  "crucial",
  "vital",
  "invaluable",
  "indispensable",
  "transformative",
  "revolutionize",
  "revolutionary",
  "groundbreaking",
  "cutting-edge",
  "state-of-the-art",
  "innovative",
  "empower",
  "empowering",
  "meticulous",
  "meticulously",
  "profound",
  "profoundly",
  "ever-evolving",
  "ever-changing",
  "thought-provoking",
  "awe-inspiring",
  "captivating",
  "bespoke",
];

// Structural phrase patterns (theatrical contrasts, hedges, sycophancy)
const STRUCTURAL_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /\bit'?s not just\b.{0,60}\bit'?s\b/i, label: "it's not just X, it's Y" },
  { regex: /\bnot only\b.{0,60}\bbut\b/i, label: "not only X but Y" },
  { regex: /\bmore than just\b/i, label: "more than just" },
  { regex: /\bin today'?s fast-paced world\b/i, label: "in today's fast-paced world" },
  { regex: /\bin the ever-evolving landscape\b/i, label: "in the ever-evolving landscape" },
  { regex: /\bimagine a world where\b/i, label: "imagine a world where" },
  { regex: /\bit is important to note that\b/i, label: "it is important to note that" },
  { regex: /\bit is worth mentioning that\b/i, label: "it is worth mentioning that" },
  { regex: /\bit should be noted that\b/i, label: "it should be noted that" },
  { regex: /\bone must consider\b/i, label: "one must consider" },
  { regex: /\bultimately,? the choice is yours\b/i, label: "ultimately the choice is yours" },
  { regex: /\bonly time will tell\b/i, label: "only time will tell" },
  { regex: /\bgreat question\b/i, label: "great question (sycophancy)" },
  { regex: /\byou raise a? ?(really)? ?(great|interesting|valid) point\b/i, label: "validating opener" },
  { regex: /\bthe possibilities are endless\b/i, label: "the possibilities are endless" },
];

// Pre-compile regexes for optimal sub-millisecond execution
const TIER_1_REGEXES = TIER_1_TERMS.map((term) => ({
  term,
  regex: new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"),
}));

const TIER_2_REGEXES = TIER_2_TERMS.map((term) => ({
  term,
  regex: new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"),
}));

/**
 * Evaluates prose text and returns a granular SlopScoreResult.
 * Safe for real-time keystroke/streaming evaluation.
 */
export function analyzeAiSlop(text: string): SlopScoreResult {
  if (!text || text.trim().length === 0) {
    return {
      score: 0,
      tier: "clean",
      wordCount: 0,
      detections: {
        tier1Count: 0,
        tier1Matches: [],
        tier2Count: 0,
        tier2Matches: [],
        structuralCount: 0,
        structuralMatches: [],
        formattingExcess: false,
      },
      summary: "Clean — high signal prose",
    };
  }

  // Strip fenced code blocks and inline code to only evaluate prose text
  const cleanProse = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*?`/g, " ");

  const words = cleanProse.match(/\b\w+\b/g) ?? [];
  const wordCount = Math.max(words.length, 1);

  // 1. Match Tier 1 terms
  let tier1Count = 0;
  const tier1Matches: string[] = [];
  for (const { term, regex } of TIER_1_REGEXES) {
    const matches = cleanProse.match(regex);
    if (matches && matches.length > 0) {
      tier1Count += matches.length;
      if (!tier1Matches.includes(term)) {
        tier1Matches.push(term);
      }
    }
  }

  // 2. Match Tier 2 terms
  let tier2Count = 0;
  const tier2Matches: string[] = [];
  for (const { term, regex } of TIER_2_REGEXES) {
    const matches = cleanProse.match(regex);
    if (matches && matches.length > 0) {
      tier2Count += matches.length;
      if (!tier2Matches.includes(term)) {
        tier2Matches.push(term);
      }
    }
  }

  // 3. Match Structural phrases
  let structuralCount = 0;
  const structuralMatches: string[] = [];
  for (const { regex, label } of STRUCTURAL_PATTERNS) {
    const matches = cleanProse.match(regex);
    if (matches && matches.length > 0) {
      structuralCount += matches.length;
      if (!structuralMatches.includes(label)) {
        structuralMatches.push(label);
      }
    }
  }

  // 4. Formatting ratio (bold spam / excessive bullets in short answers)
  const lines = cleanProse.split("\n").filter((l) => l.trim().length > 0);
  const bulletLines = lines.filter((l) => /^\s*[-*+]\s+/.test(l)).length;
  const boldSpans = (cleanProse.match(/\*\*[^*]+\*\*/g) ?? []).length;
  const bulletRatio = lines.length > 0 ? bulletLines / lines.length : 0;

  const formattingExcess =
    (wordCount < 150 && bulletRatio > 0.6 && lines.length >= 4) ||
    (wordCount < 100 && boldSpans >= 4);

  // Compute weighted penalty points normalized per 100 words
  // - Tier 1: 18 points per instance
  // - Structural phrases: 20 points per instance
  // - Tier 2: 7 points per instance (if > 1 hit, single hit is tolerated)
  // - Formatting excess: 15 points
  const effectiveTier2Hits = Math.max(0, tier2Count - 1);
  const rawPoints =
    tier1Count * 18 +
    structuralCount * 20 +
    effectiveTier2Hits * 7 +
    (formattingExcess ? 15 : 0);

  // Scale relative to word count with lower dampening for very short text
  const scaleFactor = Math.max(1, wordCount / 120);
  const normalizedScore = Math.min(100, Math.round(rawPoints / scaleFactor));

  let tier: SlopScoreResult["tier"] = "clean";
  let summary = "High signal — direct and natural";

  if (normalizedScore >= 66) {
    tier = "high";
    summary = "High AI filler / formulaic phrasing detected";
  } else if (normalizedScore >= 36) {
    tier = "moderate";
    summary = "Moderate buzzwords or generic template structures";
  } else if (normalizedScore >= 16) {
    tier = "low";
    summary = "Slight formulaic markers present";
  }

  return {
    score: normalizedScore,
    tier,
    wordCount,
    detections: {
      tier1Count,
      tier1Matches,
      tier2Count,
      tier2Matches,
      structuralCount,
      structuralMatches,
      formattingExcess,
    },
    summary,
  };
}
