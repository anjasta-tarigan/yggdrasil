/**
 * Lightweight language detection — no external dependencies.
 * Uses stopword frequency comparison for Indonesian vs English vs unknown.
 * Sufficient for memory metadata tagging (not used for user-facing decisions).
 */

// Source: compiled from Kamus Besar Bahasa Indonesia + common chat patterns
const INDONESIAN_STOPS = new Set([
  "yang", "saya", "akan", "dengan", "untuk", "saja", "ini", "itu", "bukan",
  "sudah", "belum", "adalah", "juga", "dari", "pada", "di", "ke", "ya",
  "tidak", "bisa", "harus", "boleh", "atau", "dan", "kalau", "jika", "saat",
  "sebuah", "seperti", "oleh", "tentang", "dalam", "antara", "dapat", "tersebut",
  "mereka", "kita", "kami", "kamu", "kau", "mu", "nya", "pun", "kah", "lah",
  "tah", "lagi", "masih", "telah", "pernah", "serta",
]);

const ENGLISH_STOPS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "to", "of", "in", "on", "at", "for", "with", "by", "from", "it",
  "this", "that", "these", "those", "and", "or", "but", "not", "no",
  "can", "can't", "should", "could", "would", "will", "shall", "may",
  "might", "must", "do", "does", "did", "has", "have", "had",
]);

/**
 * Detect the dominant language of a text string using stopword frequency.
 * Returns "id" for Indonesian, "en" for English, or "unknown".
 */
export function detectLanguage(text: string): "id" | "en" | "unknown" {
  if (text.length === 0) return "unknown";
  const tokens = text
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
  if (tokens.length === 0) return "unknown";

  const idCount = tokens.filter((t) => INDONESIAN_STOPS.has(t)).length;
  const enCount = tokens.filter((t) => ENGLISH_STOPS.has(t)).length;

  const idRatio = idCount / tokens.length;
  const enRatio = enCount / tokens.length;

  // Threshold: need at least 2% stopword ratio to be meaningful
  if (idRatio > 0.02 && idRatio > enRatio) return "id";
  if (enRatio > 0.02 && enRatio > idRatio) return "en";
  return "unknown";
}
