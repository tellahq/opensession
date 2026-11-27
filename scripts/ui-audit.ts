#!/usr/bin/env bun
/**
 * Counts the ways the web UI is built beside its own design system, and holds
 * each count under a budget.
 *
 *   bun scripts/ui-audit.ts                 # table, exits 1 over budget
 *   bun scripts/ui-audit.ts --files <id>    # where one signal lives
 *   bun scripts/ui-audit.ts --json
 *   bun scripts/ui-audit.ts --save          # write the current counts as the budget
 *                                           (measure HEAD in a detached worktree:
 *                                            the shared checkout is usually dirty)
 *
 * This is the guard `css-audit.ts` can no longer be. That one asks whether a
 * rule in legacy.css is still reachable, and legacy.css has been empty since
 * the Tailwind migration finished, so it reports 0 forever and cannot catch a
 * screen built with its own buttons and its own type sizes. Drift moved out of
 * the stylesheet and into the markup; this counts it there.
 *
 * Each signal names a primitive or a token that already exists, so a number
 * going up means a call site chose to re-invent one. The budgets are a ratchet,
 * not a target: they start at the counts measured when the audit landed and
 * only ever come down. Nothing here can be fixed by editing the budget file
 * upward — that is the point of checking it in.
 *
 * `src/frontend/ui/` is exempt from most signals by design: a primitive has to
 * render a raw `<button>`, own a pixel height, and import Base UI. That is
 * where those things are allowed to live, and the exemption is what makes the
 * count everywhere else meaningful.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const FRONTEND = join(ROOT, "packages/core/opensession-server/src/frontend");
const BUDGET_FILE = join(import.meta.dir, "ui-audit-budget.json");

/** Radii the scale actually names (styles/tailwind.css), in px before `--rf`. */
const RADIUS_SCALE = new Set([2, 4, 7, 12, 14, 16, 18, 22]);

const TAILWIND_CSS = readFileSync(
  join(FRONTEND, "styles/tailwind.css"),
  "utf8",
);

/** Color names defined by `--color-*` in `styles/tailwind.css`. */
const THEME_COLOR_TOKENS = new Set(
  [...TAILWIND_CSS.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]!),
);

/** Type-scale names defined by `--text-*` in `styles/tailwind.css`. */
const THEME_TEXT_TOKENS = new Set(
  [...TAILWIND_CSS.matchAll(/--text-([a-z0-9-]+)\s*:/g)]
    .map((m) => m[1]!)
    .filter((name) => !name.includes("--")),
);

/** CSS classes declared in `src/frontend/styles/**\/*.css` so hook classes are never flagged. */
const STYLESHEET_CLASSES = (() => {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.endsWith(".css")) continue;
      const css = readFileSync(path, "utf8");
      for (const match of css.matchAll(
        /\.([a-z][a-z0-9-]*)(?=[\s.,:{[\]>+~)])/g,
      )) {
        out.add(match[1]!);
      }
      for (const match of css.matchAll(/@utility\s+([a-z][a-z0-9-]*)\b/g)) {
        out.add(match[1]!);
      }
    }
  };
  walk(join(FRONTEND, "styles"));
  return out;
})();

const STOCK_PALETTE_RE =
  /\b(?:bg|text|border|border-[trblxyse]|ring|divide|outline|fill|stroke|from|to|via|decoration|accent|caret|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950)\b/g;

const STOCK_PALETTE_VALUE_RE =
  /^(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950)$/;

const COLOR_KEYWORDS = new Set([
  "transparent",
  "current",
  "inherit",
  "white",
  "black",
]);

const NON_COLOR_BG = new Set([
  ...COLOR_KEYWORDS,
  "none",
  "auto",
  "cover",
  "contain",
  "center",
  "top",
  "bottom",
  "left",
  "right",
  "repeat",
  "no-repeat",
  "repeat-x",
  "repeat-y",
  "repeat-round",
  "repeat-space",
  "fixed",
  "local",
  "scroll",
  "radial",
  "conic",
]);

const NON_COLOR_BORDER = new Set([
  ...COLOR_KEYWORDS,
  "0",
  "2",
  "4",
  "8",
  "x",
  "y",
  "t",
  "r",
  "b",
  "l",
  "s",
  "e",
  "solid",
  "dashed",
  "dotted",
  "double",
  "hidden",
  "none",
  "collapse",
  "separate",
  "box",
  "color",
  "width",
  "style",
  "radius",
  "top-width",
  "right-width",
  "bottom-width",
  "left-width",
  "top-color",
  "right-color",
  "bottom-color",
  "left-color",
  "top-style",
  "right-style",
  "bottom-style",
  "left-style",
]);

