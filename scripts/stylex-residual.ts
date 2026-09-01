/**
 * Generate styles/residual.css: the exact compiled Tailwind rules for every
 * class token still present in frontend markup that StyleX cannot express
 * (data-[…] variants, group-*, arbitrary selectors, structural pseudos,
 * container queries, component classes shipped by stylesheets…).
 *
 * Declarations are copied from the compiled sheet. A generated specificity
 * bridge lets unsupported state selectors override StyleX base declarations
 * without !important; this stylesheet is hand-editable afterwards.
 *
 * Run after conversions, before cutover:
 *   ./node_modules/.bin/tailwindcss -i packages/core/opensession-server/src/frontend/styles/tailwind.css -o /tmp/tw-current.css
 *   bun scripts/stylex-residual.ts [/tmp/tw-current.css] [--write]
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const FRONTEND = join(
  import.meta.dir,
  "../packages/core/opensession-server/src/frontend",
);
const SHEET =
  process.argv.find((a) => a.endsWith(".css")) ?? "/tmp/tw-current.css";
const WRITE = process.argv.includes("--write");

// ── collect every class token left in markup ────────────────────────────────
function walkFiles(dir: string, out: string[] = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, out);
    else if (/\.(tsx|ts|html)$/.test(e) && !e.includes(".test.")) out.push(p);
  }
  return out;
}

const tokens = new Set<string>();
const add = (text: string) => {
  for (const token of text.split(/\s+/)) if (token) tokens.add(token);
};

/** Selectors StyleX cannot represent directly. These can live in exported
 * class constants that are consumed from another module, so collecting only
 * className/cn() call sites in the declaring file misses them. */
const looksResidual = (token: string) =>
  token.startsWith("[") ||
  /^(?:phone|desktop):\[/.test(token) ||
  /^@\[/.test(token) ||
  /(?:^|:)(?:data-\[|data-active|aria-|group(?:$|[/:-])|peer(?:$|[/:-])|has-|supports-\[|enabled:|empty:|shadow-\[)/.test(
    token,
  ) ||
  /(?:^|:)(?:before:|after:)?(?:backdrop-|drop-shadow$|drop-shadow-|shadow-|ring-)/.test(
    token,
  ) ||
  /(?:^|:)phone:[^\s]+!$/.test(token) ||
  /^(?:selection:|first:|last:|-space-|space-y-|divide-|md:group-|phone:\*|smooth-shadow|plate-sheen)/.test(
    token,
  ) ||
  /^(?:@max-|backdrop-(?:blur|saturate)-|bg-gradient-|from-|to-|focus-ring$|focus-visible:(?:outline|ring)-|outline(?:-|$)|ring-|shadow-(?:none$|\(|\[)|snap-|tabular-nums$|touch-pan-y$|hover:brightness-|repo-tile$|ws-summary-(?:pr|review)-group$)/.test(
    token,
  );

let valueDeclarations = new Map<string, ts.Expression>();
let functionReturns = new Map<string, ts.Expression[]>();
const resolving = new Set<string>();

function collectResolved(node: ts.Node, file: ts.SourceFile): void {
  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop))
        collectClassValue(prop.initializer, file);
    }
    return;
  }
  collectClassValue(node, file);
}

/** Walk only positions that can produce a class value. In particular, do not
 * recursively harvest every string below cn(): `mode === "hover"` is state,
 * not a class, and StyleX declaration values such as "flex" are not markup. */
function collectClassValue(node: ts.Node, file: ts.SourceFile): void {
  if (ts.isStringLiteralLike(node)) {
    add(node.text);
    return;
  }
  if (ts.isIdentifier(node)) {
    const value = valueDeclarations.get(node.text);
    if (value && !resolving.has(node.text)) {
      resolving.add(node.text);
      collectResolved(value, file);
      resolving.delete(node.text);
    }
    return;
  }
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    collectClassValue(node.expression, file);
    return;
  }
  if (ts.isCallExpression(node)) {
    const name = node.expression.getText(file);
    for (const result of functionReturns.get(name) ?? [])
      collectClassValue(result, file);
    return;
  }
  if (ts.isTemplateExpression(node)) {
    add(node.head.text);
    for (const span of node.templateSpans) {
      collectClassValue(span.expression, file);
      add(span.literal.text);
    }
    return;
  }
  if (ts.isConditionalExpression(node)) {
    collectClassValue(node.whenTrue, file);
    collectClassValue(node.whenFalse, file);
    return;
  }
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      collectClassValue(node.right, file);
    } else if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      collectClassValue(node.left, file);
      collectClassValue(node.right, file);
    }
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) collectClassValue(element, file);
    return;
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop))
        add(prop.name.getText(file).replace(/^['"]|['"]$/g, ""));
    }
    return;
  }
  if (ts.isParenthesizedExpression(node))
    collectClassValue(node.expression, file);
}

