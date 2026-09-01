/**
 * One-shot Tailwind → StyleX codemod for src/frontend.
 *
 * Run: bun scripts/stylex-codemod.ts [--write]
 *
 * Source of truth is the COMPILED Tailwind sheet (styles/tailwind.css run
 * through the real compiler): whatever a utility means today is what its
 * StyleX style must say. Every class token found in a STATIC className
 * string is classified:
 *
 *   expressible  → a stylex.create entry (per token, so composition keeps
 *                  matching the class semantics), referenced through
 *                  stylex.props(...); hover/focus/active/disabled land under
 *                  pseudo keys, phone/desktop/motion-reduce under media keys;
 *   type roles   → the shared scale in styles/typography.stylex.ts;
 *   residual     → data-[…], group-*, arbitrary selectors [&…], has(),
 *                  starting-style, ::-webkit-*, ancestor-conditioned rules,
 *                  shadows/rings built on --tw-* plumbing: the class stays
 *                  in markup and its exact compiled rule moves verbatim to
 *                  styles/residual.css (parity by construction);
 *   unknown      → left untouched and REPORTED loudly.
 *
 * Elements with dynamic classNames ({…}, template literals, cn()) are left
 * for the follow-up conversion waves. Idempotent-ish: files already carrying
 * a `@stylexjs/stylex` import are skipped.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const FRONTEND = join(
  import.meta.dir,
  "../packages/core/opensession-server/src/frontend",
);
const SHEET =
  (process.argv.find((a) => a.endsWith(".css")) as string | undefined) ??
  "/tmp/tw-current.css";
const WRITE = process.argv.includes("--write");
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  return i >= 0 ? Number(process.argv[i + 1]) : undefined;
})();
const ONLY = (() => {
  const i = process.argv.indexOf("--only");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

// ── parse the compiled sheet ────────────────────────────────────────────────

type Decl = { prop: string; value: string };
interface StyleObj {
  [key: string]: string | StyleObj;
}
type TokenStyle = { name: string; obj: StyleObj };
const unescapeSel = (s: string) => s.replace(/\\/g, "");

function parseDecls(body: string): Decl[] {
  const out: Decl[] = [];
  for (const part of body.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    out.push({
      prop: part.slice(0, i).trim(),
      value: part.slice(i + 1).trim(),
    });
  }
  return out;
}

/** Pseudo-classes/elements StyleX can express, mapped to its key syntax. */
const PSEUDO_MAP: Record<string, string> = {
  ":hover": ":hover",
  ":focus": ":focus",
  ":focus-visible": ":focusVisible",
  ":focus-within": ":focusWithin",
  ":active": ":active",
  ":disabled": ":disabled",
  ":visited": ":visited",
  "::before": "::before",
  "::after": "::after",
  "::placeholder": "::placeholder",
  "::selection": "::selection",
};

const rules: Rule[] = [];
const src = readFileSync(SHEET, "utf8");

/**
 * Split a RAW (still-escaped) simple selector into variant chain + base token
 * + trailing pseudo. Variants are the `name\:` segments Tailwind escapes into
 * the class name; splitting must ignore `\:` pairs inside [...] groups
 * (arbitrary properties/values contain their own escaped colons).
 */
function splitSelector(raw: string): {
  variants: string[];
  token: string;
  pseudo: string;
} | null {
  if (!raw.startsWith(".")) return null;
  let body = raw.slice(1);
  // trailing pseudo(s): real colons not preceded by a backslash
  const pseudoRe = /((?:::?[-a-z]+)+)$/;
  let pseudo = "";
  const pm = pseudoRe.exec(body);
  if (pm && !(pm.index > 0 && body[pm.index - 1] === "\\")) {
    // only a pseudo when the matched text starts at a real colon boundary
    if (pm.index === 0 || body[pm.index - 1] !== "\\") {
      pseudo = pm[1];
      body = body.slice(0, pm.index);
    }
  }
  // segment on \: outside brackets
  const variants: string[] = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (
      ch === ":" &&
      i > 0 &&
      body[i - 1] === "\\" &&
      depth === 0 &&
      cur !== ""
    ) {
      variants.push(cur.replace(/\\/g, ""));
      cur = "";
      continue;
    }
    if (ch === "\\") continue;
    cur += ch;
  }
  if (cur === "") return null;
  return { variants, token: cur, pseudo };
}

