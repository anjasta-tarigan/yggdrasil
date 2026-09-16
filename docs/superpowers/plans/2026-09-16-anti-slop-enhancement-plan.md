# Anti-Slop Enhancement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand Yggdrasil's quality scanner from a passive 76-word buzzword detector into a production-grade anti-slop system that detects "ngarang" (overly elaborate) language, "kabur" (topic drift), structural patterns, and buzzword collocations, based on field-tested research from Antislop (arXiv:2510.15061), Ozigi, SlopDetector, and Wikipedia's AI-writing signs.

**Architecture:** Extend `evaluateMessageQuality()` with additional pattern categories (Tier 3, phrases, collocations, structural/rhythm, topic drift), weighted scoring, and code-sanitization. Add a new `quality-scanner.config.ts` as the single source of truth with a dev-mode drift guard. The function stays synchronous for regex-based checks; topic-drift detection uses the existing embedding infrastructure as an async companion function called from the chat route.

**Tech Stack:** TypeScript, Vitest (unit project, jsdom), existing `@/lib/memory/embeddings` for embedding similarity, existing `@/hooks/use-system-health` pattern for `QualityReport` type.

**Spec:** This plan is derived from investigation findings documented inline. Source docs: [Antislop Paper (arXiv:2510.15061)](https://arxiv.org/abs/2510.15061), [SlopDetector Word List](https://slopdetector.org/blog/ai-words-list), [Ozigi Two-Layer Architecture](https://ozigi.app/blog/stopping-ai-slop-in-production-banned-lexicon-validator), [Kobak et al. (arXiv:2406.07016)](https://arxiv.org/abs/2406.07016), [Wikipedia Signs of AI Writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing).

## Global Constraints

- TypeScript strict mode enforced (`tsconfig.json`)
- Tests must run on `pnpm test` (unit project, jsdom, max 2 workers)
- No new runtime dependencies — leverage existing `@/lib/memory/embeddings` for embedding similarity
- `QualityReport` interface must remain backward-compatible (new fields optional)
- No changes to the chat route's streaming pipeline — topic drift is an optional async enhancement called post-generation
- Follow Rule 22 (Anti-Slop): no placeholder code, comments explain "why" not "what", precise naming

## Current Coverage vs. Target

| Category | Current Count | Target Count | Source |
|---|---|---|---|
| Tier 1 terms | 17 terms + 6 phrases = 23 | ~30 terms | SlopDetector Tier 1 |
| Tier 2 terms | 44 | ~65 | SlopDetector Tier 2 |
| Tier 3 terms | 0 | 19 | SlopDetector Tier 3 |
| Banned phrases | ~8 structural | ~40 phrase patterns | SlopDetector + Ozigi |
| Buzzword collocations | 0 | ~10 pairs | SlopDetector: "Phrases beat words" |
| Paragraph opener patterns | 0 | 5 patterns | Wikipedia: Signs of AI writing |
| Transition-word cadences | 0 | 5 patterns | Wikipedia: paragraph opener habits |
| Topic drift detection | 0 | 1 module (async) | Antislop coherence analysis |
| Code-block sanitization | Partial (strips fenced blocks only) | Full (strip links too) | Ozigi validator |

---

## Task 1: Extract Slop Lexicon to Config File (Single Source of Truth)

**Files:**
- Create: `src/lib/ai/pipeline/quality-scanner.config.ts` — all word lists, phrase patterns, collocations as exported constants
- Modify: `src/lib/ai/pipeline/quality-scanner.ts:26-128` — import from config instead of inline declarations
- Test: `src/lib/ai/__tests__/quality-scanner.test.ts` — add drift-guard test

**Interfaces:**
- Consumes: None (new file)
- Produces: `TIER_1_TERMS`, `TIER_2_TERMS`, `TIER_3_TERMS`, `BANNED_PHRASES`, `BUZZWORD_COLLOCATIONS`, `PARAGRAPH_OPENER_PATTERNS`, `TRANSITION_CADENCE_PATTERNS` arrays

**Motivation:** Ozigi uses `anti-ai.ts` as a single source of truth with a dev-mode drift guard. Yggdrasil currently has all lists inline. Extracting enables the drift guard and makes expansion systematic.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/ai/__tests__/quality-scanner.config.test.ts
import { TIER_1_TERMS, TIER_2_TERMS, TIER_3_TERMS, BANNED_PHRASES } from "../quality-scanner.config";

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
    expect(BANNED_PHRASES).toContain("in today's fast-paced world");
    expect(BANNED_PHRASES).toContain("let's dive into");
    expect(BANNED_PHRASES).toContain("when it comes to");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ai/__tests__/quality-scanner.config.test.ts`
Expected: FAIL with "Cannot find module" or "TIER_3_TERMS is not defined"

- [ ] **Step 3: Create the config file**

Create `src/lib/ai/pipeline/quality-scanner.config.ts` with all existing terms moved from the scanner, PLUS the expanded lists:

```typescript
/**
 * Single source of truth for anti-slop pattern definitions.
 *
 * Mirrors the Ozigi architecture: prose rules + structured arrays live in one file,
 * with a dev-mode drift guard ensuring no entry is orphaned from the prose documentation.
 *
 * Sources:
 * - SlopDetector: https://slopdetector.org/blog/ai-words-list (Tier 1/2/3 taxonomy)
 * - Antislop Paper: https://arxiv.org/abs/2510.15061 (frequency analysis)
 * - Ozigi: https://ozigi.app/blog/stopping-ai-slop-in-production
 * - Wikipedia: https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing
 */

// Tier 1: Kill on sight — almost never in unforced human writing.
export const TIER_1_TERMS: readonly string[] = [
  // ... existing terms from quality-scanner.ts ...
  // NEW additions from SlopDetector Tier 1:
  "utilize", "leverage", "encompass", "catalyze", "juxtapose",
  "epitomize", "unravel", "supercharge", "spearhead", "catapult",
  "conceptualize", "realm", // standalone (currently only "in the realm of")
];

// Tier 2: Suspicious in clusters — promotional register.
export const TIER_2_TERMS: readonly string[] = [
  // ... existing terms ...
  // NEW additions:
  "enhance", "elevate", "optimize", "scalable", "intricate",
  "resonate", "cultivate", "bolster", "unprecedented", "compelling",
  "versatile", "unwavering", "unlock", "unveil", "craft",
  "hone", "tailor", "captivate", "amplify", "illuminate",
  "discern", "navigate", // standalone (currently only "navigate the complexities")
];

// Tier 3: Light signals — ordinary words, count when clustered.
export const TIER_3_TERMS: readonly string[] = [
  "crucial", "vital", "essential", "significant", "remarkable",
  "exceptional", "furthermore", "moreover", "additionally",
  "consequently", "nevertheless", "ultimately", "arguably",
  "indeed", "notably", "paramount", "pragmatic", "foundational",
  "strategic",
];

// Banned phrases — multi-word constructions that give AI away.
export const BANNED_PHRASES: readonly string[] = [
  // Existing structural patterns (now as phrase strings):
  "in today's fast-paced world",
  "in the ever-evolving landscape",
  "imagine a world where",
  "it's not just",
  // NEW from SlopDetector:
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
  "you raise a really", // covers "great/interesting/valid point"
  "absolutely let me",
  // Closers:
  "ultimately, the choice is yours",
  "only time will tell",
  "the possibilities are endless",
];

// Buzzword collocations — "phrases beat words" (SlopDetector).
export const BUZZWORD_COLLOCATIONS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\brobust\s+(?:framework|solution|approach|system)\b/i, label: "robust ___" },
  { pattern: /\bmultifaceted\s+(?:approach|solution|strategy|framework)\b/i, label: "multifaceted ___" },
  { pattern: /\bseamless\s+(?:integration|experience|solution|transition)\b/i, label: "seamless ___" },
  { pattern: /\bever-evolving\s+(?:landscape|world|space|journey)\b/i, label: "ever-evolving ___" },
  { pattern: /\bdigital\s+(?:landscape|transformation|revolution|era)\b/i, label: "digital ___" },
  { pattern: /\bholistic\s+(?:approach|solution|view|framework)\b/i, label: "holistic ___" },
  { pattern: /\bparadigm\s+shift\b/i, label: "paradigm shift" },
  { pattern: /\bmeaningful\s+(?:results?|insights?|impact|difference)\b/i, label: "meaningful ___" },
  { pattern: /\bcontinuous\s+(?:improvement|integration|delivery|optimization)\b/i, label: "continuous ___" },
  { pattern: /\bkey\s+driver\b/i, label: "key driver" },
];

