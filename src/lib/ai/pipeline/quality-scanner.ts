/**
 * Internal Quality & Anti-Slop Evaluation Pipeline.
 *
 * Runs deterministically in sub-millisecond execution time on assistant output.
 * Bypasses trivial turns (pings, short greetings) and inspects both prose
 * and code blocks for common AI slop patterns without wasting LLM tokens.
 */

export interface QualityReport {
  /** False for trivial turns (short messages, pings), true when evaluation is meaningful */
  shouldDisplay: boolean;
  /** 0 = pure concise signal, 100 = heavy filler */
  score: number;
  /** Quality tier */
  tier: "clean" | "low" | "moderate" | "high";
  /** Human-readable verdict */
  summary: string;
  /** Top flagged vocabulary or structural patterns */
  flaggedPatterns: string[];
  /** Code-specific defects found in fenced blocks */
  codeIssues: string[];
  /** Signal percentage: 100 - score */
  signalPercent: number;
}

import {
  TIER_1_TERMS,
  TIER_2_TERMS,
  TIER_3_TERMS,
  BANNED_PHRASES,
  BUZZWORD_COLLOCATIONS,
  PARAGRAPH_OPENER_PATTERNS,
  STRUCTURAL_PATTERNS,
  CODE_DEFECT_PATTERNS,
} from "./quality-scanner.config";

const TIER_1_REGEXES = TIER_1_TERMS.map((term) => ({
  term,
  regex: new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"),
}));

const TIER_2_REGEXES = TIER_2_TERMS.map((term) => ({
  term,
  regex: new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"),
}));

const TIER_3_REGEXES = TIER_3_TERMS.map((term) => ({
  term,
  regex: new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"),
}));

// Banned phrase regexes — each phrase is escaped for safety.
const BANNED_PHRASE_REGEXES = BANNED_PHRASES.map((phrase) => ({
  phrase,
  regex: new RegExp(
    `\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`,
    "gi"
  ),
}));

/**
 * Detects whether 4+ paragraphs start with the same transition word.
 * Mirrors Wikipedia "Signs of AI writing" (transition-word cadences)
 * and Ozigi's paragraph-opener cadence pass.
 */
function detectParagraphOpenerCadence(text: string): boolean {
  const paragraphs = text
    .split(/\n\s*\n/)
    .filter((p) => p.trim().length > 0);

  // Match each pattern against the paragraph's opening text rather than a
  // single token: several openers are multi-word ("selain itu", "oleh karena
  // itu"), which a first-word lookup could never match.
  const counts = new Map<string, number>();
  for (const para of paragraphs) {
    // Lowercase, collapse whitespace, and strip leading punctuation so
    // "Additionally," matches "additionally".
    const opening = para.trim().replace(/^\s*[^\w]+/, "").toLowerCase();
    for (const pattern of PARAGRAPH_OPENER_PATTERNS) {
      const word = pattern.word.toLowerCase();
      if (opening.startsWith(word)) {
        // Guard against a prefix matching a longer word ("however" matching
        // "howevermuch") by requiring a word boundary after the opener.
        const rest = opening.slice(word.length);
        if (rest === "" || /^[^\w]/.test(rest)) {
          counts.set(word, (counts.get(word) ?? 0) + 1);
        }
      }
    }
  }

  return PARAGRAPH_OPENER_PATTERNS.some(
    (p) => (counts.get(p.word.toLowerCase()) ?? 0) >= 4
  );
}

/**
 * Evaluates message text with heuristic gating:
 * - Bypasses messages under 35 words or single short responses (pings, brief acknowledgments)
 * - Evaluates prose against tier 1 & 2 buzzwords and structural tells
 * - Inspects fenced code blocks for silent error suppression or placeholders
 */
