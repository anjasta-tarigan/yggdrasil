# System Prompt Fix Plan — Remaining Items

Status: **Phase 1 (Main Leak Fix) — COMPLETE**
Next: **Phase 2–5 — Planned**

---

## ✅ Phase 1 — COMPLETE: Stop Indonesian Transcript Leak

**Files modified:**
- `src/lib/memory/search.ts` — added `tags` to `SearchResult`, `FtsRow`, `VectorHit`; added `parseTags()` helper; updated all 4 search paths (FTS, KNN-indexed, KNN-brute-force, graph Hop 1+2)
- `src/lib/ai/prompt.ts` — added `EPHEMERAL_TAGS` filter + Language Policy rule in Layer 1 invariants
- `src/lib/ai/__tests__/prompt.test.ts` — added 2 tests

**Test results:** 9/9 prompt tests pass, 9/9 search tests pass, TypeScript clean.

---

## 🔄 Phase 2 — Token Estimation for Non-English (Estimated: 2 file edits, 1 test)

### Problem
`estimateTokens` in `src/lib/skills/catalog.ts:44` uses `Math.ceil(text.length / 4)`.
This is English-calibrated (~4 chars/token). Indonesian averages ~6 chars/token
(longer words, fewer subword boundaries). This causes `truncateToTokenBudget` and
`calculateContextTokenBudget` to **overestimate available space**, letting more
Indonesian content into the system prompt than actually fits.

### Fix
```typescript
// catalog.ts
export function estimateTokens(text: string): number {
  // Indonesian/CJK have fewer subword boundaries → higher chars/token
  const nonLatinRatio = (text.match(/[^\u0000-\u007F]/g)?.length ?? 0) / text.length;
  const charsPerToken = nonLatinRatio > 0.3 ? 5.5 : 4; // CJK ~2.5, Indonesian ~5.5
  return Math.ceil(text.length / charsPerToken);
}
```

**Also needed in `context-budget.ts:82-84`** — the `estimateTokens(chars: number)` function
there should accept the language ratio or be replaced. Check callers.

### Files
| File | Change |
|------|--------|
| `src/lib/skills/catalog.ts` | Update `estimateTokens` to detect non-Latin |
| `src/lib/ai/context-budget.ts` | Update `estimateTokens(chars)` or callers |
| `src/lib/skills/__tests__/config.test.ts` | Add test for Indonesian/CJK token estimate |

### Risk
Low — `charsPerToken` is an overestimate for English (4 → stays 4), so English tests
are unaffected. Indonesian/CJK results will truncate earlier (correct behavior).

---

## 🔄 Phase 3 — YAML-Based Prompt System (Estimated: 2 new files, 2 edits)

### Problem
Only Skills use YAML (`SKILL.md` with frontmatter). Layer 1 system invariants are
hardcoded as a template literal in `prompt.ts`. Extracting to YAML would:
1. Make it clear which rules are hardcoded vs. dynamic
2. Enable version tracking, enable/disable, priority ordering
3. Provide consistency with the SKILL.md pattern users are familiar with

### Design
Following AI SDK v7 recommendation (`02-building-agents.mdx`):
> "Define an agent by instantiating the ToolLoopAgent class with your desired
> configuration" — but also: "The system prompt is just a string you pass in."

For the main chat, `streamText({ system: fullSystemPrompt })` is used (AI SDK Core pattern).
The YAML extraction is a dev-experience improvement, not a runtime change.

### Files
| File | Action |
|------|--------|
| `prompts/invariants.yaml` | **NEW** — extract Layer 1 invariants + language policy to YAML |
| `src/lib/ai/prompt-loader.ts` | **NEW** — load + parse YAML at startup, cache for performance |
| `src/lib/ai/prompt.ts` | Replace hardcoded `coreInvariants` template literal with `loadInvariantPrompt()` |
| `src/lib/ai/__tests__/prompt.test.ts` | Verify YAML-loaded prompt matches expected content |

### YAML Schema (inspired by SKILL.md frontmatter):
```yaml
---
id: system_invariants
version: 1
enabled: true
priority: 1  # injected first, before all other layers
language: en   # all invariant rules are English-only
---

CRITICAL PRECEDENCE RULE: ...

1. Objective & Direct Communication: ...
2. Safety & Precedence: ...
3. Language Policy: ...
```

### Risk
Medium — changes the invariant loading path. If YAML fails to load (file missing, parse error),
must fall back to hardcoded inline string. Need error handling.

---

## 🔄 Phase 4 — Language-Aware Memory Storage (Estimated: 2 edits, 0 tests)

### Problem
The reflection extractor (`reflection.ts:241-242`) and consolidation extractor
(`consolidation.ts:157`) are prompted in English but process Indonesian conversation
content. The extracted facts/stored memories inherit the Indonesian language of the
source conversation, creating mixed-language data in the memory store.