for (const f of walkFiles(FRONTEND)) {
  if (f.endsWith(".html")) {
    for (const match of readFileSync(f, "utf8").matchAll(/\bclass="([^"]*)"/g))
      add(match[1]);
    continue;
  }
  const text = readFileSync(f, "utf8");
  const file = ts.createSourceFile(
    f,
    text,
    ts.ScriptTarget.Latest,
    true,
    f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  valueDeclarations = new Map();
  functionReturns = new Map();
  function index(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      valueDeclarations.set(node.name.text, node.initializer);
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      const returns: ts.Expression[] = [];
      function findReturn(child: ts.Node) {
        if (ts.isReturnStatement(child) && child.expression)
          returns.push(child.expression);
        else ts.forEachChild(child, findReturn);
      }
      if (node.body) findReturn(node.body);
      functionReturns.set(node.name.text, returns);
    }
    ts.forEachChild(node, index);
  }
  index(file);
  // Shared class modules export finished class strings. Their consumers only
  // expose an imported identifier at the JSX site, which this file-local AST
  // resolver cannot follow. Residual-looking string tokens are narrow enough
  // to collect globally; the compiled Tailwind sheet below remains the final
  // authority and drops anything that is not an actual utility.
  function collectResidualLiterals(node: ts.Node) {
    if (ts.isStringLiteralLike(node)) {
      for (const token of node.text.split(/\s+/))
        if (looksResidual(token)) tokens.add(token);
    }
    ts.forEachChild(node, collectResidualLiterals);
  }
  collectResidualLiterals(file);
  // The mechanical converter could not see through imported shared class
  // maps. Audit every literal outside stylex.create() in *-classes modules;
  // the compiled sheet filters prose/import paths, while expressible utility
  // tokens intentionally trip the cutover gate below until converted.
  if (/classes\.(?:ts|tsx)$/.test(f)) {
    function collectSharedClassLiterals(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        (node.expression.getText(file) === "stylex.create" ||
          node.expression.getText(file) === "utilityClassName")
      )
        return;
      if (ts.isStringLiteralLike(node)) add(node.text);
      ts.forEachChild(node, collectSharedClassLiterals);
    }
    collectSharedClassLiterals(file);
  }
  // Imported class constants can live outside a *-classes module. Follow
  // exported declarations as another cross-file boundary; exact matching
  // against the compiled sheet below discards event names and prose values.
  function collectExportedClassLiterals(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      /(?:CLASS|TONE)/.test(node.name.text) &&
      node.initializer
    ) {
      function collect(node: ts.Node) {
        if (
          ts.isCallExpression(node) &&
          node.expression.getText(file) === "utilityClassName"
        )
          return;
        if (ts.isStringLiteralLike(node)) add(node.text);
        ts.forEachChild(node, collect);
      }
      collect(node.initializer);
    }
    ts.forEachChild(node, collectExportedClassLiterals);
  }
  collectExportedClassLiterals(file);
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(file);
      if (name === "mergeStylexClassName" || name === "mergeStylexProps") {
        if (node.arguments[0]) collectClassValue(node.arguments[0], file);
        return;
      }
      if (name === "cn" || name === "clsx") {
        for (const arg of node.arguments) collectClassValue(arg, file);
        return;
      }
    }
    if (
      ts.isJsxAttribute(node) &&
      /ClassName$/.test(node.name.getText(file)) &&
      node.initializer
    ) {
      if (ts.isStringLiteral(node.initializer)) add(node.initializer.text);
      else if (
        ts.isJsxExpression(node.initializer) &&
        node.initializer.expression
      ) {
        collectClassValue(node.initializer.expression, file);
      }
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
}

