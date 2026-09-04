/**
 * Typo-tolerant matching for the small search surfaces: the composer's "@"
 * palette, the command menu, and the sidebar filter. Shared by the server and
 * the web client so a query ranks the same wherever it is typed.
 *
 * Scores are 0 (no match) to 100 (exact). Every whitespace-separated term
 * must match somewhere in the text: as a substring, as a word within a small
 * edit distance (transpositions count as one edit), or as a subsequence of a
 * single word. Accents and case are ignored.
 */

const WORD_SPLIT = /[^a-z0-9]+/;

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Edits a term may absorb: none for short ones, so "cat" never finds "cut". */
function editBudget(term: string): number {
  if (term.length < 4) return 0;
  if (term.length < 8) return 1;
  return 2;
}

/** Optimal string alignment distance, capped at `max + 1`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1] &&
        prev2[j - 2] + 1 < d
      ) {
        d = prev2[j - 2] + 1;
      }
      row.push(d);
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

function isSubsequence(term: string, word: string): boolean {
  let i = 0;
  for (const ch of word) {
    if (ch === term[i]) i++;
    if (i === term.length) return true;
  }
  return i === term.length;
}

function termScore(term: string, text: string, words: string[]): number {
  if (text.includes(term)) return 60;
  const budget = editBudget(term);
  if (budget > 0) {
    let best = budget + 1;
    for (const word of words) {
      if (word.length < term.length - budget) continue;
      // Compare against the whole word and its prefix of the term's length,
      // so "wrokspace" and "relase" both land on their intended word.
      const d = Math.min(
        editDistance(term, word, budget),
        editDistance(term, word.slice(0, term.length), budget),
      );
      if (d < best) best = d;
      if (best === 0) break;
    }
    if (best <= budget) return 50 - best * 10;
  }
  // "wksp" for "workspace": abbreviations skip letters but keep their order.
  if (term.length >= 3 && words.some((word) => isSubsequence(term, word))) {
    return 20;
  }
  return 0;
}

/**
 * Score `text` against `query`. 0 means no match; higher is a better match.
 * An empty query matches everything at 1.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = normalize(query).trim();
  if (!q) return 1;
  const t = normalize(text);
  if (!t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 90;
  const words = t.split(WORD_SPLIT).filter(Boolean);
  if (words.some((word) => word.startsWith(q))) return 80;
  if (t.includes(q)) return 70;
  const terms = q.split(/\s+/);
  let total = 0;
  for (const term of terms) {
    const score = termScore(term, t, words);
    if (score === 0) return 0;
    total += score;
  }
  return Math.round(total / terms.length);
}

/** The best score across several fields of one item. 0 means no match. */
export function fuzzyMatch(
  query: string,
  values: ReadonlyArray<string | null | undefined>,
): number {
  let best = 0;
  for (const value of values) {
    if (!value) continue;
    const score = fuzzyScore(query, value);
    if (score > best) best = score;
    if (best === 100) break;
  }
  return best;
}