function splitSourceToken(
  token: string,
): NonNullable<ReturnType<typeof splitSelector>> | null {
  let escaped = "";
  let depth = 0;
  for (const ch of token) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    escaped += ch === ":" && depth === 0 ? "\\:" : ch;
  }
  return splitSelector("." + escaped);
}

function splitSelectorList(selector: string): string[] {
  const out: string[] = [];
  let current = "";
  let depth = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if ((ch === "[" || ch === "(") && selector[i - 1] !== "\\") depth++;
    if ((ch === "]" || ch === ")") && selector[i - 1] !== "\\") depth--;
    if (ch === "," && selector[i - 1] !== "\\" && depth === 0) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  if (current) out.push(current);
  return out;
}

function balancedClose(chunk: string, open: number): number {
  let depth = 1;
  for (let i = open + 1; i < chunk.length; i++) {
    if (chunk[i] === "{") depth++;
    else if (chunk[i] === "}" && --depth === 0) return i;
  }
  return chunk.length;
}

function nestedBlocks(
  body: string,
): Array<{ header: string; start: number; end: number; body: string }> {
  const blocks: Array<{
    header: string;
    start: number;
    end: number;
    body: string;
  }> = [];
  let cursor = 0;
  while (cursor < body.length) {
    const open = body.indexOf("{", cursor);
    if (open < 0) break;
    const boundary = Math.max(
      body.lastIndexOf(";", open),
      body.lastIndexOf("}", open),
    );
    const header = body.slice(boundary + 1, open).trim();
    const close = balancedClose(body, open);
    blocks.push({
      header,
      start: boundary + 1,
      end: close + 1,
      body: body.slice(open + 1, close),
    });
    cursor = close + 1;
  }
  return blocks;
}

function directDeclarations(
  body: string,
  blocks: ReturnType<typeof nestedBlocks>,
): Decl[] {
  let plain = "";
  let cursor = 0;
  for (const block of blocks) {
    plain += body.slice(cursor, block.start);
    cursor = block.end;
  }
  plain += body.slice(cursor);
  return parseDecls(plain);
}

function collectClassBody(
  parts: NonNullable<ReturnType<typeof splitSelector>>,
  body: string,
  at?: string,
  pseudo = parts.pseudo,
): void {
  const blocks = nestedBlocks(body);
  const decls = directDeclarations(body, blocks);
  if (decls.length > 0)
    rules.push({
      token: parts.token,
      variants: parts.variants,
      pseudo,
      at,
      decls,
    });
  for (const block of blocks) {
    if (block.header.startsWith("@media"))
      collectClassBody(parts, block.body, block.header, pseudo);
    else if (block.header.startsWith("@supports"))
      collectClassBody(parts, block.body, at, pseudo);
    else if (block.header.startsWith("&:"))
      collectClassBody(parts, block.body, at, block.header.slice(1));
    else
      rules.push({
        token: parts.token,
        variants: parts.variants,
        pseudo: "__unsupported",
        at,
        decls: [],
      });
  }
}

function walk(chunk: string, at?: string) {
  let i = 0;
  while (i < chunk.length) {
    const open = chunk.indexOf("{", i);
    if (open < 0) break;
    const boundary = Math.max(
      chunk.lastIndexOf(";", open),
      chunk.lastIndexOf("}", open),
    );
    const selRaw = chunk.slice(boundary + 1, open).trim();
    const close = balancedClose(chunk, open);
    const body = chunk.slice(open + 1, close);
    if (selRaw.startsWith("@")) {
      walk(body, selRaw.startsWith("@media") ? selRaw : at);
    } else {
      for (const selPart of splitSelectorList(selRaw)) {
        const parts = splitSelector(selPart.trim());
        if (parts) collectClassBody(parts, body, at);
      }
    }
    i = close + 1;
  }
}
walk(src);

type Rule = {
  token: string;
  variants: string[];
  pseudo?: string;
  at?: string;
  decls: Decl[];
};

