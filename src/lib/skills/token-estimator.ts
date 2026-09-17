/**
 * Language-aware token estimation — no server-only dependencies.
 *
 * Extracted from `catalog.ts` so client components (e.g. ChatArea → context-budget)
 * can use `estimateTokens` without transitively importing the SQLite-backed
 * skill database (`@/db`) and its native `better-sqlite3` / `sqlite-vec` modules.
 */
import { detectLanguage } from "@/lib/text/language";

/** Rough token estimator.
 * Delegates language detection to `detectLanguage` (stopword-based heuristic)
 * to avoid duplicating Indonesian detection across catalog.ts, language.ts,
 * and context-budget.ts.
 *
 * English/Latin-script texts average ~4 chars/token.
 * Indonesian (Latin script, agglutinative) averages ~6 chars/token.
 * CJK scripts average ~2.5 chars/token.
 * Calibrated against GPT-4o tokenizer.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const lang = detectLanguage(text);
  if (lang === "id") return Math.ceil(text.length / 6); // Indonesian: ~6 chars/token
  if (lang === "unknown") {
    const nonAscii = (text.match(/[^\u0000-\u007F]/g) ?? []).length;
    if (nonAscii / text.length > 0.3) return Math.ceil(text.length / 2.5); // CJK
  }
  return Math.ceil(text.length / 4); // English default: ~4 chars/token
}
