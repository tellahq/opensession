import { assetPreviewKind } from "./asset-preview";

/** How many assets one answer shows inline; the rest stay chips. */
export const MAX_INLINE_ASSETS = 3;

/**
 * The assets an answer shows inline, in order: the ones its turn wrote, then
 * ones its text names (by full path, or by a file name no other asset shares).
 * Only files with a preview qualify: a binary or a sound has nothing to show.
 */
export function inlineAssetPaths(
  written: readonly string[],
  text: string,
  known: readonly string[],
  max = MAX_INLINE_ASSETS,
): string[] {
  const out: string[] = [];
  const add = (path: string) => {
    if (out.length >= max || out.includes(path)) return;
    const kind = assetPreviewKind(path);
    if (kind === "binary" || kind === "audio") return;
    out.push(path);
  };
  for (const path of written) add(path);
  if (!text || out.length >= max) return out;
  const byName = new Map<string, string | null>();
  for (const path of known) {
    const name = path.split("/").pop() || path;
    byName.set(name, byName.has(name) ? null : path);
  }
  for (const path of known) {
    const name = path.split("/").pop() || path;
    if (named(text, path) || (byName.get(name) === path && named(text, name)))
      add(path);
  }
  return out;
}

/** `name` appears in `text` as a whole name, not inside a longer one. */
function named(text: string, name: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(name, from);
    if (at < 0) return false;
    const before = text[at - 1] ?? "";
    // A trailing period ends a sentence unless a name continues after it.
    const after = text.slice(at + name.length, at + name.length + 2);
    if (!/[\w./-]/.test(before) && !/^(?:[\w/-]|\.\w)/.test(after)) return true;
    from = at + 1;
  }
}
