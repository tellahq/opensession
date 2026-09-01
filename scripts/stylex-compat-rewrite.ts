/** Wrap dynamic/shared utility strings with the generated StyleX compatibility map. */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const FRONTEND = join(
  import.meta.dir,
  "../packages/core/opensession-server/src/frontend",
);
const compatPath = join(FRONTEND, "styles/utility-compat.stylex.ts");
const compatSource = readFileSync(compatPath, "utf8");
const mapped = new Set(
  [...compatSource.matchAll(/^\s*"([^"]+)": (?:sx|typography)\./gm)].map(
    (m) => m[1],
  ),
);
const write = process.argv.includes("--write");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else if (
      /\.(?:ts|tsx)$/.test(name) &&
      !/\.test\./.test(name) &&
      path !== compatPath
    )
      out.push(path);
  }
  return out;
}
function importPath(file: string): string {
  let path = relative(join(file, ".."), join(FRONTEND, "ui/cn.ts")).replace(
    /\.ts$/,
    "",
  );
  if (!path.startsWith(".")) path = "./" + path;
  return path;
}
function hasMappedToken(text: string): boolean {
  return text.split(/\s+/).some((token) => mapped.has(token));
}

let files = 0;
let literals = 0;
for (const file of walk(FRONTEND)) {
  const source = readFileSync(file, "utf8");
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const values = new Map<string, ts.Expression>();
  const returns = new Map<string, ts.Expression[]>();
  function index(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    )
      values.set(node.name.text, node.initializer);
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const found: ts.Expression[] = [];
      function find(child: ts.Node): void {
        if (ts.isReturnStatement(child) && child.expression)
          found.push(child.expression);
        else ts.forEachChild(child, find);
      }
      find(node.body);
      returns.set(node.name.text, found);
    }
    ts.forEachChild(node, index);
  }
  index(ast);
  const targets = new Map<
    number,
    ts.StringLiteralLike | ts.TemplateExpression
  >();
  const resolving = new Set<string>();
  function collect(node: ts.Node): void {
    if (ts.isStringLiteralLike(node)) {
      if (hasMappedToken(node.text)) targets.set(node.getStart(ast), node);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const staticText = [
        node.head.text,
        ...node.templateSpans.map((span) => span.literal.text),
      ].join(" ");
      if (hasMappedToken(staticText)) targets.set(node.getStart(ast), node);
      return;
    }
    if (ts.isIdentifier(node)) {
      const value = values.get(node.text);
      if (value && !resolving.has(node.text)) {
        resolving.add(node.text);
        collect(value);
        resolving.delete(node.text);
      }
      return;
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      collect(node.expression);
      return;
    }
    if (ts.isCallExpression(node)) {
      for (const result of returns.get(node.expression.getText(ast)) ?? [])
        collect(result);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      collect(node.whenTrue);
      collect(node.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      collect(node.left);
      collect(node.right);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const item of node.elements) collect(item);
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties)
        if (ts.isPropertyAssignment(prop)) collect(prop.initializer);
      return;
    }
    if (ts.isParenthesizedExpression(node)) collect(node.expression);
  }
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ["cn", "clsx"].includes(node.expression.getText(ast))
    )
      for (const arg of node.arguments) collect(arg);
    if (
      ts.isJsxAttribute(node) &&
      /(?:className|ClassName)$/.test(node.name.getText(ast)) &&
      node.initializer
    ) {
      if (ts.isStringLiteral(node.initializer)) collect(node.initializer);
      else if (
        ts.isJsxExpression(node.initializer) &&
        node.initializer.expression
      )
        collect(node.initializer.expression);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (/-classes\.(?:ts|tsx)$/.test(file)) {
    for (const value of values.values()) collect(value);
  }
  if (targets.size === 0) continue;
  let output = source;
  for (const node of [...targets.values()].sort(
    (a, b) => b.getStart(ast) - a.getStart(ast),
  )) {
    const literal = source.slice(node.getStart(ast), node.getEnd());
    if (
      source.slice(Math.max(0, node.getStart(ast) - 17), node.getStart(ast)) ===
      "utilityClassName("
    )
      continue;
    // A plain string JSX attribute (`foo="…"`) must become an expression
    // (`foo={utilityClassName("…")}`) when its literal is wrapped; only the
    // attribute value itself is wrapped, never adjacent attribute text.
    const isPlainAttr =
      ts.isJsxAttribute(node.parent) && node.parent.initializer === node;
    const wrapped = `utilityClassName(${literal})`;
    const value = isPlainAttr ? `{${wrapped}}` : wrapped;
    output =
      output.slice(0, node.getStart(ast)) + value + output.slice(node.getEnd());
    literals++;
  }
  const path = importPath(file);
  const importLine = `import { utilityClassName } from ${JSON.stringify(path)};\n`;
  if (!source.includes("import { utilityClassName }"))
    output = importLine + output;
  if (write) writeFileSync(file, output);
  files++;
}
console.log(`wrapped ${literals} utility strings across ${files} files`);