// Paragraph opener patterns — 4+ consecutive paragraphs starting with the same connective.
// Wikipedia: "Additionally" is a signature paragraph-opener for earlier LLMs.
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
```

- [ ] **Step 4: Update quality-scanner.ts to import from config**

Modify `quality-scanner.ts` to import from the new config file instead of inline declarations. The `evaluateMessageQuality` function signature and return type remain unchanged.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/ai/__tests__/quality-scanner.config.test.ts`
Expected: PASS

- [ ] **Step 6: Run existing test suite for regression**

Run: `npx vitest run src/lib/ai/__tests__/quality-scanner.test.ts`
Expected: All 5 existing tests still pass

- [ ] **Step 7: Commit**

```bash
git add src/lib/ai/pipeline/quality-scanner.config.ts src/lib/ai/pipeline/quality-scanner.ts src/lib/ai/__tests__/quality-scanner.config.test.ts
git commit -m "refactor(anti-slop): extract slop lexicon to config file with expanded word lists"
```

---

## Task 2: Add Tier 3 Light Signals and Buzzword Collocations

**Files:**
- Modify: `src/lib/ai/pipeline/quality-scanner.ts:185-228` — add Tier 3 scanning pass and collocation scanning pass
- Modify: `src/lib/ai/pipeline/quality-scanner.config.ts` — ensure `TIER_3_TERMS` and `BUZZWORD_COLLOCATIONS` exported
- Test: `src/lib/ai/__tests__/quality-scanner.test.ts` — add tests for Tier 3 and collocations

