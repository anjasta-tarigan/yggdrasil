/**
 * Single source of truth for anti-slop pattern definitions.
 *
 * Mirrors the Ozigi architecture: prose rules + structured arrays live in one file,
 * with a dev-mode drift guard ensuring no entry is orphaned from the prose documentation.
 *
 * Sources:
 * - SlopDetector: https://slopdetector.org/blog/ai-words-list (Tier 1/2/3 taxonomy)
 * - Antislop Paper: https://arxiv.org/abs/2510.15061 (frequency analysis)
 * - Ozigi: https://ozigi.app/blog/stopping-ai-slop-in-production-banned-lexicon-validator
 * - Wikipedia: https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing
 */

// ── Tier 1: Kill on sight — almost never in unforced human writing ──────────

export const TIER_1_TERMS: readonly string[] = [
  // Existing terms migrated from quality-scanner.ts:
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
  // New additions from SlopDetector Tier 1:
  "utilize",
  "leverage",
  "encompass",
  "catalyze",
  "juxtapose",
  "epitomize",
  "unravel",
  "supercharge",
  "spearhead",
  "catapult",
  "conceptualize",
  "realm",
];

// ── Tier 2: Suspicious in clusters — promotional register ───────────────────

export const TIER_2_TERMS: readonly string[] = [
  // Existing terms migrated from quality-scanner.ts (utilize and leverage
  // promoted to Tier 1, their gerund forms retained here):
  "robust",
  "seamless",
  "seamlessly",
  "vibrant",
  "dynamic",
  "comprehensive",
  "streamline",
  "streamlined",
  "leveraging",
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
  // New additions from SlopDetector Tier 2:
  "enhance",
  "elevate",
  "optimize",
  "scalable",
  "intricate",
  "resonate",
  "cultivate",
  "bolster",
  "unprecedented",
  "compelling",
  "versatile",
  "unwavering",
  "unlock",
  "unveil",
  "craft",
  "hone",
  "tailor",
  "captivate",
  "amplify",
  "illuminate",
  "discern",
  "navigate", // standalone — distinct from "navigate the complexities" in Tier 1
];

// ── Tier 3: Light signals — ordinary words, only flag when clustered ───────

export const TIER_3_TERMS: readonly string[] = [
  "essential",
  "significant",
  "remarkable",
  "exceptional",
  "furthermore",
  "moreover",
  "additionally",
  "consequently",
  "nevertheless",
  "ultimately",
  "arguably",
  "indeed",
  "notably",
  "paramount",
  "pragmatic",
  "foundational",
  "strategic",
];

// ── Banned phrases — multi-word constructions that give AI prose away ──────

export const BANNED_PHRASES: readonly string[] = [
  // Existing structural patterns extracted as phrase strings:
  "in today's fast-paced world",
  "in the ever-evolving landscape",
  "imagine a world where",
  "it's not just",
  // New from SlopDetector:
  "in today's digital age",
  "in a world where",
  "let's dive into",
  "let's explore",
  "when it comes to",
  "picture this",
  "ever wondered",
  "studies have shown",
  "research suggests",
  "experts agree",
  "the data speaks for itself",
  "the key is to find balance",
  "at the end of the day",
  "it's important to remember",
  "for what seemed like an eternity",
  "little did he know",
  // Fake authority:
  "as mentioned above",
  "as discussed above",
  "to summarize the key points",
  // Wikipedia-rehash (from SlopDetector):
  "is defined as",
  "refers to the process of",
  "plays an important role in",
  "can be broadly categorized into",
  // Business-speak:
  "move the needle",
  "low-hanging fruit",
  "best practices",
  "take it to the next level",
  // Sycophantic:
  "great question",
  "you raise a really",
  "absolutely let me",
  // Closers:
  "ultimately, the choice is yours",
  "only time will tell",
  "the possibilities are endless",
];

// ── Buzzword collocations — "phrases beat words" (SlopDetector) ─────────────