// ── walk the compiled sheet, keep matched rules verbatim ────────────────────
const src = readFileSync(SHEET, "utf8");
// Drop candidates the sheet has never heard of: component classes styled
// elsewhere (markdown, mono-input…) and prose strings.
for (const token of [...tokens]) {
  const escaped = token.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
  const exact = new RegExp(
    `\\.${escaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s,{.:#\\[])`,
  ).test(src);
  if (!exact) tokens.delete(token);
}

const semanticHooks = new Set([
  "app",
  "app-body",
  "app-header-actions",
  "app-header-overlay",
  "archived-row",
  "detail-pane",
  "mobile-detail",
  "panel-pr-plate",
  "repo-tile",
  "ring-panel",
  "settings-sheet",
  "sidebar-collapsed",
  "session-info-status",
  "session-menu-sep",
  "session-tab-new",
  "session-tab-reorder",
  "session-tab-view",
  "session-tabs",
  "staging-icon",
  // Dynamic tone strings are also protocol values consumed by status helpers;
  // keep their semantic spelling while the components map the same values.
  "text-accent",
  "text-blue",
  "text-faint",
  "text-green",
  "text-purple",
  "text-yellow",
  "tool-pre",
  "viewer-header",
  "viewer-header-actions",
  "viewer-panel",
  "workspace-info-panel",
  "ws-summary-band",
  "ws-summary-pr-group",
  "ws-summary-review-group",
]);
const compatibilityStyles = new Set(
  [
    ...readFileSync(
      join(FRONTEND, "styles/utility-compat.stylex.ts"),
      "utf8",
    ).matchAll(/^\s*"([^"]+)":\s*(?:sx|typography)\./gm),
  ].map((match) => match[1]),
);
const isPermittedResidual = (token: string) =>
  looksResidual(token) || semanticHooks.has(token);
const convertible = [...tokens].filter(
  (token) => !isPermittedResidual(token) && !compatibilityStyles.has(token),
);
if (convertible.length > 0) {
  throw new Error(
    `StyleX-expressible classes remain outside StyleX:\n${convertible.sort().join("\n")}`,
  );
}
// Mapped utilities ship through StyleX, never duplicate through residual CSS.
for (const token of compatibilityStyles) tokens.delete(token);
const kept: string[] = [];
let matchedTokens = new Set<string>();

