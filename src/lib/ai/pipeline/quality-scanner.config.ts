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
  // Indonesian Tier 1 — Kill on sight:
  "menyelami",
  "rajutan",
  "untaian",
  "menggarisbawahi",
  "bukti nyata dari",
  "bukti konkret",
  "multifaset",
  "batu penjuru",
  "titik tumpu",
  "fondasi utama",
  "panasea",
  "obat mujarab",
  "sinergi",
  "pergeseran paradigma",
  "pengubah permainan",
  "melepaskan kekuatan",
  "menavigasi kompleksitas",
  "memulai perjalanan",
  "memupuk pertumbuhan",
  "memanfaatkan kekuatan",
  "seluk-beluk",
  "dalam ranah",
  "mengkatalisasi",
  "mendobrak batasan",
  "membuka potensi",
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
  // Indonesian Tier 2 — Suspicious in clusters:
  "komprehensif",
  "mulus",
  "secara mulus",
  "revolusioner",
  "merevolusi",
  "terobosan",
  "mutakhir",
  "canggih",
  "inovatif",
  "memberdayakan",
  "pemberdayaan",
  "krusial",
  "vital",
  "tak ternilai",
  "tak tergantikan",
  "transformatif",
  "cermat",
  "secara cermat",
  "mendalam",
  "secara mendalam",
  "terus berkembang",
  "menggugah pikiran",
  "memikat",
  "mempesona",
  "memfasilitasi",
  "mengoptimalkan",
  "terukur",
  "disesuaikan",
  "memanfaatkan",
  "menavigasi",
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
  // Indonesian Tier 3 — Light signals:
  "selain itu",
  "lebih lanjut",
  "pada akhirnya",
  "secara mendasar",
  "pada dasarnya",
  "secara signifikan",
  "patut dicatat",
  "tentu saja",
  "tidak diragukan lagi",
  "oleh karena itu",
  "dengan demikian",
  "sangat penting",
  "faktor kunci",
];

// ── Banned phrases — multi-word constructions that give AI prose away ──────

export const BANNED_PHRASES: readonly string[] = [
  // NOTE: phrases that ALSO appear in STRUCTURAL_PATTERNS (e.g. "in today's
  // fast-paced world", "great question", "only time will tell") are intentionally
  // excluded here to prevent double-counting in rawPoints. STRUCTURAL_PATTERNS
  // carries the stronger weight (3× Tier 1).
  //
  // New from SlopDetector / Ozigi:
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
  // Sycophantic (non-overlapping with STRUCTURAL_PATTERNS):
  "you raise a really",
  "absolutely let me",
  // Indonesian Banned Phrases:
  "di era digital saat ini",
  "di era digital yang serba cepat",
  "dalam era digital yang serba cepat",
  "dalam dunia yang terus berkembang",
  "mari kita selami",
  "mari kita bedah",
  "mari kita jelajahi",
  "ketika berbicara tentang",
  "ketika menyangkut",
  "bayangkan sebuah dunia di mana",
  "pernahkah anda bertanya-tanya",
  "penelitian menunjukkan bahwa",
  "studi telah menunjukkan",
  "para ahli sepakat",
  "kuncinya adalah menemukan keseimbangan",
  "pada akhirnya pilihan ada di tangan anda",
  "hanya waktu yang akan menjawab",
  "penting untuk diingat bahwa",
  "penting untuk dicatat bahwa",
  "seperti yang telah disebutkan di atas",
  "sebagaimana disebutkan di atas",
  "untuk merangkum poin-poin penting",
  "memainkan peran penting dalam",
  "membawa ke tingkat berikutnya",
  "kemungkinannya tidak terbatas",
  "anda mengangkat poin yang sangat",
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
  // Indonesian Collocations:
  { pattern: /\bsolusi\s+(?:yang\s+)?komprehensif\b/i, label: "solusi komprehensif" },
  { pattern: /\bpendekatan\s+(?:yang\s+)?holistik\b/i, label: "pendekatan holistik" },
  { pattern: /\bintegrasi\s+(?:yang\s+)?mulus\b/i, label: "integrasi mulus" },
  { pattern: /\bekosistem\s+(?:yang\s+)?terus\s+berkembang\b/i, label: "ekosistem terus berkembang" },
  { pattern: /\btransformasi\s+digital\b/i, label: "transformasi digital" },
  { pattern: /\bhasil\s+yang\s+bermakna\b/i, label: "hasil yang bermakna" },
  { pattern: /\bpeningkatan\s+berkelanjutan\b/i, label: "peningkatan berkelanjutan" },
  { pattern: /\bfaktor\s+pendorong\s+utama\b/i, label: "faktor pendorong utama" },
  { pattern: /\blanskap\s+digital\b/i, label: "lanskap digital" },
  { pattern: /\blangkah\s+awal\s+yang\s+tepat\b/i, label: "langkah awal yang tepat" },
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
  // Indonesian Paragraph Openers:
  { word: "namun", label: "Namun," },
  { word: "selain itu", label: "Selain itu," },
  { word: "oleh karena itu", label: "Oleh karena itu," },
  { word: "lebih lanjut", label: "Lebih lanjut," },
  { word: "bahkan", label: "Bahkan," },
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
  // Indonesian Structural Patterns:
  { regex: /\bbukan hanya\b.{0,60}\b(?:tetapi|melainkan)\b/i, label: "kontras teatrikal (bukan hanya X, tapi Y)" },
  { regex: /\btidak hanya\b.{0,60}\b(?:tetapi juga|melainkan juga)\b/i, label: "tidak hanya X tetapi juga Y" },
  { regex: /\blebih dari sekadar\b/i, label: "lebih dari sekadar" },
  { regex: /\bdi era (?:digital\s+)?yang serba cepat\b/i, label: "di era yang serba cepat" },
  { regex: /\bdalam lanskap yang terus berkembang\b/i, label: "dalam lanskap yang terus berkembang" },
  { regex: /\bbayangkan sebuah dunia di mana\b/i, label: "bayangkan sebuah dunia di mana" },
  { regex: /\b(?:sangat\s+)?penting untuk (?:dicatat|diingat|dipahami) bahwa\b/i, label: "throat-clearing hedge (penting untuk dicatat bahwa)" },
  { regex: /\bperlu (?:diingat|dicatat|digarisbawahi) bahwa\b/i, label: "throat-clearing hedge (perlu diingat bahwa)" },
  { regex: /\bpatut (?:disebutkan|diingat) bahwa\b/i, label: "throat-clearing hedge (patut diingat bahwa)" },
  { regex: /\bpertanyaan yang (?:sangat\s+)?(?:bagus|menarik|tepat)\b/i, label: "sycophantic opener (pertanyaan yang bagus)" },
  { regex: /\btentu,?\s*(?:saya\s+akan\s+)?dengan senang hati membantu\b/i, label: "sycophantic opener (dengan senang hati membantu)" },
  { regex: /\bhanya waktu yang akan (?:menjawab|membuktikan)\b/i, label: "generic closing cliché (hanya waktu yang akan menjawab)" },
  { regex: /\bkemungkinannya (?:tidak|tak) terbatas\b/i, label: "generic closing cliché (kemungkinannya tidak terbatas)" },
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