### Fix
Add a `language` field to the `metadata` JSON of stored semantic memories, set based
on the source content language. Then the prompt synthesizer can:
1. Optionally translate non-English facts to English before injection (future)
2. At minimum, flag them for potential filtering (future)

### Minimal implementation:
```typescript
// reflection.ts — after extracting facts, add language metadata
import { detectLanguage } from "@/lib/text/language";
const lang = detectLanguage(fact.content);
metadata: { ...metadata, language: lang }
```

### Files
| File | Change |
|------|--------|
| `src/lib/memory/reflection.ts` | Set `metadata.language` on extracted facts |
| `src/lib/memory/consolidation.ts` | Set `metadata.language` on consolidated facts |
| `src/lib/text/language.ts` | **NEW** — lightweight language detection (regex-based, no deps) |

### Risk
Low — adding a metadata field is backward-compatible. No runtime behavior change yet;
this is preparation for Phase 4b (selective filtering/translation).

---

## 🔄 Phase 5 — Edge-Aware Truncation (Estimated: 1 edit, 2 tests)

### Problem
`truncateToTokenBudget` in `catalog.ts:49-68` uses raw `slice()`:
```typescript
result.push(item.slice(0, remainingTokens * 4) + "... [truncated]");
```
This can cut mid-word, mid-sentence, or mid-code. For Indonesian text with long
compound words, this produces garbled fragments that confuse the model.

### Fix
Add word/sentence-boundary awareness:
```typescript
function truncateToTokenBudget(items: string[], maxTokens: number): string[] {
  ...
  // When truncating an item, find the last sentence boundary
  const truncIdx = Math.floor(remainingTokens * 4);
  const lastPeriod = item.lastIndexOf(".", 0, truncIdx);
  const lastNewline = item.lastIndexOf("\n", 0, truncIdx);
  const cutAt = Math.max(lastPeriod, lastNewline, item.length * 0.5);
  result.push(item.slice(0, cutAt) + "... [truncated]");
}
```

### Files
| File | Change |
|------|--------|
| `src/lib/skills/catalog.ts` | Update `truncateToTokenBudget` with boundary-aware truncation |
| `src/lib/skills/__tests__/config.test.ts` | Add tests for mid-word, mid-sentence truncation |

### Risk
Low — only affects truncation edge case. Tests will verify behavior.

---

## ⚠️ Phase 6 — Indonesian Factual Memories in Other Blocks (Investigation Needed)

### Current State
Even after Phase 1, Indonesian **factual** content still appears in:
- `<user_profile_and_preferences>` — 6 entries, e.g., "Sistem har Harus menerapkan anti-slop..."
- `<project_and_domain_knowledge>` — 8+ entries, e.g., "Inti dalam Bumi mencapai suhu sekitar 5.400 °C..."
- `<learned_rules_and_mistakes_to_avoid>` — 1 entry in Indonesian

### Question for User
Should these be:
- **(A)** Left as-is, trusting the Language Policy rule (Layer 1) to tell the model
      "this is DATA, respond in user's language"? *Lower effort, relies on model compliance.*
- **(B)** Translated to English before injection? *Higher effort, requires translation step
      (local via argo-mt/v2, or LLM-based), adds latency and token overhead.*
- **(C)** Filtered entirely? *Risks losing important user preferences.*

### Recommendation
Start with **(A)**. The Language Policy rule is strong and explicit. If ambiguity
persists after Phases 1-5 are complete, then implement **(B)** selectively for
user_preference and procedural_rule blocks only (not domain_knowledge, since
domain facts are language-agnostic in nature).

---

## 📊 Prioritized Execution Order

| Priority | Phase | Est. Time | Risk | Impact |
|----------|-------|-----------|------|--------|
| P0 | Phase 2 (Token estimation) | 30 min | Low | High — prevents budget overflow for Indonesian |
| P1 | Phase 5 (Edge-aware truncation) | 30 min | Low | Medium — prevents mid-word truncation |
| P2 | Phase 3 (YAML invariants) | 60 min | Medium | Medium — dev-experience improvement |
| P3 | Phase 4 (Language metadata) | 45 min | Low | Future-enabler |
| P4 | Phase 6 decision (A/B/C) | TBD | Depends | Varies |
| P5 | Phase 6 implementation (if needed) | 2-4 hrs | Medium | Varies |

---

## 📋 Action Checklist

- [x] Phase 1: Filter ephemeral memories from cognitive context
- [x] Phase 1: Add language policy to system invariants
- [x] Phase 1: Add `tags` to SearchResult + all search paths
- [x] Phase 1: Tests pass (12/12 prompt + persona tests)
- [ ] Phase 2: Fix `estimateTokens` for non-English chars/token ratio
- [ ] Phase 3: Extract Layer 1 invariants to `prompts/invariants.yaml`
- [ ] Phase 4: Add `language` metadata to extracted facts
- [ ] Phase 5: Edge-aware truncation in `truncateToTokenBudget`
- [ ] Phase 6: Decide A/B/C for Indonesian factual memories
