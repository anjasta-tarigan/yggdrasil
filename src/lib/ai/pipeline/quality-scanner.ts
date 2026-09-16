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

const STRUCTURAL_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /\bit'?s not just\b.{0,60}\bit'?s\b/i, label: "theatrical contrast (not just X, it's Y)" },
  { regex: /\bnot only\b.{0,60}\bbut\b/i, label: "not only X but Y" },
  { regex: /\bmore than just\b/i, label: "more than just" },
  { regex: /\bin today'?s fast-paced world\b/i, label: "in today's fast-paced world" },
  { regex: /\bin the ever-evolving landscape\b/i, label: "in the ever-evolving landscape" },
  { regex: /\bimagine a world where\b/i, label: "imagine a world where" },
  { regex: /\bit is important to note that\b/i, label: "throat-clearing hedge" },
  { regex: /\bit is worth mentioning that\b/i, label: "throat-clearing hedge" },
  { regex: /\bit should be noted that\b/i, label: "throat-clearing hedge" },
  { regex: /\bone must consider\b/i, label: "throat-clearing hedge" },
  { regex: /\bultimately,? the choice is yours\b/i, label: "generic closing cliché" },
  { regex: /\bonly time will tell\b/i, label: "generic closing cliché" },
  { regex: /\bgreat question\b/i, label: "sycophantic opener" },
  { regex: /\byou raise a? ?(really)? ?(great|interesting|valid) point\b/i, label: "validating opener" },
  { regex: /\bthe possibilities are endless\b/i, label: "generic closing cliché" },
];

const CODE_DEFECT_PATTERNS: Array<{ regex: RegExp; issue: string }> = [
  {
    regex: /catch\s*\([^)]*\)\s*\{\s*\}/,
    issue: "Empty catch block (silent error suppression)",
  },
  {
    regex: /\/\/\s*TODO:\s*(implement|add\s+code|finish)/i,
    issue: "Unimplemented TODO placeholder",
  },
  {
    regex: /\/\/\s*Add\s+your\s+code\s+here/i,
    issue: "Generic placeholder comment",
  },
];

const TIER_1_REGEXES = TIER_1_TERMS.map((term) => ({
  term,
  regex: new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"),
}));

const TIER_2_REGEXES = TIER_2_TERMS.map((term) => ({
  term,
  regex: new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"),
}));

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
  // Collect structural patterns first as they carry strongest intent signal
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

  // Inspect code blocks for anti-patterns
  const codeIssues: string[] = [];
  for (const code of codeBlocks) {
    for (const { regex, issue } of CODE_DEFECT_PATTERNS) {
      if (regex.test(code) && !codeIssues.includes(issue)) {
        codeIssues.push(issue);
      }
    }
  }

  // Penalty calculations
  const effectiveTier2 = Math.max(0, tier2Count - 1);
  const rawPoints =
    tier1Count * 18 +
    structuralCount * 20 +
    effectiveTier2 * 7 +
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
    flaggedPatterns: flaggedPatterns.slice(0, 4),
    codeIssues,
    signalPercent,
  };
}
