/** Compose residual/custom className values with StyleX metadata after codemods. */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
const FRONTEND = join(
  import.meta.dir,
  "../packages/core/opensession-server/src/frontend",
);
const write = process.argv.includes("--write");
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n),
      st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") && !p.includes(".test.")) out.push(p);
  }
  return out;
}
function importPath(file: string): string {
  let p = relative(join(file, ".."), join(FRONTEND, "ui/cn.ts")).replace(
    /\.ts$/,
    "",
  );
  if (!p.startsWith(".")) p = "./" + p;
  return p;
}
let files = 0,
  elements = 0;
for (const path of walk(FRONTEND)) {
  const source = readFileSync(path, "utf8");
  const ast = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const edits: { start: number; end: number; text: string }[] = [];
  let needProps = false,
    needOverride = false;
  function visit(node: ts.Node): void {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attrs = [...node.attributes.properties];
      const classAttr = attrs.find(
        (a): a is ts.JsxAttribute =>
          ts.isJsxAttribute(a) && a.name.getText(ast) === "className",
      );
      const spread = attrs.find(
        (a): a is ts.JsxSpreadAttribute =>
          ts.isJsxSpreadAttribute(a) &&
          ts.isCallExpression(a.expression) &&
          a.expression.expression.getText(ast) === "stylex.props",
      );
      if (spread) {
        const custom = /^[A-Z]/.test(node.tagName.getText(ast));
        const args = (spread.expression as ts.CallExpression).arguments
          .map((a) => a.getText(ast))
          .join(", ");
        let classExpr = '""';
        if (classAttr?.initializer) {
          if (ts.isStringLiteral(classAttr.initializer))
            classExpr = JSON.stringify(classAttr.initializer.text);
          else if (
            ts.isJsxExpression(classAttr.initializer) &&
            classAttr.initializer.expression
          )
            classExpr = classAttr.initializer.expression.getText(ast);
        }
        if (custom) {
          const replacement = `className={mergeStylexOverrideClassName(${classExpr}${args ? `, ${args}` : ""})}`;
          if (classAttr) {
            edits.push({
              start: classAttr.getStart(ast),
              end: classAttr.getEnd(),
              text: replacement,
            });
            edits.push({
              start: spread.getStart(ast),
              end: spread.getEnd(),
              text: "",
            });
          } else
            edits.push({
              start: spread.getStart(ast),
              end: spread.getEnd(),
              text: replacement,
            });
          needOverride = true;
        } else if (classAttr) {
          edits.push({
            start: classAttr.getStart(ast),
            end: classAttr.getEnd(),
            text: `{...mergeStylexProps(${classExpr}${args ? `, ${args}` : ""})}`,
          });
          edits.push({
            start: spread.getStart(ast),
            end: spread.getEnd(),
            text: "",
          });
          needProps = true;
        }
        elements++;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!edits.length) continue;
  let out = source;
  for (const e of edits.sort((a, b) => b.start - a.start))
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  const names = [
    needProps && "mergeStylexProps",
    needOverride && "mergeStylexOverrideClassName",
  ]
    .filter(Boolean)
    .join(", ");
  if (names)
    out =
      `import { ${names} } from ${JSON.stringify(importPath(path))};\n` + out;
  if (write) writeFileSync(path, out);
  files++;
}
console.log(`rewrote ${elements} StyleX prop boundaries across ${files} files`);