export function evaluateMessageQuality(text: string): QualityReport {
  if (!text || text.trim().length === 0) {
    return {
      shouldDisplay: false,
      score: 0,
      tier: "clean",
      summary: "Short response",
      flaggedPatterns: [],
      codeIssues: [],
      signalPercent: 100,
    };
  }

  // Extract and remove fenced code blocks, inline code, and markdown link
  // targets before scanning prose — mirrors Ozigi's validator sanitization.
  // Without this, URLs containing banned words (e.g. "tapestry.example.com")
  // produce false positives.
  const codeBlocks: string[] = [];
  const cleanProse = text
    .replace(/```[\w-]*\n([\s\S]*?)```/g, (_, code) => {
      codeBlocks.push(code);
      return " ";
    })
    .replace(/`[^`]*?`/g, " ")                       // strip inline code
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")           // strip markdown images
    .replace(/\[[^\]]*\]\([^)]+\)/g, " ");            // strip markdown links

  const words = cleanProse.match(/\b\w+\b/g) ?? [];
  const wordCount = words.length;

  // Heuristic Pre-Gate: If output is very short (< 35 words), bypass analysis.
  // Pings, simple confirmations, single-line math, and brief direct commands do not need slop analysis.
  if (wordCount < 35 && codeBlocks.length === 0) {
    return {
      shouldDisplay: false,
      score: 0,
      tier: "clean",
      summary: "Concise direct reply",
      flaggedPatterns: [],
      codeIssues: [],
      signalPercent: 100,
    };
  }

  const flaggedPatterns: string[] = [];
  // Collect structural patterns first as they carry strongest intent signal.
  // Weighted 3× Tier 1: Ozigi and the Antislop paper confirm structural tells
  // (rhythm, "not just X, it's Y") are harder to miss and more diagnostic.
  let structuralCount = 0;
  for (const { regex, label } of STRUCTURAL_PATTERNS) {
    const matches = cleanProse.match(regex);
    if (matches && matches.length > 0) {
      structuralCount += matches.length;
      if (!flaggedPatterns.includes(label)) {
        flaggedPatterns.push(label);
      }
    }
  }

  let tier1Count = 0;
  for (const { term, regex } of TIER_1_REGEXES) {
    const matches = cleanProse.match(regex);
    if (matches && matches.length > 0) {
      tier1Count += matches.length;
      if (!flaggedPatterns.includes(term)) {
        flaggedPatterns.push(term);
      }
    }
  }

  let tier2Count = 0;
  for (const { term, regex } of TIER_2_REGEXES) {
    const matches = cleanProse.match(regex);
    if (matches && matches.length > 0) {
      tier2Count += matches.length;
      if (!flaggedPatterns.includes(term)) {
        flaggedPatterns.push(term);
      }
    }
  }

  // Tier 3: light signals — ordinary words that only count when clustered.
  // Weighted 0.3× Tier 1: SlopDetector tier 3 are "ordinary words, count
  // when they cluster." We track raw count for density-based scoring below.
  let tier3Count = 0;
  for (const { term, regex } of TIER_3_REGEXES) {
    const matches = cleanProse.match(regex);
    if (matches && matches.length > 0) {
      tier3Count += matches.length;
      if (!flaggedPatterns.includes(term)) {
        flaggedPatterns.push(term);
      }
    }
  }

  // Buzzword collocations: "phrases beat words" (SlopDetector).
  // Individual buzzwords may pass, but "robust framework" or "meaningful results"
  // are far stronger slop signals than the sum of their parts.
  let collocationCount = 0;
  for (const { pattern, label } of BUZZWORD_COLLOCATIONS) {
    const matches = cleanProse.match(pattern);
    if (matches && matches.length > 0) {
      collocationCount += matches.length;
      if (!flaggedPatterns.includes(label)) {
        flaggedPatterns.push(label);
      }
    }
  }

  // Banned phrases: multi-word opener/closer clichés that the Tier lists miss.
  // e.g., "in today's digital age", "let's dive into", "studies have shown".
  let phraseCount = 0;
  for (const { phrase, regex } of BANNED_PHRASE_REGEXES) {
    const matches = cleanProse.match(regex);
    if (matches && matches.length > 0) {
      phraseCount += matches.length;
      if (!flaggedPatterns.includes(phrase)) {
        flaggedPatterns.push(phrase);
      }
    }
  }

  // Paragraph opener cadence: 4+ paragraphs starting with the same connective.
  // Wikipedia "Signs of AI writing" flags "Additionally" as a signature
  // opener; the Antislop paper notes models fixate on specific words/phrases.
  // Ozigi's production validator has the same cadence detection for Gemini.
  const paragraphOpenerCadence = detectParagraphOpenerCadence(cleanProse);
  if (paragraphOpenerCadence) {
    const cadenceLabel =
      "paragraph opener cadence (4+ paragraphs with same leading connective)";
    if (!flaggedPatterns.includes(cadenceLabel)) {
      flaggedPatterns.push(cadenceLabel);
    }
  }

  // Inspect code blocks for anti-patterns
  const codeIssues: string[] = [];
  for (const code of codeBlocks) {
    for (const { regex, issue } of CODE_DEFECT_PATTERNS) {
      if (regex.test(code) && !codeIssues.includes(issue)) {
        codeIssues.push(issue);
      }
    }
  }

  // Weighted penalty calculations:
  //   structural  = 3× Tier 1 (18 * 3 = 54)
  //   collocation = 2× Tier 1 (18 * 2 = 36) — phrases are stronger than words
  //   phrase      = 1× Tier 1 (18)          — structural-ish opener clichés
  //   Tier 1      = 1× (18)
  //   Tier 2      = 0.5× Tier 1 (7) with -1 discount for common words
  //   Tier 3      = 0.3× Tier 1 (5)        — light signals, light penalty
  //   code issue  = 25 (unchanged, critical safety concern)
  const effectiveTier2 = Math.max(0, tier2Count - 1);
  const rawPoints =
    tier1Count * 18 +
    collocationCount * 36 +
    structuralCount * 54 +
    phraseCount * 18 +
    effectiveTier2 * 7 +
    tier3Count * 5 +
    codeIssues.length * 25;

  const denominator = Math.max(1, (wordCount + codeBlocks.length * 40) / 100);
  const score = Math.min(100, Math.round(rawPoints / denominator));
  const signalPercent = Math.max(0, 100 - score);

  let tier: QualityReport["tier"] = "clean";
  let summary = "High signal — direct and natural";

  if (score >= 60) {
    tier = "high";
    summary = "High formulaic phrasing or code placeholders detected";
  } else if (score >= 35) {
    tier = "moderate";
    summary = "Moderate buzzwords or generic template structures";
  } else if (score >= 15) {
    tier = "low";
    summary = "Minor formulaic markers present";
  }

  return {
    shouldDisplay: true,
    score,
    tier,
    summary,
    flaggedPatterns: flaggedPatterns.slice(0, 12),
    codeIssues,
    signalPercent,
  };
}
