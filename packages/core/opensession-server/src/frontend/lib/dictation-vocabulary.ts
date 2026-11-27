export const MAX_DICTATION_VOCABULARY_CHARS = 500;

const KEY = "opensession-dictation-vocabulary";
const CHANGE_EVENT = "opensession-dictation-vocabulary-changed";

/**
 * Normalizes comma- or newline-separated custom vocabulary terms into a
 * deduplicated, length-bounded hint string for speech transcription models.
 */
export function normalizeDictationVocabulary(raw: string): string {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const part of raw.split(/[,\n\r]+/)) {
    const cleaned = part.replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(cleaned);
  }
  const joined = terms.join(", ");
  if (joined.length <= MAX_DICTATION_VOCABULARY_CHARS) return joined;
  return joined
    .slice(0, MAX_DICTATION_VOCABULARY_CHARS)
    .replace(/,\s*[^,]*$/, "");
}

export function getDictationVocabulary(): string {
  try {
    const stored = localStorage.getItem(KEY);
    return stored ? normalizeDictationVocabulary(stored) : "";
  } catch {
    return "";
  }
}

export function setDictationVocabulary(raw: string): string {
  const normalized = normalizeDictationVocabulary(raw);
  try {
    if (normalized) {
      localStorage.setItem(KEY, normalized);
    } else {
      localStorage.removeItem(KEY);
    }
  } catch {}
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: normalized }));
  }
  return normalized;
}

export function onDictationVocabularyChanged(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) cb();
  };
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener("storage", onStorage);
  };
}