/** Escape a class token the way Tailwind escapes selectors. */
function esc(t: string): string {
  return t.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

// StyleX's property-specificity mode can emit up to nine zero-match ID
// pseudos so longhands and shorthands resolve independently. Residual selectors
// represent states StyleX cannot express and must still override the base
// StyleX declaration, just as their Tailwind rules did by source order. Ten
// zero-match pseudos beat StyleX without !important, preserving inline-style
// precedence and the declarations themselves.
const RESIDUAL_SPECIFICITY = ":not(#\\#)".repeat(10);
function boostResidualSelector(selText: string): string {
  let boosted = selText;
  for (const token of tokens) {
    const target = `.${esc(token)}`;
    let from = 0;
    while (true) {
      const index = boosted.indexOf(target, from);
      if (index < 0) break;
      const after = boosted[index + target.length];
      if (after === undefined || ":#[.>~+* ,(:){]".includes(after)) {
        boosted =
          boosted.slice(0, index + target.length) +
          RESIDUAL_SPECIFICITY +
          boosted.slice(index + target.length);
        from = index + target.length + RESIDUAL_SPECIFICITY.length;
      } else from = index + target.length;
    }
  }
  return boosted;
}

function consider(selText: string): boolean {
  let matched = false;
  for (const t of tokens) {
    if (matchedTokens.has(t)) continue;
    const e = esc(t);
    const idx = selText.indexOf("." + e);
    if (idx >= 0) {
      const after = selText[idx + 1 + e.length];
      // must end at a selector boundary, not mid-name. A grouped rule can
      // satisfy several tokens, so mark all of them before returning.
      if (after === undefined || ":#[.>~+* ,(:){]".includes(after)) {
        matchedTokens.add(t);
        matched = true;
      }
    }
  }
  return matched;
}

function wrappedRule(rule: string, wrappers: readonly string[]): string {
  let out = rule;
  for (let i = wrappers.length - 1; i >= 0; i--) out = `${wrappers[i]}{${out}}`;
  return out;
}

function walk(chunk: string, wrappers: readonly string[] = []) {
  let i = 0;
  while (i < chunk.length) {
    const open = chunk.indexOf("{", i);
    if (open < 0) break;
    const selRaw = chunk.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < chunk.length && depth > 0) {
      if (chunk[j] === "{") depth++;
      else if (chunk[j] === "}") depth--;
      j++;
    }
    const body = chunk.slice(open, j); // includes braces
    if (selRaw.startsWith("@")) {
      if (selRaw.startsWith("@media") || selRaw.startsWith("@supports")) {
        walk(chunk.slice(open + 1, j - 1), [...wrappers, selRaw]);
      } else if (
        selRaw.startsWith("@property") ||
        selRaw.startsWith("@keyframes") ||
        selRaw.startsWith("@container")
      ) {
        kept.push(wrappedRule(selRaw + body, wrappers));
      }
      i = j;
      continue;
    }
    if (consider(selRaw)) {
      const adjustedBody = selRaw.includes("\\[\\&_\\*\\]\\:\\!leading-normal")
        ? body
            .replaceAll(
              "var(--leading-normal) !important",
              "var(--settings-leading, var(--leading-normal)) !important",
            )
            .replaceAll(
              "var(--leading-normal)!important",
              "var(--settings-leading,var(--leading-normal))!important",
            )
        : body;
      kept.push(
        wrappedRule(boostResidualSelector(selRaw) + adjustedBody, wrappers),
      );
    }
    i = j;
  }
}
walk(src);

// Unmatched tokens: mostly component classes styled by base.css/legacy.css
// (markdown, mono-input…) or already-converted tokens — report, don't fail.
const unmatched = [...tokens].filter((t) => !matchedTokens.has(t));
const unmatchedRules = unmatched.filter(
  (token) =>
    token !== "[" &&
    token !== "peer" &&
    token !== "aria-selected" &&
    !token.startsWith("group") &&
    !semanticHooks.has(token),
);
if (unmatchedRules.length > 0) {
  throw new Error(
    `Residual utility classes have no emitted rule:\n${unmatchedRules.sort().join("\n")}`,
  );
}

const header = `/* ─────────────────────────────────────────────────────────────
   residual.css — declarations from the last compiled Tailwind rules
   for selectors StyleX cannot express. Selectors receive a zero-match
   specificity bridge so their state overrides beat StyleX's generated
   property specificity without !important. Generated by
   scripts/stylex-residual.ts
   (${kept.length} rules for ${matchedTokens.size} class tokens); hand-editable after
   this point. Classes referenced here stay in markup alongside
   stylex.props spreads — see styles/STYLEX-MIGRATION.md.
   ───────────────────────────────────────────────────────────── */

`;
const outCss = (header + kept.join("\n") + "\n")
  // Bun's CSS bundler does not yet parse Media Queries level 4 range syntax.
  // These spellings are exactly equivalent and keep the shipped sheet valid.
  .replaceAll("@media (width < 920px)", "@media not all and (min-width: 920px)")
  .replaceAll("@media (width >= 48rem)", "@media (min-width: 48rem)");
if (WRITE) writeFileSync(join(FRONTEND, "styles/residual.css"), outCss);
console.log(
  `tokens seen: ${tokens.size}, matched: ${matchedTokens.size}, rules kept: ${kept.length}, bytes: ${outCss.length}`,
);
console.log(
  `unmatched (component classes / already handled): ${unmatched.length}`,
);
if (process.env.SHOW_UNMATCHED) console.log(unmatched.join(" "));
if (process.env.SHOW_TOKENS) console.log([...tokens].sort().join("\n"));
