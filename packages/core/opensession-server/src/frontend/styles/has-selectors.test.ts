import { Glob } from "bun";
import { expect, test } from "bun:test";

/**
 * Tailwind's `group-has-[…]` and `peer-has-[…]` variants compile to
 * `:is(:where(.group):has(…) *)`: a `:has()` whose subject is any element on
 * the page. Chrome cannot scope invalidation for that, so every DOM child
 * change, including React rewriting the composer textarea's text on each
 * keystroke, restyles the whole document. One such class on a side panel tab
 * made typing in conversations visibly lag. Set the state from JS instead.
 */
const ROOT = new URL("..", import.meta.url).pathname;

test("no group-has or peer-has variants", async () => {
  const offenders: string[] = [];
  for await (const rel of new Glob("**/*.{ts,tsx,css}").scan({ cwd: ROOT })) {
    if (/\.test\.tsx?$/.test(rel)) continue;
    const text = await Bun.file(`${ROOT}${rel}`).text();
    for (const match of text.matchAll(/\b(?:group|peer)-has-\[[^\s"'`]*/g))
      offenders.push(`${rel}: ${match[0]}`);
  }
  expect(offenders).toEqual([]);
});