**Interfaces:**
- Consumes: `TIER_3_TERMS`, `BUZZWORD_COLLOCATIONS` from config
- Produces: Extended `QualityReport` with Tier 3 terms and collocations in `flaggedPatterns`

**Motivation:** SlopDetector Tier 3 words are ordinary words that only signal slop when clustered. Buzzword collocations ("robust framework", "seamless integration") are stronger tells than individual words. Antislop Paper confirms: "Phrases beat words" and "the glue is the tell."

- [ ] **Step 1: Write failing tests**

```typescript
// Add to quality-scanner.test.ts
describe("Internal Quality & Anti-Slop Scanner — Tier 3 & Collocations", () => {
  it("detects Tier 3 light signals when clustered", () => {
    const text = `To address the problem, we should additionally consider the options. Furthermore, the solution is significantly more complex. Consequently, we must enhance our approach. Ultimately, the best strategy is to pivot.`;

    const report = evaluateMessageQuality(text);
    expect(report.shouldDisplay).toBe(true);
    // Tier 3 words should be flagged
    expect(report.flaggedPatterns).toContain("additionally");
    expect(report.flaggedPatterns).toContain("furthermore");
    expect(report.flaggedPatterns).toContain("consequently");
  });

  it("does not flag Tier 3 words when sparsely used", () => {
    const text = `The server runs on port 3000. This is crucial for the deployment.`;

    const report = evaluateMessageQuality(text);
    expect(report.shouldDisplay).toBe(false); // < 35 words, bypass
  });

  it("detects buzzword collocations (phrases beat words)", () => {
    const text = `We built a robust framework that delivers meaningful results across the digital landscape. This multifaceted approach leverages continuous improvement and a holistic approach to drive key drivers of innovation.`;

    const report = evaluateMessageQuality(text);
    expect(report.shouldDisplay).toBe(true);
    expect(report.flaggedPatterns).toContain("robust ___");
    expect(report.flaggedPatterns).toContain("meaningful ___");
    expect(report.flaggedPatterns).toContain("digital ___");
    expect(report.flaggedPatterns).toContain("multifaceted ___");
    expect(report.flaggedPatterns).toContain("continuous ___");
    expect(report.flaggedPatterns).toContain("holistic ___");
    expect(report.flaggedPatterns).toContain("key driver");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Add Tier 3 scanning pass**

In `evaluateMessageQuality`, after the Tier 2 pass, add:

```typescript
let tier3Count = 0;
const TIER_3_REGEXES = TIER_3_TERMS.map((term) => ({
  term,
  regex: new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"),
}));
for (const { term, regex } of TIER_3_REGEXES) {
  const matches = cleanProse.match(regex);
  if (matches && matches.length > 0) {
    tier3Count += matches.length;
    if (!flaggedPatterns.includes(term)) {
      flaggedPatterns.push(term);
    }
  }
}
```

- [ ] **Step 4: Add collocation scanning pass**

After Tier 3 pass, add:

```typescript
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
```

- [ ] **Step 5: Update scoring formula**

Modify the penalty calculation to include Tier 3 and collocations:

```typescript
// Tier 3: light signals, weighted lightly (same as Tier 2 but without the -1 discount)
// Collocations: stronger signal — weight 2× Tier 1
const rawPoints =
  tier1Count * 18 +
  collocationCount * 36 +     // collocations = 2× Tier 1 weight
  structuralCount * 20 +
  effectiveTier2 * 7 +
  tier3Count * 5 +            // Tier 3 is a light signal
  codeIssues.length * 25;