const byToken = new Map<string, Rule[]>();
for (const r of rules) {
  const list = byToken.get(r.token) ?? [];
  list.push(r);
  byToken.set(r.token, list);
}

// ── declaration translation ─────────────────────────────────────────────────

/** Tailwind's runtime plumbing variables and their registered initial values;
 *  used when a rule READS one it does not itself assign. */
const TW_VAR_DEFAULTS: Record<string, string> = {
  "--tw-border-style": "solid",
  "--tw-content": '""',
  "--tw-translate-x": "0",
  "--tw-translate-y": "0",
  "--tw-translate-z": "0",
  "--tw-scale-x": "1",
  "--tw-scale-y": "1",
  "--tw-scale-z": "1",
};

function camel(prop: string): string | null {
  if (prop.startsWith("--")) return null; // custom property set → not expressible
  if (/^-webkit-[a-z0-9-]+$/.test(prop))
    return (
      "Webkit" +
      prop
        .slice(8)
        .replace(/(^|-)([a-z])/g, (_m, _dash, ch: string) => ch.toUpperCase())
    );
  if (/^-moz-[a-z0-9-]+$/.test(prop))
    return (
      "Moz" +
      prop
        .slice(5)
        .replace(/(^|-)([a-z])/g, (_m, _dash, ch: string) => ch.toUpperCase())
    );
  if (!/^[a-z][a-z0-9-]*$/.test(prop)) return null;
  return prop.replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase());
}

/**
 * Translate one compiled rule's declarations. Custom-property assignments in
 * the rule are captured and substituted into later reads in the SAME rule
 * (that is how Tailwind chains translate/scale axes); reads with no local
 * assignment fall back to the registered defaults above. Any value still
 * leaning on --tw-* plumbing afterwards makes the whole token residual.
 */
const VALUE_SPECIALS: Record<string, string> = {
  // Tailwind compiles rounded-full to an enormous px constant; spell the
  // standard equivalent so generated styles stay reviewable.
  "3.40282e38px": "calc(infinity * 1px)",
};

function translateRule(decls: Decl[]): { ok: StyleObj; good: boolean } {
  const local = new Map<string, string>();
  for (const d of decls) {
    if (d.prop.startsWith("--")) local.set(d.prop, d.value);
  }
  const obj: StyleObj = {};
  for (const d of decls) {
    if (d.prop.startsWith("--")) continue;
    let value = d.value.replace(
      /var\((--tw-[a-z-]+)(?:,([^()]*))?\)/g,
      (_m, v: string, fb?: string) => {
        if (local.has(v)) return local.get(v)!;
        if (fb !== undefined && fb.trim() !== "") return fb.trim();
        const def = TW_VAR_DEFAULTS[v];
        if (def !== undefined) return def;
        return `\u0000KEEP:${v}`;
      },
    );
    if (value.includes("\u0000KEEP")) return { ok: {}, good: false };
    const p = camel(d.prop);
    if (!p) return { ok: {}, good: false };
    obj[p] = VALUE_SPECIALS[value] ?? value;
  }
  return { ok: obj, good: true };
}

const TYPE_ROLES: Record<string, string> = {
  "text-meta": "meta",
  "text-label": "label",
  "text-supporting": "supporting",
  "text-control-label": "controlLabel",
  "text-body": "body",
  "text-item-title": "itemTitle",
  "text-dialog-title": "dialogTitle",
  "text-section-title": "sectionTitle",
  "text-page-title": "pageTitle",
  "text-stat": "stat",
};

/** Expressible variants: name → how the StyleX key is formed. */
type VariantKey =
  | { kind: "pseudo"; key: string }
  | { kind: "media"; query: string };

const PSEUDO_VARIANTS: Record<string, string> = {
  hover: ":hover",
  focus: ":focus",
  "focus-visible": ":focusVisible",
  "focus-within": ":focusWithin",
  active: ":active",
  disabled: ":disabled",
  visited: ":visited",
  placeholder: "::placeholder",
  selection: "::selection",
  before: "::before",
  after: "::after",
};

