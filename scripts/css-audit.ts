#!/usr/bin/env bun
/**
 * Reports (and optionally deletes) rules in styles/legacy.css that nothing can
 * reach any more — the garbage-collection half of the Tailwind migration.
 *
 *   bun scripts/css-audit.ts            # report
 *   bun scripts/css-audit.ts --prune    # rewrite legacy.css without them
 *   bun scripts/css-audit.ts --list     # just the unreachable class names
 *   bun scripts/css-audit.ts --loose    # names that match only incidentally
 *
 * A selector can never match if any class in it appears nowhere in the source,
 * so the rule is dead weight. The subtlety is deciding "appears nowhere":
 * class names are not always written literally. Three sources of indirection
 * are excluded from deletion, and getting any of them wrong silently un-styles
 * something (a Linear-sourced chip losing its tint, say):
 *
 *   · template literals — `source-${session.source}`, `pr-bar-state-${tone}`;
 *     any class matching a produced prefix is held back;
 *   · plain string literals in .ts files, reached through a field such as
 *     `meta.dotClass`;
 *   · @keyframes names, which are referenced by `animation:`, not by class.
 *
 * Deletion is conservative in one more way: it only ever drops a selector that
 * contains a dead class. Rules that merely lose one selector from a list keep
 * the rest, and the file's one-selector-per-line formatting is preserved.
 *
 * That conservatism cuts the other way too, and "unreachable: 0" was being
 * read as "nothing left to prune" when it never meant that. A name counts as
 * present if it turns up anywhere at all, including inside a longer string, so
 * an API path ("/wiki/tree") or a module specifier ("../lib/pr-checks") keeps
 * a rule alive on its own. Those show up separately as `--loose`: reachable by
 * the wide match, but never written as an actual class token. It is a list of
 * leads to verify against the running DOM, not a deletion set — pruning is
 * unchanged by it.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SHEET = join(
  ROOT,
  "packages/core/opensession-server/src/frontend/styles/legacy.css",
);
/** Scanned for identifiers — deliberately wide, so a class referenced from
 *  anywhere at all keeps its rule. Being wrong here deletes a live rule. */
const SCAN_DIRS = [
  "packages/core/opensession-server/src",
  "packages/clients/chrome",
  "packages/clients/website",
];
/** Scanned for runtime-built class prefixes. Only the directories that render
 *  markup: `src/server` builds plenty of hyphenated strings that are not class
 *  names (`auto-${randomUUIDv7()}` for automation ids), and harvesting those
 *  as prefixes holds real dead rules hostage — `.auto-status-ok` was kept
 *  alive by an id generator. */
const MARKUP_DIRS = [
  "packages/core/opensession-server/src/frontend",
  "packages/clients/chrome",
  "packages/clients/website",
];
const SCAN_EXT = /\.(tsx?|jsx?|html)$/;

const argv = new Set(process.argv.slice(2));

// ── gather every identifier the source could produce ────────────────────────
function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (
      name === "node_modules" ||
      name === ".git" ||
      name.startsWith(".frontend-dist")
    )
      continue;
    const p = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) sourceFiles(p, out);
    else if (SCAN_EXT.test(name)) out.push(p);
  }
  return out;
}

/**
 * Drop comments before harvesting identifiers. A component that *documents*
 * the legacy classes it replaced ("these were .working-pill / .pulse-dot")
 * would otherwise keep those very rules looking reachable — so the better the
 * migration notes, the less the audit finds. Quote-aware, because "https://"
 * and a `//` inside a string are not comments; JSX text can't open one either
 * without being inside braces, which this treats as code and keeps.
 */
function stripComments(src: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === "\\") out += src[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      i = end < 0 ? src.length : end - 1;
      continue;
    }
    out += c;
  }
  return out;
}