```

- [ ] **Step 6: Run tests to verify they pass**

- [ ] **Step 7: Run full quality-scanner test suite for regression**

- [ ] **Step 8: Commit**

```bash
git add src/lib/ai/pipeline/quality-scanner.ts src/lib/ai/pipeline/quality-scanner.config.ts src/lib/ai/__tests__/quality-scanner.test.ts
git commit -m "feat(anti-slop): add Tier 3 light signals and buzzword collocation detection"
```

---

## Task 3: Add Paragraph Opener and Transition Cadence Detection

**Files:**
- Modify: `src/lib/ai/pipeline/quality-scanner.ts` — add cadence detection pass
- Modify: `src/lib/ai/pipeline/quality-scanner.config.ts` — ensure `PARAGRAPH_OPENER_PATTERNS` exported
- Test: `src/lib/ai/__tests__/quality-scanner.test.ts`

**Interfaces:**
- Consumes: `PARAGRAPH_OPENER_PATTERNS` from config
- Produces: New `flaggedPatterns` entry "paragraph opener cadence" when 4+ paragraphs start with same connective

**Motivation:** Wikipedia's "Signs of AI writing" flags "Additionally" as a signature paragraph-opener. Antislop Paper notes models fixate on specific words/phrases. The Ozigi validator has a "same-opener cadence detection" pass for Gemini.

- [ ] **Step 1: Write failing test**

```typescript
it("detects paragraph opener cadence (same connectives starting paragraphs)", () => {
  const text = `First, we need to understand the basics.

  Additionally, the system requires proper configuration.

  Additionally, we must verify the installation path.

  Additionally, the firewall settings need to be checked.

  Additionally, the database connection must be established.`;

  const report = evaluateMessageQuality(text);
  expect(report.shouldDisplay).toBe(true);
  expect(report.flaggedPatterns).toContain(
    "paragraph opener cadence (4+ paragraphs with same leading connective)"
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement paragraph opener cadence detection**

After the collocation pass, add:

```typescript
// Paragraph opener cadence: detects 4+ paragraphs starting with the
// same transition word. Source: Wikipedia "Signs of AI writing" —
// "Additionally" is a signature paragraph-opener for earlier LLMs.
// Ozigi validator has the same detection for Gemini.
const paragraphOpeners = cleanProse
  .split(/\n\s*\n/)
  .filter((p) => p.trim().length > 0)
  .map((p) => p.trim().split(/\s+/)[0]?.toLowerCase())
  .filter((w) => w !== undefined);

const openerCounts: Record<string, number> = {};
for (const word of paragraphOpeners) {
  openerCounts[word] = (openerCounts[word] ?? 0) + 1;
}

for (const { word, label } of PARAGRAPH_OPENER_PATTERNS) {
  if ((openerCounts[word.toLowerCase()] ?? 0) >= 4) {
    if (!flaggedPatterns.includes(
      `paragraph opener cadence (4+ paragraphs with same leading connective)`
    )) {
      flaggedPatterns.push(
        `paragraph opener cadence (4+ paragraphs with same leading connective)`
      );
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Run full test suite for regression**

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai/pipeline/quality-scanner.ts src/lib/ai/pipeline/quality-scanner.config.ts src/lib/ai/__tests__/quality-scanner.test.ts
git commit -m "feat(anti-slop): add paragraph opener cadence detection"
```

---

## Task 4: Add Markdown Link Sanitization to Code-Block Extraction

**Files:**
- Modify: `src/lib/ai/pipeline/quality-scanner.ts:159-166` — extend sanitization
- Test: `src/lib/ai/__tests__/quality-scanner.test.ts`

**Interfaces:**
- Consumes: none (internal to `evaluateMessageQuality`)
- Produces: `cleanProse` with markdown links stripped, preventing false positives from URLs containing banned words

**Motivation:** Ozigi's validator strips fenced code blocks, inline code, and markdown link targets before scanning. Yggdrasil currently strips only fenced blocks and inline code. If a URL like `https://tapestry.ai/docs` appears in the prose, it would falsely trigger a Tier 1 hit.

- [ ] **Step 1: Write failing test**

```typescript
it("does not flag banned words inside markdown link targets", () => {
  const text = `For more info, see [the tapestry docs](https://tapestry.example.com/framework).
  The seamless integration is configured via env vars.`;

  // "tapestry" appears only in a URL — should NOT be flagged
  const report = evaluateMessageQuality(text);
  expect(report.flaggedPatterns).not.toContain("tapestry");
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Extend the sanitization step**

Replace the existing code-block extraction (lines 159-166) with:

```typescript
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
  .replace(/`[^`]*?`/g, " ")                          // strip inline code
  .replace(/!?\[[^\]]*\]\([^)]+\)/g, " ");            // strip markdown links + images
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Run full test suite for regression**

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai/pipeline/quality-scanner.ts src/lib/ai/__tests__/quality-scanner.test.ts
git commit -m "fix(anti-slop): strip markdown link targets to prevent false-positive buzzword hits"
```

---

## Task 5: Add Weighted Scoring (Structural > Collocation > Vocabulary)

**Files:**
- Modify: `src/lib/ai/pipeline/quality-scanner.ts:230-264` — update scoring formula and tier thresholds
- Test: `src/lib/ai/__tests__/quality-scanner.test.ts`

**Interfaces:**
- No interface changes — `QualityReport` is unchanged

**Motivation:** Ozigi weights `banned-structure` hits at 3× vocabulary hits. Antislop Paper confirms structural patterns (sentence rhythm, "It's not X, it's Y") are harder to miss. The current scanner treats all matches equally except code issues (×25).

- [ ] **Step 1: Write failing test**

```typescript
it("weights structural patterns higher than vocabulary hits", () => {
  // 1 Tier 1 word ("tapestry") + 1 structural pattern ("not just X, it's Y")
  const textA = `In a recent tapestry of events, it's not just about the code, it's about the journey. This multifaceted approach underscores our dedication to excellence and leveraging best practices across the board.`;
  const reportA = evaluateMessageQuality(textA);

  // Same structural pattern + same number of words, but all Tier 2
  const textB = `This robust solution is seamless and comprehensive. It's not just a tool, it's a revolution. The pivotal nature of this work is truly remarkable.`;
  const reportB = evaluateMessageQuality(textB);

  // textA has 1 structural + 1 Tier1 + 2 Tier2 = higher score
  expect(reportA.score).toBeGreaterThan(reportB.score);
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Update scoring weights**

```typescript
// Weighted scoring: structural patterns (×3 Tier 1) > collocations (×2 Tier 1)
// > Tier 1 vocabulary (×1) > Tier 2 (×0.5) > Tier 3 (×0.3)
const tier1Weighted = tier1Count * 18;
const collocationWeighted = collocationCount * 36;      // 2× Tier 1
const structuralWeighted = structuralCount * 20;         // already strong
const tier2Weighted = effectiveTier2 * 7;
const tier3Weighted = tier3Count * 5;
const codeWeighted = codeIssues.length * 25;

const rawPoints =
  tier1Weighted +
  collocationWeighted +
  structuralWeighted +
  tier2Weighted +
  tier3Weighted +
  codeWeighted;
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Run full test suite for regression**

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai/pipeline/quality-scanner.ts src/lib/ai/__tests__/quality-scanner.test.ts
git commit -m "refactor(anti-slop): implement weighted scoring with structural > collocation > vocabulary"
```

---

## Task 6: Add Topic Drift ("Kabur") Detection (Async)

**Files:**
- Create: `src/lib/ai/pipeline/topic-drift-detector.ts` — async function using existing embedding system
- Modify: `src/hooks/use-system-health.ts` — no changes needed (topic drift is separate from system health)
- Modify: `src/components/chat/ChatMessageRow.tsx` — call async drift check after render
- Test: `src/lib/ai/pipeline/__tests__/topic-drift-detector.test.ts`

**Interfaces:**
- Consumes: `generateEmbedding` from `@/lib/memory/embeddings`, `cosineSimilarity` from existing memory utils
- Produces: `detectTopicDrift(text: string, options?: { threshold?: number }): Promise<TopicDriftReport | null>`
- `TopicDriftReport = { driftDetected: boolean; confidence: number; sentences: string[]; threshold: number }`

**Motivation:** The experimental test proved that topic drift WITHOUT buzzwords gets score 0 (false negative). Antislop Paper notes models fixate on patterns including "It's not X, it's Y" at 6.3× frequency. Topic drift ("kabur") is the second half of the user's complaint and is completely unaddressed.

**Approach:** Split text into sentences → embed each → compute cosine similarity between consecutive sentences → flag if any adjacent pair drops below 0.35 threshold (matching the backlog's existing drift threshold at `docs/superpowers/plans/2026-09-06-system-persona-plan.md`).

- [ ] **Step 1: Write failing test**

```typescript
// src/lib/ai/pipeline/__tests__/topic-drift-detector.test.ts
import { detectTopicDrift } from "../topic-drift-detector";

describe("detectTopicDrift", () => {
  it("returns null for coherent text", async () => {
    const text = `To reset your password, navigate to the login page and click "Forgot password".
    Enter your email address and submit the form. Check your inbox for a reset link.
    Click the link and create a new password.`;

    const result = await detectTopicDrift(text);
    expect(result?.driftDetected).toBe(false);
  });

  it("detects topic drift without buzzwords", async () => {
    const text = `To reset your password, navigate to the login page and click "Forgot password".
    Meanwhile, the weather has been unusual this year with record temperatures.
    Many people have noticed changes in their local ecosystems and migration patterns.`;

    const result = await detectTopicDrift(text, { threshold: 0.35 });
    expect(result?.driftDetected).toBe(true);
    expect(result?.confidence).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement the detector**

Create `src/lib/ai/pipeline/topic-drift-detector.ts`:

```typescript
/**
 * Topic drift ("kabur") detection for assistant output.
 *
 * Splits text into sentences, embeds each, and computes cosine similarity
 * between consecutive sentences. A drop below the threshold indicates the
 * model has wandered off-topic mid-response — a false negative for the
 * buzzword-only quality scanner.
 *
 * Uses the existing embedding infrastructure (onnx-provider or remote).
 * Returns null if embeddings are unavailable (graceful degradation).
 *
 * Threshold 0.35 aligns with the active objective tracking heuristic
 * in the system persona plan and semantic-memory search relevance floor.
 */

import { generateEmbedding } from "@/lib/memory/embeddings";
import { cosineSimilarity } from "@/lib/memory/search";

export interface TopicDriftReport {
  driftDetected: boolean;
  confidence: number; // 0-1, strength of drift signal
  sentences: string[];
  threshold: number;
  minSimilarity: number | null;
}

/** Splits text into sentences using a heuristic boundary detector. */
function splitSentences(text: string): string[] {
  // Match sentence-ending punctuation followed by capital letter or whitespace
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z\u2100-\u214F])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

export async function detectTopicDrift(
  text: string,
  options: { threshold?: number } = {}
): Promise<TopicDriftReport | null> {
  const threshold = options.threshold ?? 0.35;
  const sentences = splitSentences(text);

  if (sentences.length < 3) {
    return null; // Not enough sentences to detect drift
  }

  let embeddings: (number[] | null)[] = [];
  try {
    embeddings = await Promise.all(
      sentences.map((s) => generateEmbedding(s.slice(0, 500)))
    );
  } catch {
    return null; // Embedding unavailable — degrade gracefully
  }

  const valid = embeddings.filter(
    (e): e is number[] => e !== null
  );
  if (valid.length < 3) {
    return null;
  }

  let minSimilarity = 1.0;
  for (let i = 1; i < valid.length; i++) {
    const sim = cosineSimilarity(valid[i - 1], valid[i]);
    if (sim < minSimilarity) {
      minSimilarity = sim;
    }
  }

  const driftDetected = minSimilarity < threshold;

  return {
    driftDetected,
    confidence: driftDetected
      ? 1 - minSimilarity
      : 0,
    sentences,
    threshold,
    minSimilarity,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Integrate into ChatMessageRow**

In `ChatMessageRow.tsx`, add an effect to call `detectTopicDrift` for assistant messages with `shouldDisplay: true` and display a ⚠️ icon when drift is detected. Since this is async, use a `useState` + `useEffect`:

```typescript
import { detectTopicDrift } from "@/lib/ai/pipeline/topic-drift-detector";

const [drift, setDrift] = useState<TopicDriftReport | null>(null);
useEffect(() => {
  if (message.role === "assistant" && quality.shouldDisplay) {
    void detectTopicDrift(messageText).then(setDrift);
  }
}, [messageText, message.role, quality.shouldDisplay]);
```

Then display a warning in the `MessageActions` if `drift?.driftDetected`:

```typescript
{drift?.driftDetected && (
  <MessageAction
    className="text-amber-500 hover:text-amber-600 dark:text-amber-400"
    label="Possible topic drift detected"
    tooltip={`Response may have wandered off-topic (coherence: ${(drift.minSimilarity! * 100).toFixed(0)}%)`}
  >
    <WarningCircle className="size-3.5" />
  </MessageAction>
)}
```

- [ ] **Step 6: Run tests (unit + component)**

- [ ] **Step 7: Commit**

```bash
git add src/lib/ai/pipeline/topic-drift-detector.ts src/lib/ai/pipeline/__tests__/topic-drift-detector.test.ts src/components/chat/ChatMessageRow.tsx
git commit -m "feat(anti-slop): add async topic drift ('kabur') detection using sentence embedding similarity"
```

---

## Task 7: Add Drift Guard (Prose ↔ Code Synchronization)

**Files:**
- Modify: `src/lib/ai/pipeline/quality-scanner.config.ts` — add prose `ANTI_AI_RULES` string + drift guard
- Test: `src/lib/ai/__tests__/quality-scanner.config.test.ts` — add drift guard test

**Interfaces:**
- No new exports — internal validation

**Motivation:** Ozigi's `anti-ai.ts` has a dev-mode drift guard that warns if any structured entry is missing from the prose rules. This prevents the word list and documentation from silently diverging.

- [ ] **Step 1: Write failing test**

```typescript
it("drift guard: every TIER_1_TERMS entry appears in ANTI_AI_RULES prose", () => {
  const { ANTI_AI_RULES, TIER_1_TERMS } = await import("../quality-scanner.config");
  const prose = ANTI_AI_RULES.toLowerCase();
  for (const term of TIER_1_TERMS) {
    expect(prose.includes(term.toLowerCase()), `Term "${term}" missing from prose rules`).toBe(true);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Add prose rules + drift guard to config**

Add to config file:

```typescript
export const ANTI_AI_RULES = `## Anti-Slop Quality Rules

### Tier 1 — Kill on sight
Avoid these words: ${TIER_1_TERMS.join(", ")}.

### Tier 2 — Suspicious in clusters
Watch for: ${TIER_2_TERMS.join(", ")}.

### Tier 3 — Light signals (flag when clustered)
Be cautious with: ${TIER_3_TERMS.join(", ")}.
`;

// Dev-mode drift guard
if (process.env.NODE_ENV !== "production") {
  const proseLower = ANTI_AI_RULES.toLowerCase();
  for (const term of [...TIER_1_TERMS, ...TIER_2_TERMS, ...TIER_3_TERMS]) {
    if (!proseLower.includes(term.toLowerCase())) {
      console.warn(`[anti-slop] term "${term}" missing from ANTI_AI_RULES prose`);
    }
  }
  for (const phrase of BANNED_PHRASES) {
    if (!proseLower.includes(phrase.toLowerCase())) {
      console.warn(`[anti-slop] phrase "${phrase}" missing from ANTI_AI_RULES prose`);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/pipeline/quality-scanner.config.ts src/lib/ai/__tests__/quality-scanner.config.test.ts
git commit -m "feat(anti-slop): add drift guard between prose rules and structured word lists"
```

---

## Task 8: Update UI Display for New Detection Categories

**Files:**
- Modify: `src/components/chat/ChatMessageRow.tsx:70-119` — update headline logic for new tiers
- Test: `src/components/__tests__/research-trail.test.tsx` (or create `src/components/chat/__tests__/chat-message-row.test.tsx`)

**Interfaces:**
- Consumes: Extended `QualityReport` (new fields: none — still uses `tier`, `flaggedPatterns`, `signalPercent`)
- The `ChatUIMessage` type may need a `drift` field for persisted drift detection results

**Motivation:** With new detection categories (Tier 3, collocations, cadence, topic drift), the UI display labels need to reflect the richer taxonomy. Ozigi surfaces `lexiconWarnings` to the UI so users can see what slipped through.

- [ ] **Step 1: Write failing test**

```typescript
// src/components/chat/__tests__/chat-message-row.test.tsx
import { render, screen } from "@testing-library/react";
import { ChatMessageRow } from "../ChatMessageRow";

it("shows topic drift warning in message actions", () => {
  const mockMessage = {
    id: "msg-1",
    role: "assistant" as const,
    parts: [{ type: "text" as const, text: "Password: click forgot. Meanwhile, weather changed. Climate affects tech." }],
  };
  // Mock detectTopicDrift to return drift
  vi.mock("@/lib/ai/pipeline/topic-drift-detector", () => ({
    detectTopicDrift: vi.fn().mockResolvedValue({
      driftDetected: true,
      confidence: 0.7,
      sentences: ["a", "b", "c"],
      threshold: 0.35,
      minSimilarity: 0.2,
    }),
  }));

  render(<ChatMessageRow {...defaultProps} message={mockMessage} />);
  expect(screen.getByTitle(/topic drift/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Update headline logic in ChatMessageRow**

```typescript
const headline =
  quality.tier === "clean"
    ? `Clean ${quality.signalPercent}% (No AI Slop)`
    : quality.tier === "low"
    ? `Mostly Clean ${quality.signalPercent}% (Slight AI Fluff)`
    : quality.tier === "moderate"
    ? `AI Slop Detected (${quality.signalPercent}% signal)`
    : `Heavy AI Slop Detected (${quality.signalPercent}% signal)`;
```

No change needed to headline logic — the tiers are the same. The key change is adding the drift warning icon alongside the Sparkle icon.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/ChatMessageRow.tsx src/components/chat/__tests__/chat-message-row.test.tsx
git commit -m "feat(anti-slop): integrate topic drift warning into message UI"
```

---

## Task 9: Add End-to-End Integration Test

**Files:**
- Create: `src/lib/ai/pipeline/__tests__/anti-slop-integration.test.ts`

**Interfaces:**
- Consumes: `evaluateMessageQuality`, `detectTopicDrift`
- Produces: Integration test covering all detection paths

**Motivation:** Verify all new detection paths work together without regressions on the "ngarang", "kabur clean", and "clean" scenarios from the investigation phase.

- [ ] **Step 1: Write integration test**

```typescript
describe("Anti-slop integration — all detection paths", () => {
  it("catches ngarang (buzzword clusters)", async () => {
    const text = `In today's fast-paced world, we must leverage robust, seamless solutions
    to unlock unprecedented value and catalyze transformative growth. This
    multifaceted approach is a testament to our holistic methodology,
    underscoring the pivotal nature of innovative solutions.`;
    const report = evaluateMessageQuality(text);
    expect(report.score).toBeGreaterThanOrEqual(60);
    expect(report.tier).toBe("high");
  });

  it("catches kabur (topic drift without buzzwords)", async () => {
    const text = `To reset your password, navigate to the login page.
    Meanwhile, the weather has been unusual this year.
    Many people have noticed changes in their local ecosystems.`;
    const drift = await detectTopicDrift(text, { threshold: 0.35 });
    expect(drift?.driftDetected).toBe(true);
  });

  it("passes clean technical prose", async () => {
    const text = `Run \`psql -U postgres -d mydb -c "SELECT 1"\` to test the connection.
    If it succeeds, your credentials and database are reachable.`;
    const report = evaluateMessageQuality(text);
    expect(report.shouldDisplay).toBe(false);
  });
});
```

- [ ] **Step 2: Run test**

- [ ] **Step 3: Commit**

```bash
git add src/lib/ai/pipeline/__tests__/anti-slop-integration.test.ts
git commit -m "test(anti-slop): add integration test covering all detection paths"
```

---

## Verification Checklist

Before final commit:

- [ ] `pnpm test` — all unit tests pass (existing + new)
- [ ] `pnpm lint` — no lint errors
- [ ] `pnpm tsc --noEmit` — type check passes
- [ ] Manual verification: quality scanner catches ngarang, kabur clean, and clean prose
- [ ] Topic drift detection returns null gracefully when embeddings unavailable
- [ ] No new runtime dependencies added
- [ ] `QualityReport` interface backward-compatible
- [ ] No changes to chat route streaming pipeline

---

## Summary of Research Sources

1. **[Antislop Paper (arXiv:2510.15061)](https://arxiv.org/abs/2510.15061)** — ICLR 2026. Frequency-ratio analysis, soft-banning sampler, FTPO fine-tuning. Key finding: "It's not X, it's Y" appears 6.3× more in LLM text.
2. **[Kobak et al. (arXiv:2406.07016)](https://arxiv.org/abs/2406.07016)** — Science Advances 2025. 14.2M PubMed abstracts, "delves" at 25× expected rate.
3. **[SlopDetector AI Words List](https://slopdetector.org/blog/ai-words-list)** — Tier 1 (28), Tier 2 (44), Tier 3 (19) word lists + phrase taxonomy + buzzword collocations.
4. **[Ozigi Two-Layer Architecture](https://ozigi.app/blog/stopping-ai-slop-in-production-banned-lexicon-validator)** — Field-tested production validator: 4-pass scanning, code sanitization, soft-banning, single bounded retry, telemetry, drift guard.
5. **[Wikipedia: Signs of AI Writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)** — Community-maintained catalog: negative parallelism, paragraph opener habits, Wikipedia-rehash phrases.
6. **[EQ-Bench Slop Metric](https://eqbench.com/about.html)** — Overused-word frequency analysis across models, validated against human baselines.