const NON_COLOR_BORDER_SIDE = new Set([...COLOR_KEYWORDS, "0", "2", "4", "8"]);

const NON_COLOR_TEXT = new Set([
  ...COLOR_KEYWORDS,
  ...THEME_TEXT_TOKENS,
  "left",
  "center",
  "right",
  "justify",
  "start",
  "end",
  "wrap",
  "nowrap",
  "balance",
  "pretty",
  "ellipsis",
  "clip",
  "align",
  "indent",
  "transform",
  "decoration",
  "overflow",
  "rendering",
  "size-adjust",
  "xs",
  "sm",
  "base",
  "lg",
  "xl",
  "2xl",
  "3xl",
  "4xl",
  "5xl",
  "6xl",
  "7xl",
  "8xl",
  "9xl",
]);

const NON_COLOR_RING = new Set([
  ...COLOR_KEYWORDS,
  "0",
  "1",
  "2",
  "4",
  "8",
  "inset",
]);

/** Strip JS/TS comments while preserving quoted string literals. */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      out += ch;
      i++;
      while (i < source.length) {
        if (source[i] === "\\" && i + 1 < source.length) {
          out += source[i]! + source[i + 1]!;
          i += 2;
          continue;
        }
        out += source[i]!;
        if (source[i] === ch) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/"))
        i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Find `bg-*`, `border-*`, `text-*`, and `ring-*` utilities in string literals
 * that reference a color/text token not defined in `styles/tailwind.css`.
 * Tailwind v4 silently drops unknown color utilities, so e.g. `border-border/80`
 * falls back to `currentColor` and `bg-canvas/50` renders nothing.
 */
export function findUnknownThemeTokens(source: string): string[] {
  const clean = stripComments(source);
  const found: string[] = [];
  for (const strMatch of clean.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    const literal = strMatch[2]!;
    if (/^[./]|https?:\/\//.test(literal)) continue;
    for (const rawTok of literal.split(/\s+/)) {
      // Strip up to three variant prefixes (hover:, dark:, group-hover/x:, [&>svg]:).
      let tok = rawTok.replace(/!$/, "");
      for (let step = 0; step < 3; step++) {
        const next = tok.replace(
          /^(?:[a-z0-9-]+(?:\/[a-z0-9-]+)?|\[[^\]]+\]):/i,
          "",
        );
        if (next === tok) break;
        tok = next;
      }
      if (
        !tok ||
        tok.startsWith("[") ||
        tok.startsWith("--") ||
        tok.includes(":")
      )
        continue;
      if (STYLESHEET_CLASSES.has(tok)) continue;

      const match = tok.match(
        /^(border-[trblxyse]|bg|border|text|ring)-([a-z0-9][a-z0-9-]*)(?:\/\d+)?$/,
      );
      if (!match) continue;
      const [, prefix, name] = match as [string, string, string];
      if (THEME_COLOR_TOKENS.has(name)) continue;
      // Stock Tailwind palette colors are counted under `stock-palette-color`.
      if (STOCK_PALETTE_VALUE_RE.test(name)) continue;

      if (
        prefix === "bg" &&
        (NON_COLOR_BG.has(name) ||
          name.startsWith("blend-") ||
          name.startsWith("size-") ||
          name.startsWith("position-") ||
          name.startsWith("clip-") ||
          name.startsWith("origin-") ||
          name.startsWith("gradient-") ||
          name.startsWith("linear-"))
      )
        continue;
      if (
        prefix === "border" &&
        (NON_COLOR_BORDER.has(name) ||
          /^\d+$/.test(name) ||
          name.startsWith("spacing-"))
      )
        continue;
      if (
        prefix.startsWith("border-") &&
        (NON_COLOR_BORDER_SIDE.has(name) || /^\d+$/.test(name))
      )
        continue;
      if (
        prefix === "text" &&
        (NON_COLOR_TEXT.has(name) ||
          name.startsWith("shadow-") ||
          name.startsWith("shimmer-"))
      )
        continue;
      if (
        prefix === "ring" &&
        (NON_COLOR_RING.has(name) ||
          /^\d+$/.test(name) ||
          name.startsWith("offset-"))
      )
        continue;

      found.push(tok);
    }
  }
  return found;
}

type Signal = {
  id: string;
  /** One line, printed beside the count: what to reach for instead. */
  instead: string;
  /** Paths (relative to src/frontend) whose prefix is exempt. */
  exempt?: string[];
  count(source: string): number;
};

const occurrences = (source: string, pattern: RegExp) =>
  source.match(pattern)?.length ?? 0;

const SIGNALS: Signal[] = [
  {
    id: "raw-button",
    instead:
      "ui/button.tsx — carries the focus ring, press, and disabled states",
    exempt: ["ui/"],
    count: (source) => occurrences(source, /<button[\s>]/g),
  },
  {
    id: "raw-form-control",
    instead: "ui/input.tsx — Input, Textarea, Select, Field",
    exempt: ["ui/"],
    count: (source) => occurrences(source, /<(input|textarea|select)[\s>]/g),
  },
  {
    id: "arbitrary-text-size",
    instead:
      "the semantic type scale — text-meta, text-label, text-body, text-item-title",
    exempt: ["styles/"],
    count: (source) => occurrences(source, /\btext-\[[0-9.]+px\]/g),
  },
  {
    id: "off-scale-radius",
    // rounded-[999px] is sanctioned: it is the squircle-preserving pill, and
    // rounded-full is the opt-out (see src/frontend/AGENTS.md).
    instead:
      "the radius scale — rounded-sm/md/lg/xl/2xl, rounded-control/row/popup",
    exempt: ["styles/"],
    count: (source) => {
      let n = 0;
      for (const match of source.matchAll(
        /\brounded-(?:\w+-)?\[calc\((\d+)px\s*\*\s*var\(--rf\)\)\]/g,
      ))
        if (!RADIUS_SCALE.has(Number(match[1]))) n++;
      return n;
    },
  },
  {
    id: "patched-control-height",
    // 20-64px is the control band: a hand-written height there is a button,
    // a row, or a field that stepped off the size scale. Taller boxes are
    // panels and media, which legitimately carry their own measurements.
    instead: "the Button size scale, or a row height token",
    exempt: ["ui/"],
    count: (source) => {
      let n = 0;
      for (const match of source.matchAll(/\b(?:min-)?h-\[(\d+)px\]/g)) {
        const px = Number(match[1]);
        if (px >= 20 && px <= 64) n++;
      }
      return n;
    },
  },
  {
    id: "adhoc-overlay",
    instead: "ui/modal.tsx or ui/sheet.tsx — focus trap, escape, scroll lock",
    exempt: ["ui/"],
    count: (source) => occurrences(source, /fixed inset-0/g),
  },
  {
    id: "raw-base-ui",
    instead: "wrap it in a ui/ primitive first, then use that",
    exempt: ["ui/"],
    count: (source) => occurrences(source, /from "@base-ui/g),
  },
  {
    id: "unknown-theme-token",
    instead:
      "semantic tokens defined in styles/tailwind.css (bg-panel, border-line, border-divider, text-fg, text-dim, text-dialog-title)",
    exempt: ["styles/"],
    count: (source) => findUnknownThemeTokens(source).length,
  },
  {
    id: "stock-palette-color",
    instead:
      "semantic tokens from styles/tailwind.css — never stock Tailwind palette colors (slate/gray/zinc/blue-500)",
    exempt: ["styles/"],
    count: (source) => occurrences(stripComments(source), STOCK_PALETTE_RE),
  },
  {
    id: "stock-shadow",
    instead:
      "smooth-shadow-xs/sm/md/lg or smooth-shadow-ring-sm/md/lg from styles/smooth-shadow.css",
    exempt: ["styles/"],
    count: (source) =>
      occurrences(
        stripComments(source),
        /(?<!smooth-)\bshadow-(?:2xs|xs|sm|md|lg|xl|2xl)\b/g,
      ),
  },
  {
    id: "raw-hex-color",
    instead: "semantic color tokens from styles/tailwind.css",
    exempt: ["styles/"],
    count: (source) =>
      occurrences(
        stripComments(source),
        /\b(?:bg|text|border|ring)-\[#[0-9a-fA-F]{3,8}\]/g,
      ),
  },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    // Test files render throwaway markup to assert against; counting it
    // would make deleting a test look like design-system progress.
    if (/\.test\.tsx?$/.test(entry)) continue;
    out.push(path);
  }
  return out;
}

const files = sourceFiles(FRONTEND).sort();
const counts = new Map<string, number>();
const perFile = new Map<string, Map<string, number>>();

for (const path of files) {
  const rel = relative(FRONTEND, path);
  const source = readFileSync(path, "utf8");
  for (const signal of SIGNALS) {
    if (signal.exempt?.some((prefix) => rel.startsWith(prefix))) continue;
    const n = signal.count(source);
    if (!n) continue;
    counts.set(signal.id, (counts.get(signal.id) ?? 0) + n);
    if (!perFile.has(signal.id)) perFile.set(signal.id, new Map());
    perFile.get(signal.id)!.set(rel, n);
  }
}

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? (argv[index + 1] ?? "") : undefined;
};

export type UiAuditResult = { id: string; count: number; budget: number }[];

/** Read by the budget test as well as the CLI. */
export function auditCounts(): UiAuditResult {
  const budgets = JSON.parse(readFileSync(BUDGET_FILE, "utf8")) as Record<
    string,
    number
  >;
  return SIGNALS.map((signal) => ({
    id: signal.id,
    count: counts.get(signal.id) ?? 0,
    budget: budgets[signal.id] ?? 0,
  }));
}

if (import.meta.main) {
  if (argv.includes("--save")) {
    // A ratchet saved from a dirty tree is not a ratchet. This repo runs
    // itself out of one shared checkout, so `src/frontend` routinely holds
    // another session's half-finished work — including its DELETIONS. Saving
    // then records a number the committed tree never had, and the guard goes
    // red on main the moment that session commits something else. Measure
    // what is committed: `git worktree add --detach /tmp/wt HEAD` and run the
    // audit there, or pass --force if the dirt is genuinely yours.
    const dirty = Bun.spawnSync(
      ["git", "status", "--porcelain", "--", relative(ROOT, FRONTEND)],
      { cwd: ROOT },
    )
      .stdout.toString()
      .trim();
    if (dirty && !argv.includes("--force")) {
      console.error(
        `Refusing to save: ${dirty.split("\n").length} uncommitted file(s) under ${relative(ROOT, FRONTEND)}.`,
      );
      console.error("Measure HEAD in a detached worktree, or pass --force.");
      process.exit(2);
    }
    const saved = Object.fromEntries(
      SIGNALS.map((s) => [s.id, counts.get(s.id) ?? 0]),
    );
    writeFileSync(BUDGET_FILE, `${JSON.stringify(saved, null, "\t")}\n`);
    console.log(`Wrote ${relative(ROOT, BUDGET_FILE)}`);
    process.exit(0);
  }

  const only = flag("files");
  if (only !== undefined) {
    const rows = [...(perFile.get(only) ?? new Map())].sort(
      (a, b) => b[1] - a[1],
    );
    if (!rows.length) {
      console.error(
        `No occurrences of "${only}". Signals: ${SIGNALS.map((s) => s.id).join(", ")}`,
      );
      process.exit(2);
    }
    for (const [file, n] of rows)
      console.log(`${String(n).padStart(4)}  ${file}`);
    process.exit(0);
  }

  const results = auditCounts();
  if (argv.includes("--json")) {
    console.log(JSON.stringify(results, null, 2));
    process.exit(results.some((r) => r.count > r.budget) ? 1 : 0);
  }

  const width = Math.max(...SIGNALS.map((s) => s.id.length));
  console.log(`${"signal".padEnd(width)}  count  budget`);
  for (const { id, count, budget } of results) {
    const over = count > budget;
    const under = count < budget;
    const mark = over ? "  OVER" : under ? `  -${budget - count}` : "";
    console.log(
      `${id.padEnd(width)}  ${String(count).padStart(5)}  ${String(budget).padStart(6)}${mark}`,
    );
  }
  const over = results.filter((r) => r.count > r.budget);
  if (over.length) {
    console.log("");
    for (const { id, count, budget } of over) {
      const signal = SIGNALS.find((s) => s.id === id)!;
      console.log(`${id}: ${count} exceeds the budget of ${budget}.`);
      console.log(`  Use ${signal.instead}`);
      console.log(`  Offenders: bun scripts/ui-audit.ts --files ${id}`);
    }
    process.exit(1);
  }
  if (results.some((r) => r.count < r.budget))
    console.log("\nUnder budget. Run --save to ratchet it down.");
}