/** Source files with uncommitted edits, as they read at HEAD. */
function dirtySourcesAtHead(): { path: string; text: string }[] {
  let status: string;
  try {
    status =
      spawnSync("git", ["status", "--porcelain"], {
        cwd: ROOT,
        encoding: "utf8",
      }).stdout ?? "";
  } catch {
    return [];
  }
  const out: { path: string; text: string }[] = [];
  for (const line of status.split("\n")) {
    // " M path" / "MM path"; skip additions, which have no HEAD version.
    const path = line.slice(3).trim();
    if (!path || line.startsWith("??") || !SCAN_EXT.test(path)) continue;
    if (!SCAN_DIRS.some((d) => path.startsWith(d + "/"))) continue;
    const blob = spawnSync("git", ["show", `HEAD:${path}`], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (blob.status === 0 && blob.stdout) out.push({ path, text: blob.stdout });
  }
  return out;
}

/**
 * A hyphenated template that interpolates an *identity* builds a React key or
 * a DOM id, not a class: `note-${h.id}`, `tool-${index}`. Harvesting those as
 * class prefixes pins every rule that happens to share the stem — one `key=`
 * in Notes.tsx held 18 `.note-*` rules alive after the page had fully
 * migrated. A class template interpolates a *value* instead (a tone, a state,
 * a source), which is why this excludes ids rather than allow-listing values.
 */
const IDENTITY_INTERP = /^(\w+\.)?(id|_?id|uuid|key|index|i|n|idx)$/i;

/**
 * Class names written as a whole token, the way a class list is actually built
 * — `"sidebar-item is-selected"`, a `querySelector(".composer-pop-wrap")`
 * argument, a Tailwind arbitrary variant. Deliberately narrower than `idents`,
 * which matches any identifier-shaped run of characters anywhere and so counts
 * a name it finds mid-path: `.wiki` read as reachable for months on the
 * strength of the API path "/wiki/tree", long after the last element carrying
 * that class was gone.
 *
 * The one meaningful difference from `idents` is that `/` binds rather than
 * splits, so a path stays whole instead of decomposing into class names.
 * Everything else that cannot appear in a class name splits, which is what
 * recovers the name from a selector string (`.foo`) or an arbitrary variant
 * (`[.session-info-status_&]`).
 *
 * Scanning the whole file rather than just its string literals is deliberate.
 * Tracking quotes across a .tsx file means an apostrophe in JSX text ("don't")
 * opens a phantom string and swallows every className until the next one —
 * which reported `.note-chip-note` as a lead while `Notes.tsx` was plainly
 * emitting it. The cost is that a bare identifier can match a single-word
 * class name, and that only ever *shortens* this list.
 *
 * This set never decides a deletion. It cannot see a class assembled at
 * runtime, so a name missing here is a candidate to verify against the running
 * DOM — not a rule to drop. Pruning still goes by `idents`.
 */
function harvestTokens(text: string, into: Set<string>) {
  for (const raw of text.split(/[^\w/-]+/)) {
    // A trailing "_" is Tailwind's escaped space, not part of the name.
    const tok = raw.replace(/_+$/, "");
    if (tok && !tok.includes("/")) into.add(tok);
  }
}

const markup = new Set(MARKUP_DIRS.flatMap((d) => sourceFiles(join(ROOT, d))));

const idents = new Set<string>();
const prefixes = new Set<string>();
const literals = new Set<string>();
const tokens = new Set<string>();
for (const dir of SCAN_DIRS) {
  for (const f of sourceFiles(join(ROOT, dir))) {
    let text: string;
    try {
      text = stripComments(readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    for (const m of text.matchAll(/[a-zA-Z][a-zA-Z0-9_-]*/g)) idents.add(m[0]);
    for (const m of text.matchAll(/"([a-z][a-z0-9]*(?:-[a-z0-9]+){1,4})"/g))
      literals.add(m[1]);
    harvestTokens(text, tokens);
    if (!markup.has(f)) continue;
    // `foo-bar-${x}` / `a b c-${x}` -> the "c-" prefix such a literal can build
    for (const m of text.matchAll(/`([a-zA-Z0-9 _-]*)\$\{([^}]*)\}/g)) {
      const tail = m[1].split(/\s+/).pop() ?? "";
      if (/[a-z]-$/.test(tail) && !IDENTITY_INTERP.test(m[2].trim()))
        prefixes.add(tail);
    }
  }
}

/**
 * This repo is developed in one shared checkout, so at any moment another
 * session may have a component half-migrated in the working tree. Its
 * uncommitted state would make the classes it has *temporarily* removed look
 * dead, and pruning them deletes styling that is about to be needed again. So
 * a modified file is read at HEAD as well as on disk: a class survives if
 * either version can still reach it. Costs a few rules staying one sweep
 * longer than necessary; the next run picks them up once the file is
 * committed.
 */
for (const f of dirtySourcesAtHead()) {
  const text = stripComments(f.text);
  for (const m of text.matchAll(/[a-zA-Z][a-zA-Z0-9_-]*/g)) idents.add(m[0]);
  for (const m of text.matchAll(/"([a-z][a-z0-9]*(?:-[a-z0-9]+){1,4})"/g))
    literals.add(m[1]);
  harvestTokens(text, tokens);
}

// ── classify the classes defined in the sheet ───────────────────────────────
const css = readFileSync(SHEET, "utf8");
// Comments are stripped first: this file's own header quotes example selectors
// (".sidebar-item.is-selected .count"), and counting those as defined classes
// reports them as dead rules that don't exist.
const defined = new Set(
  [
    ...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\.(-?[_a-zA-Z][\w-]*)/g),
  ].map((m) => m[1]),
);
const keyframes = new Set(
  [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]),
);

const dead = new Set<string>();
/**
 * Reachable by `idents` alone — the name turns up in the source, but never as
 * a class token. Either it is genuinely built at runtime in a shape the prefix
 * harvest missed, or nothing emits it any more and the match is incidental. A
 * separate bucket rather than a verdict: "unreachable: 0" was being read as
 * "nothing left to prune", and it never meant that.
 */
const loose: string[] = [];
const held: [string, string][] = [];
for (const c of defined) {
  if (idents.has(c)) {
    if (!tokens.has(c) && !keyframes.has(c)) loose.push(c);
    continue;
  }
  if (keyframes.has(c)) held.push([c, "@keyframes name"]);
  else if (literals.has(c)) held.push([c, "string literal in source"]);
  else {
    const p = [...prefixes].find((x) => c.startsWith(x));
    if (p) held.push([c, `built at runtime via \`${p}\${...}\``]);
    else dead.add(c);
  }
}

if (argv.has("--list")) {
  for (const c of [...dead].sort()) console.log(c);
  process.exit(0);
}
if (argv.has("--loose")) {
  for (const c of loose.sort()) console.log(c);
  process.exit(0);
}

const reachable = defined.size - dead.size - held.length;
console.log(`sheet:            ${SHEET.replace(ROOT + "/", "")}`);
console.log(`classes defined:  ${defined.size}`);
console.log(
  `  reachable:      ${reachable}${loose.length ? `  (${loose.length} of them only loosely — see --loose)` : ""}`,
);
console.log(
  `  held back:      ${held.length}  (indirection — never delete these)`,
);
console.log(`  unreachable:    ${dead.size}`);
if (held.length && argv.has("--verbose")) {
  console.log("\nheld back:");
  for (const [c, why] of held.sort()) console.log(`  ${c.padEnd(36)} ${why}`);
}
if (loose.length && argv.has("--verbose")) {
  console.log("\nloose (name appears in source, but never as a class token):");
  for (const c of loose.sort()) console.log(`  ${c}`);
  console.log(
    "Verify against the running DOM before deleting — getElementsByClassName",
  );
  console.log(
    "on the route that would use it. This bucket is a lead, not a verdict.",
  );
}

// ── prune ───────────────────────────────────────────────────────────────────
const COMMENT = /\/\*[\s\S]*?\*\//g;
const OPAQUE = new Set([
  "@keyframes",
  "@-webkit-keyframes",
  "@property",
  "@font-face",
  "@counter-style",
]);

/** Split a selector list on top-level commas (not inside (), [] or strings). */
function splitSelectors(sel: string): string[] {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  let quote: string | null = null;
  for (const ch of sel) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") ((quote = ch), (buf += ch));
    else if (ch === "(" || ch === "[") (depth++, (buf += ch));
    else if (ch === ")" || ch === "]") (depth--, (buf += ch));
    else if (ch === "," && depth === 0) (out.push(buf), (buf = ""));
    else buf += ch;
  }
  out.push(buf);
  return out;
}

const isDead = (sel: string) => {
  const names = [...sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
  return names.length > 0 && names.some((n) => dead.has(n));
};

/**
 * Index just past the "}" matching the "{" at `i`. Comments are checked before
 * quotes on purpose: an apostrophe inside a comment ("this asset isn't
 * trimmed") would otherwise open a phantom string and swallow the rule's
 * closing brace, silently merging it with everything after it.
 */
function blockEnd(s: string, i: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (quote) {
      if (ch === "\\") j++;
      else if (ch === quote) quote = null;
    } else if (s.startsWith("/*", j)) {
      const k = s.indexOf("*/", j + 2);
      j = k < 0 ? s.length : k + 1;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return j + 1;
  }
  return s.length;
}

let removedRules = 0;
let removedSelectors = 0;

function prune(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("/*", i)) {
      const k = s.indexOf("*/", i + 2);
      const end = k < 0 ? s.length : k + 2;
      out += s.slice(i, end);
      i = end;
      continue;
    }
    // Scan the prelude up to "{" (a rule) or ";" (an at-statement).
    let j = i;
    let quote: string | null = null;
    for (; j < s.length; j++) {
      const ch = s[j];
      if (quote) {
        if (ch === "\\") j++;
        else if (ch === quote) quote = null;
      } else if (s.startsWith("/*", j)) {
        const k = s.indexOf("*/", j + 2);
        j = k < 0 ? s.length : k + 1;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "{" || ch === ";") break;
    }
    if (j >= s.length) {
      out += s.slice(i);
      break;
    }
    if (s[j] === ";") {
      out += s.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    const prelude = s.slice(i, j);
    const end = blockEnd(s, j);
    const body = s.slice(j + 1, end - 1);
    // Strip comments before deciding at-rule vs style rule. A documented
    // block ("/* Mobile: card rows */\n@media (max-width: 720px) {") starts
    // its prelude with the comment, and testing that for "@" silently
    // classifies the whole media query as one style rule — so nothing
    // inside it is ever walked, and every dead rule in it survives.
    const head = prelude.replace(COMMENT, "").trim();

    if (head.startsWith("@")) {
      if (OPAQUE.has(head.split(/\s/)[0].toLowerCase())) out += s.slice(i, end);
      else {
        const inner = prune(body);
        if (inner.trim()) out += `${prelude}{${inner}}`;
      }
      i = end;
      continue;
    }

    // Comments must leave the prelude BEFORE the selector list is split, or
    // a comma inside one chops it into an unterminated fragment.
    const comments = prelude.match(COMMENT) ?? [];
    const selText = prelude.replace(COMMENT, "");
    const parts = splitSelectors(selText).filter((p) => p.trim());
    const keep = parts.filter((p) => !isDead(p));
    const dropped = parts.length - keep.length;

    if (!keep.length) {
      removedRules++;
      removedSelectors += dropped;
    } else if (dropped) {
      removedSelectors += dropped;
      const lead = selText.slice(
        0,
        selText.length - selText.trimStart().length,
      );
      // Keep one-per-line formatting; collapsing 40 selectors onto one
      // line makes the diff unreviewable.
      const m = selText.match(/,[ \t]*\n([ \t]*)/);
      const joiner = m ? `,\n${m[1]}` : ", ";
      const doc = comments.map((c) => `${c}\n`).join("");
      out += `${lead}${doc}${keep.map((p) => p.trim()).join(joiner)} {${body}}`;
    } else {
      out += s.slice(i, end);
    }
    i = end;
  }
  return out;
}

if (argv.has("--prune")) {
  const next = prune(css).replace(/\n{4,}/g, "\n\n\n");
  writeFileSync(SHEET, next);
  const before = css.split("\n").length;
  const after = next.split("\n").length;
  console.log(`\npruned: ${removedRules} rules, ${removedSelectors} selectors`);
  console.log(`lines:  ${before} -> ${after}  (-${before - after})`);
  console.log("\nVerify before committing: the CSSOM diff and the screenshot");
  console.log("gate are what caught real breakage here, not the text diff.");
} else if (dead.size) {
  console.log(
    "\nRun with --prune to delete them, --verbose to see what was held back.",
  );
}