const MEDIA_VARIANTS: Record<string, string> = {
  phone: "(max-width: 720px)",
  desktop: "(min-width: 721px)",
  "motion-reduce": "(prefers-reduced-motion: reduce)",
  "motion-safe": "(prefers-reduced-motion: no-preference)",
  sm: "(min-width: 40rem)",
  md: "(min-width: 48rem)",
  lg: "(min-width: 64rem)",
  "max-sm": "(max-width: 39.999rem)",
};

const MEDIA_CANONICAL: Record<string, string> = {
  "(max-width:720px)": "(max-width: 720px)",
  "(min-width:721px)": "(min-width: 721px)",
};

function normalizeQuery(qRaw: string): string | null {
  const q = qRaw.replace(/^@media\s*/, "").replace(/\s+/g, "");
  if (q === "(hover:hover)") return "(hover: hover)";
  if (q === "(prefers-reduced-motion:no-preference)")
    return "(prefers-reduced-motion: no-preference)";
  if (q === "(width<40rem)") return "(max-width: 39.999rem)";
  const widthBelow = /^\(width<(\d+)px\)$/.exec(q);
  if (widthBelow) return `(max-width: ${Number(widthBelow[1]) - 1}px)`;
  // MQ level 4 range syntax on the compiled sheet (Tailwind v4 emits it for
  // sm/md/lg/…): >= and <= map 1:1 onto min-/max-width with the same unit.
  const widthAtLeast = /^\(width>=([0-9.]+)(px|rem)\)$/.exec(q);
  if (widthAtLeast) return `(min-width: ${widthAtLeast[1]}${widthAtLeast[2]})`;
  const widthAtMost = /^\(width<=([0-9.]+)(px|rem)\)$/.exec(q);
  if (widthAtMost) return `(max-width: ${widthAtMost[1]}${widthAtMost[2]})`;
  if (q === "(width>=40rem)") return "(min-width: 40rem)";
  if (q === "(width>=48rem)") return "(min-width: 48rem)";
  const canon = MEDIA_CANONICAL[q];
  if (canon) return canon.slice(0, -1) === canon ? canon : canon;
  if (
    /^\(max-width:[0-9.]+(px|rem)\)$/.test(q) ||
    /^\(min-width:[0-9.]+(px|rem)\)$/.test(q) ||
    q === "(prefers-reduced-motion:reduce)"
  ) {
    // re-space for readability
    return q.replace(/^\(/, "(").replace(": ", ":");
  }
  return null;
}

function variantToKey(name: string): VariantKey | null {
  if (PSEUDO_VARIANTS[name])
    return { kind: "pseudo", key: PSEUDO_VARIANTS[name] };
  const mq = MEDIA_VARIANTS[name];
  if (mq) return { kind: "media", query: mq };
  // arbitrary width variants: max-[560px], min-[861px]
  const arb = /^(max|min)-\[(\d+)px\]$/.exec(name);
  if (arb) {
    return {
      kind: "media",
      query:
        arb[1] === "max"
          ? `(max-width: ${Number(arb[2]) - 1}px)`
          : `(min-width: ${arb[2]}px)`,
    };
  }
  void normalizeQuery;
  return null;
}

/** Merge a translated rule into the token's nested style object. */
function mergeInto(
  obj: StyleObj,
  path: Array<VariantKey>,
  style: StyleObj,
): boolean {
  let cur: any = obj;
  for (const k of path) {
    const key = k.kind === "pseudo" ? k.key : `@media ${k.query}`;
    cur[key] ??= {};
    cur = cur[key];
  }
  Object.assign(cur, style);
  return true;
}

/** Build the StyleX object for one class token.
 *  Returns: TokenStyle (converted), "residual" (keep class, rule extracted
 *  verbatim), or null (no compiled rule at all — probably a component class). */
function tokenToStyle(
  token: string,
  variants: string[],
): TokenStyle | null | "residual" {
  const keys: Array<VariantKey | null> = variants.map(variantToKey);
  if (keys.some((k) => k === null)) return "residual";
  const list = byToken.get(token);
  if (!list || list.length === 0) return null;
  // Only rules whose EXACT variant chain we are handling may contribute;
  // anything else about this token (e.g. a data-[…] rule) makes it residual.
  const wanted = JSON.stringify(variants);
  const matching = list.filter((r) => JSON.stringify(r.variants) === wanted);
  const others = list.filter((r) => !matching.includes(r));
  if (matching.length === 0) return "residual";
  void others;
  const obj: StyleObj = {};
  for (const r of matching) {
    const path: Array<VariantKey> = keys.filter(
      (key): key is VariantKey => key?.kind === "media",
    );
    if (r.at) {
      const query = normalizeQuery(r.at);
      if (!query) return "residual";
      if (!path.some((key) => key.kind === "media" && key.query === query))
        path.push({ kind: "media", query });
    }
    if (r.pseudo) {
      const pk = pseudoKey(r.pseudo);
      if (!pk) return "residual";
      path.push(pk);
    }
    const { ok, good } = translateRule(r.decls);
    if (!good) return "residual";
    mergeInto(obj, path, ok);
  }
  injectPseudoContent(obj);
  injectCornerShape(obj, token.includes("rounded-full"));
  return Object.keys(obj).length > 0 ? { name: token, obj } : "residual";
}

/** A trailing pseudo on the SELECTOR (`.x:hover` behind `hover:` variants). */
function pseudoKey(chain: string): VariantKey | null {
  const k = PSEUDO_VARIANTS[chain.replace(/^:+/, "")];
  if (k) return { kind: "pseudo", key: chain };
  return chain === ":hover" ||
    chain === ":active" ||
    chain === ":disabled" ||
    chain === ":focus" ||
    chain === ":focus-visible" ||
    chain === "::before" ||
    chain === "::after"
    ? { kind: "pseudo", key: chain }
    : null;
}

/** Tailwind renders before:/after: pseudos through the registered --tw-content
 *  default (""); StyleX needs the content spelled inside each ::before/::after. */
function injectPseudoContent(obj: StyleObj) {
  for (const [k, v] of Object.entries(obj)) {
    if ((k === "::before" || k === "::after") && v && typeof v === "object") {
      const o = v as StyleObj;
      if (!o.content) o.content = '""';
    } else if (k.startsWith("@media") && v && typeof v === "object") {
      injectPseudoContent(v as StyleObj);
    }
  }
}

function injectCornerShape(obj: StyleObj, round: boolean): void {
  if (
    Object.keys(obj).some((key) => /border.*radius/i.test(key)) &&
    obj.cornerShape === undefined
  ) {
    obj.cornerShape = round ? "round" : "var(--cs)";
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object")
      injectCornerShape(value as StyleObj, round);
  }
}

function camelName(token: string): string {
  const n = token
    .replace(/[^a-zA-Z0-9]+(.)/g, (_m, c: string) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, "");
  return /^[0-9]/.test(n) ? "u" + n : n;
}

// Generate a checked StyleX compatibility map for utility strings that arrive
// from a merged branch. This keeps merge migrations fail-closed: only tokens
// translated from the current compiled Tailwind sheet enter the map; selectors
// StyleX cannot represent remain residual and unknown tokens are refused.
const compatTokensPath = (() => {
  const i = process.argv.indexOf("--generate-compat");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();
if (compatTokensPath) {
  const outputIndex = process.argv.indexOf("--output");
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  if (!output) throw new Error("--generate-compat requires --output <path>");
  const requested = readFileSync(compatTokensPath, "utf8")
    .split(/\s+/)
    .filter(Boolean);
  const converted = new Map<string, StyleObj>();
  const typeRoles = new Map<string, string>();
  const refused: string[] = [];
  for (const token of requested) {
    const parts = splitSourceToken(token);
    if (!parts) {
      refused.push(token);
      continue;
    }
    if (parts.variants.length === 0 && TYPE_ROLES[parts.token]) {
      typeRoles.set(token, TYPE_ROLES[parts.token]);
      continue;
    }
    const result = tokenToStyle(parts.token, parts.variants);
    if (!result || result === "residual") refused.push(token);
    else converted.set(token, result.obj);
  }
  if (refused.length > 0) {
    throw new Error(
      `Compatibility map refused non-StyleX tokens:\n${refused.join("\n")}`,
    );
  }
  const names = new Map<string, string>();
  const seen = new Set<string>();
  for (const token of converted.keys()) {
    const base = camelName(token) || "utility";
    let name = base;
    let suffix = 2;
    while (seen.has(name)) name = `${base}${suffix++}`;
    seen.add(name);
    names.set(token, name);
  }
  const entries = [...converted.entries()]
    .map(([token, obj]) => {
      const json = JSON.stringify(obj, null, "\t\t").replace(/\n/g, "\n\t");
      const body = json.replace(/"([a-zA-Z][a-zA-Z0-9]*)":/g, "$1:");
      return `\t${names.get(token)}: ${body},`;
    })
    .join("\n");
  const mapping = [
    ...[...converted.keys()].map(
      (token) => `\t${JSON.stringify(token)}: sx.${names.get(token)},`,
    ),
    ...[...typeRoles.entries()].map(
      ([token, role]) => `\t${JSON.stringify(token)}: typography.${role},`,
    ),
  ].join("\n");
  writeFileSync(
    output,
    `/** Generated by scripts/stylex-codemod.ts from the compiled utility sheet. */\nimport * as stylex from "@stylexjs/stylex";\nimport { type as typography } from "./typography.stylex";\n\nconst sx = stylex.create({\n${entries}\n});\n\nexport const utilityStyles = {\n${mapping}\n} as const;\nexport type UtilityClass = keyof typeof utilityStyles;\n`,
  );
  console.log(
    `generated ${converted.size + typeRoles.size} compatibility styles in ${output}`,
  );
  process.exit(0);
}

// ── JSX rewriting ───────────────────────────────────────────────────────────

const report = {
  files: 0,
  converted: 0,
  elements: 0,
  skippedDynamic: 0,
  unknownTokens: new Map<string, number>(),
};

function relImport(fromFile: string, target: string): string {
  const rel = relative(join(FRONTEND, "."), target).replace(/\.ts$/, "");
  const depth = relative(fromFile.split("/").slice(0, -1).join("/"), "").split(
    "/",
  ).length;
  const prefix = "./".repeat(1);
  void depth;
  void prefix;
  // relative() from the FILE's dir:
  const fromDir = fromFile.split("/").slice(0, -1).join("/");
  let relPath = relative(fromDir, target).replace(/\.ts$/, "");
  if (!relPath.startsWith(".")) relPath = "./" + relPath;
  return relPath;
  void rel;
}

function walkFiles(dir: string, out: string[] = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e === "styles" && dir === FRONTEND) continue; // stylesheets themselves
      walkFiles(p, out);
    } else if (/\.(tsx|ts)$/.test(e) && !/\.(test)\./.test(e)) out.push(p);
  }
  return out;
}