export const BUZZWORD_COLLOCATIONS: readonly {
  pattern: RegExp;
  label: string;
}[] = [
  { pattern: /\brobust\s+(?:framework|solution|approach|system)\b/i, label: "robust ___" },
  { pattern: /\bmultifaceted\s+(?:approach|solution|strategy|framework)\b/i, label: "multifaceted ___" },
  { pattern: /\bseamless\s+(?:integration|experience|solution|transition)\b/i, label: "seamless ___" },
  { pattern: /\bever-evolving\s+(?:landscape|world|space|journey)\b/i, label: "ever-evolving ___" },
  { pattern: /\bdigital\s+(?:landscape|transformation|revolution|era)\b/i, label: "digital ___" },
  { pattern: /\bholistic\s+(?:approach|solution|view|framework)\b/i, label: "holistic ___" },
  { pattern: /\bparadigm\s+shift\b/i, label: "paradigm shift" },
  { pattern: /\bmeaningful\s+(?:results?|insights?|impact|difference)\b/i, label: "meaningful ___" },
  { pattern: /\bcontinuous\s+(?:improvement|integration|delivery|optimization)\b/i, label: "continuous ___" },
  { pattern: /\bkey\s+drivers?\b/i, label: "key driver" },
];

// ── Paragraph opener patterns — 4+ consecutive paragraphs starting with same
// connective. Wikipedia: "Additionally" is a signature paragraph-opener. ────

export const PARAGRAPH_OPENER_PATTERNS: readonly {
  word: string;
  label: string;
}[] = [
  { word: "however", label: "However," },
  { word: "furthermore", label: "Furthermore," },
  { word: "additionally", label: "Additionally," },
  { word: "moreover", label: "Moreover," },
  { word: "consequently", label: "Consequently," },
];

// ── Transition-word cadence patterns (lighter string list for quick lookups)

export const TRANSITION_CADENCE_PATTERNS: readonly string[] = [
  "however",
  "furthermore",
  "additionally",
  "moreover",
  "consequently",
];

// ── Structural patterns — regex-based sentence-level tells ─────────────────

export const STRUCTURAL_PATTERNS: readonly {
  regex: RegExp;
  label: string;
}[] = [
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

// ── Code-defect patterns — anti-patterns inside fenced code blocks ───────────

export const CODE_DEFECT_PATTERNS: readonly {
  regex: RegExp;
  issue: string;
}[] = [
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

// ── Prose documentation + dev-mode drift guard ─────────────────────────────

export const ANTI_AI_RULES = `## Anti-Slop Quality Rules

### Tier 1 — Kill on sight
Avoid these words: ${TIER_1_TERMS.join(", ")}.

### Tier 2 — Suspicious in clusters
Watch for: ${TIER_2_TERMS.join(", ")}.

### Tier 3 — Light signals (flag when clustered)
Be cautious with: ${TIER_3_TERMS.join(", ")}.

### Banned phrases
Flag these multi-word constructions: ${BANNED_PHRASES.join(", ")}.

### Buzzword collocations
Flag these phrase patterns (phrases beat words): ${BUZZWORD_COLLOCATIONS.map(
  (c) => c.label
).join(", ")}.

### Paragraph opener cadence
Watch for 4+ consecutive paragraphs starting with the same connective: ${PARAGRAPH_OPENER_PATTERNS.map(
  (p) => p.word
).join(", ")}.
`;

// Dev-mode drift guard: surfaces a console warning if any structured entry
// is missing from the ANTI_AI_RULES prose above. Catches accidental edits
// where a word is added to an array but forgotten in the documentation.
if (process.env.NODE_ENV !== "production") {
  const proseLower = ANTI_AI_RULES.toLowerCase();
  for (const term of [...TIER_1_TERMS, ...TIER_2_TERMS, ...TIER_3_TERMS]) {
    if (!proseLower.includes(term.toLowerCase())) {
      console.warn(
        `[anti-slop] term "${term}" missing from ANTI_AI_RULES prose`
      );
    }
  }
  for (const phrase of BANNED_PHRASES) {
    if (!proseLower.includes(phrase.toLowerCase())) {
      console.warn(
        `[anti-slop] phrase "${phrase}" missing from ANTI_AI_RULES prose`
      );
    }
  }
}
