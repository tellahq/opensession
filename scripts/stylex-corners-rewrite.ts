/** Restore the shared squircle contract on mechanically converted radii. */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
const root = join(
  import.meta.dir,
  "../packages/core/opensession-server/src/frontend",
);
function walk(d: string, o: string[] = []): string[] {
  for (const n of readdirSync(d)) {
    const p = join(d, n),
      s = statSync(p);
    if (s.isDirectory()) walk(p, o);
    else if (/\.(?:ts|tsx)$/.test(n) && !n.includes(".test.")) o.push(p);
  }
  return o;
}
let count = 0;
for (const path of walk(root)) {
  const source = readFileSync(path, "utf8");
  if (!source.includes("stylex.create")) continue;
  const ast = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const edits: { at: number; text: string }[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === "stylex.create" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    )
      for (const prop of node.arguments[0].properties) {
        if (
          !ts.isPropertyAssignment(prop) ||
          !ts.isObjectLiteralExpression(prop.initializer)
        )
          continue;
        const keys = prop.initializer.properties
          .filter(ts.isPropertyAssignment)
          .map((p) => p.name.getText(ast).replace(/^['"]|['"]$/g, ""));
        if (
          keys.some((key) => /border.*radius/i.test(key)) &&
          !keys.includes("cornerShape")
        ) {
          const name = prop.name.getText(ast);
          edits.push({
            at: prop.initializer.getEnd() - 1,
            text: `\n\t\tcornerShape: ${/roundedFull/i.test(name) ? '"round"' : '"var(--cs)"'},`,
          });
        }
      }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (edits.length) {
    let out = source;
    for (const e of edits.sort((a, b) => b.at - a.at))
      out = out.slice(0, e.at) + e.text + out.slice(e.at);
    writeFileSync(path, out);
    count += edits.length;
  }
}
console.log(`added ${count} corner-shape declarations`);