const files = walkFiles(FRONTEND);

let doneCount = 0;
for (const file of files) {
  if (LIMIT && doneCount >= LIMIT) break;
  if (ONLY && !file.includes(ONLY)) continue;
  const srcText = readFileSync(file, "utf8");
  if (srcText.includes("@stylexjs/stylex")) continue; // already migrated / foundation file
  report.files++;

  // Find STATIC className="..." attributes only.
  const attrRe = /\bclassName="([^"]*)"/g;
  type Hit = { start: number; end: number; full: string; classes: string[] };
  const hits: Hit[] = [];
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(srcText))) {
    hits.push({
      start: m.index,
      end: m.index + m[0].length,
      full: m[0],
      classes: m[1].split(/\s+/).filter(Boolean),
    });
  }
  if (hits.length === 0) continue;

  const usedStyles = new Map<string, StyleObj>(); // full class token -> style obj
  const usedTypeRoles = new Map<string, string>(); // class token -> type.x key
  const fileUnknown: string[] = [];
  const fileKept: string[] = [];

  for (const hit of hits) {
    for (const token of hit.classes) {
      if (
        usedStyles.has(token) ||
        usedTypeRoles.has(token) ||
        fileUnknown.includes(token) ||
        fileKept.includes(token)
      )
        continue;
      const parts = splitSourceToken(token);
      if (!parts) {
        fileUnknown.push(token);
        continue;
      }
      const { variants, token: base } = parts;
      // plain type roles (no variants) map onto the shared scale
      if (variants.length === 0 && TYPE_ROLES[base]) {
        usedTypeRoles.set(token, TYPE_ROLES[base]);
        continue;
      }
      const res = tokenToStyle(base, variants);
      if (res == null) {
        // not in the compiled sheet: a component class (markdown,
        // mono-input, …) or a marker like `group` — keep it verbatim.
        fileKept.push(token);
      } else if (res === "residual") {
        fileKept.push(token); // stays in markup; rule lands in residual.css
      } else {
        usedStyles.set(token, res.obj);
      }
    }
  }

  if (fileUnknown.length > 0 && !WRITE) {
    console.log(
      `${relative(FRONTEND, file)}: ${fileUnknown.length} unknown tokens, skipping in dry-run`,
    );
  }

  // Rewrite hits: replace className="..." with spread + optional residual class.
  let out = srcText;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let elementCount = 0;
  for (let idx = hits.length - 1; idx >= 0; idx--) {
    const hit = hits[idx];
    const sxTokens = hit.classes.filter((t) => usedStyles.has(t));
    const typeRoles = hit.classes.filter((t) => usedTypeRoles.has(t));
    const residual = hit.classes.filter(
      (t) => !usedStyles.has(t) && !usedTypeRoles.has(t),
    );
    if (sxTokens.length === 0 && typeRoles.length === 0) continue;
    const args = [
      ...sxTokens.map((t) => `sx.${camelName(t)}`),
      ...typeRoles.map((t) => `typography.${usedTypeRoles.get(t)}`),
    ];
    const parts: string[] = [];
    if (residual.length > 0) parts.push(`className="${residual.join(" ")}"`);
    parts.push(`{...stylex.props(${args.join(", ")})}`);
    edits.push({ start: hit.start, end: hit.end, text: parts.join(" ") });
    elementCount++;
  }
  if (edits.length === 0) continue;

  for (const e of edits) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }

  // Imports + create block: find where the import block ENDS with a small
  // statement-aware scan (a naive "last line starting with import" landed
  // inside multi-line import braces).
  const ls = out.split("\n");
  let importEnd = -1;
  let inImport = false;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    if (!inImport && /^import[\s{"'*]/.test(l)) {
      inImport = true;
    }
    if (inImport) {
      importEnd = i;
      if (/;\s*$/.test(l) || !/^import[\s{"'*]/.test(l) === false) {
        // single-line import ends here
      }
      if (/;\s*$/.test(l)) inImport = false;
    }
  }
  if (importEnd < 0) continue; // no imports?? leave file alone
  const importLines: string[] = ['import * as stylex from "@stylexjs/stylex";'];
  if (usedTypeRoles.size > 0)
    importLines.push(
      // aliased: many components have a local value named `type`
      `import { type as typography } from "${relImport(file, join(FRONTEND, "styles/typography.stylex.ts"))}";`,
    );
  ls.splice(importEnd + 1, 0, ...importLines);
  out = ls.join("\n");

  const anchor =
    out
      .split("\n")
      .slice(0, importEnd + 1 + importLines.length)
      .join("\n").length + 1;

  const entries = [...usedStyles.entries()]
    .map(([tok, obj]) => {
      const json = JSON.stringify(obj, null, "\t\t").replace(/\n/g, "\n\t");
      // unquote property keys that are valid identifiers
      const body = json.replace(/"([a-zA-Z][a-zA-Z0-9]*)":/g, "$1:");
      return `\t${camelName(tok)}: ${body},`;
    })
    .join("\n");
  const createBlock =
    `\n/* Converted from Tailwind utilities; names mirror the original class tokens. */\n` +
    `const sx = stylex.create({\n${entries}\n});\n`;
  out = out.slice(0, anchor) + createBlock + out.slice(anchor);

  if (WRITE) writeFileSync(file, out);
  report.elements += elementCount;
  doneCount++;
}

console.log(`files scanned: ${report.files}`);
console.log(`elements rewritten: ${report.elements}`);
console.log(`unknown token kinds: ${report.unknownTokens.size}`);
const top = [...report.unknownTokens.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 40);
for (const [t, n] of top) console.log(`  ${n}\t${t}`);
