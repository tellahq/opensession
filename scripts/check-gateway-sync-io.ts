#!/usr/bin/env bun
/**
 * Guard: no synchronous filesystem or subprocess call on the gateway thread.
 *
 * Why this exists. On 2026-11-03 the gateway event loop stalled for 2-9 s at a
 * time while repository builds kept the host's disk busy. Its JavaScript was
 * never busy for more than ~300 ms; the thread sat in the kernel instead,
 * waiting for the filesystem journal inside a `mkdirSync`, a `renameSync` or an
 * atime update triggered by a `readFileSync`. A sync call is only as fast as
 * the slowest disk operation queued ahead of it, and `spawnSync` waits for the
 * whole child process. The async `node:fs/promises` and `Bun.spawn` APIs run
 * that wait on other threads, so the loop keeps serving requests.
 *
 * How it measures. Starting at the gateway entry point, this follows every
 * relative static and dynamic import (Worker entry points are separate
 * threads and are not followed) and counts each reference to:
 *   - a `*Sync` export of `fs` / `node:fs`,
 *   - `spawnSync`, `execSync` or `execFileSync` from `child_process`,
 *   - `Bun.spawnSync` and `Bun.which` (a synchronous PATH walk).
 * A module reachable from the gateway can also run in a worker or a CLI, but
 * nothing marks that statically, so every reachable module is held to the
 * gateway's rule.
 *
 * The baseline (scripts/gateway-sync-io-baseline.json) records the calls that
 * remain. A file may never go above its count, a new file may not add one,
 * and `--update` writes a count that dropped back into the baseline, so it
 * only ever shrinks (the check reports a drop but does not fail on it). A call that genuinely must stay synchronous,
 * such as a `process.on("exit")` flush, carries a `gateway-sync-ok: <reason>`
 * comment on its line or the line above.
 *
 * Usage:
 *   bun scripts/check-gateway-sync-io.ts            check against the baseline
 *   bun scripts/check-gateway-sync-io.ts --list     every remaining call site
 *   bun scripts/check-gateway-sync-io.ts --update   rewrite the baseline
 * scripts/check-gateway-sync-io.test.ts runs the check, so `bun run check`
 * fails too.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

export const REPO_ROOT = resolve(import.meta.dir, "..");
export const GATEWAY_ENTRY = resolve(
  REPO_ROOT,
  "packages/core/opensession-server/opensession.ts",
);
export const BASELINE_PATH = resolve(
  import.meta.dir,
  "gateway-sync-io-baseline.json",
);
const EXEMPT_MARKER = "gateway-sync-ok:";

const FS_MODULES = new Set(["fs", "node:fs"]);
const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const CHILD_PROCESS_SYNC = new Set(["spawnSync", "execSync", "execFileSync"]);
const BUN_SYNC = new Set(["spawnSync", "which"]);

export interface SyncSite {
  file: string;
  line: number;
  call: string;
}

function forbiddenExport(module: string, name: string): boolean {
  if (FS_MODULES.has(module)) return name.endsWith("Sync");
  if (CHILD_PROCESS_MODULES.has(module)) return CHILD_PROCESS_SYNC.has(name);
  return false;
}

function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    base.replace(/\.js$/, ".ts"),
  ])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}

/** Every module the gateway thread can load, as absolute paths. */
export function gatewayModules(entry = GATEWAY_ENTRY): string[] {
  const ts_ = new Bun.Transpiler({ loader: "ts" });
  const tsx = new Bun.Transpiler({ loader: "tsx" });
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8").replace(/^#!.*\n/, "");
    const transpiler = file.endsWith(".tsx") ? tsx : ts_;
    for (const imported of transpiler.scanImports(text)) {
      const target = resolveImport(file, imported.path);
      if (
        target &&
        /\.(tsx?|m?js)$/.test(target) &&
        !/\.(test|spec)\.tsx?$/.test(target)
      )
        stack.push(target);
    }
  }
  return [...seen].filter((file) => !file.includes("/src/frontend/")).sort();
}

function exempt(source: ts.SourceFile, node: ts.Node): boolean {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  const lines = source.text.split("\n");
  return [lines[line], lines[line - 1]].some((text) =>
    text?.includes(EXEMPT_MARKER),
  );
}

/** Pure: the forbidden references in one module's source. */
export function scanSource(file: string, text: string): SyncSite[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const named = new Map<string, string>();
  const namespaces = new Map<string, string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const module = statement.moduleSpecifier.text;
    if (!FS_MODULES.has(module) && !CHILD_PROCESS_MODULES.has(module)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) namespaces.set(clause.name.text, module);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings))
      namespaces.set(bindings.name.text, module);
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        const imported = (element.propertyName ?? element.name).text;
        if (forbiddenExport(module, imported))
          named.set(element.name.text, imported);
      }
  }

  const sites: SyncSite[] = [];
  const record = (node: ts.Node, call: string) => {
    if (exempt(source, node)) return;
    const { line } = source.getLineAndCharacterOfPosition(
      node.getStart(source),
    );
    sites.push({ file, line: line + 1, call });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression)
    ) {
      const owner = node.expression.text;
      const member = node.name.text;
      const module = namespaces.get(owner);
      if (module && forbiddenExport(module, member))
        record(node, `${owner}.${member}`);
      else if (owner === "Bun" && BUN_SYNC.has(member))
        record(node, `Bun.${member}`);
      visit(node.expression);
      return;
    }
    if (ts.isIdentifier(node) && named.has(node.text)) {
      const parent = node.parent;
      const isDeclarationName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node) ||
        (ts.isPropertyDeclaration(parent) && parent.name === node);
      if (!isDeclarationName) record(node, named.get(node.text)!);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

export function scanGateway(): SyncSite[] {
  return gatewayModules().flatMap((file) =>
    scanSource(relative(REPO_ROOT, file), readFileSync(file, "utf8")),
  );
}

export function countByFile(
  sites: readonly SyncSite[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const site of sites) counts[site.file] = (counts[site.file] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function readBaseline(): Record<string, number> {
  return existsSync(BASELINE_PATH)
    ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<
        string,
        number
      >)
    : {};
}

/** Pure: human-readable problems, empty when the counts match the baseline. */
export function compareWithBaseline(
  counts: Record<string, number>,
  baseline: Record<string, number>,
  sites: readonly SyncSite[] = [],
): string[] {
  const problems: string[] = [];
  for (const [file, count] of Object.entries(counts)) {
    const allowed = baseline[file] ?? 0;
    if (count <= allowed) continue;
    const where = sites
      .filter((site) => site.file === file)
      .map((site) => `    ${file}:${site.line} ${site.call}`)
      .join("\n");
    problems.push(
      `${file}: ${count} sync I/O call(s) on the gateway thread, baseline allows ${allowed}. ` +
        `Use node:fs/promises or Bun.spawn instead.${where ? `\n${where}` : ""}`,
    );
  }
  return problems;
}

/** Pure: files whose count dropped below the baseline. Not a failure, so a
 * commit that removes calls without knowing about this guard cannot break
 * everyone's check; `--update` locks the improvement in. */
export function staleBaselineFiles(
  counts: Record<string, number>,
  baseline: Record<string, number>,
): string[] {
  return Object.entries(baseline)
    .filter(([file, allowed]) => (counts[file] ?? 0) < allowed)
    .map(([file]) => file);
}

if (import.meta.main) {
  const sites = scanGateway();
  const counts = countByFile(sites);
  if (process.argv.includes("--list")) {
    for (const site of sites)
      console.log(`${site.file}:${site.line}\t${site.call}`);
    console.log(
      `${sites.length} sync I/O call sites in ${Object.keys(counts).length} gateway modules`,
    );
    process.exit(0);
  }
  if (process.argv.includes("--update")) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(counts, null, 2)}\n`);
    console.log(
      `baseline: ${sites.length} sync I/O call sites in ${Object.keys(counts).length} modules`,
    );
    process.exit(0);
  }
  const problems = compareWithBaseline(counts, readBaseline(), sites);
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
  const stale = staleBaselineFiles(counts, readBaseline());
  if (stale.length)
    console.log(
      `${stale.length} file(s) now have fewer sync calls than the baseline ` +
        `(${stale.join(", ")}). ` +
        "Run `bun scripts/check-gateway-sync-io.ts --update` to lock in the improvement.",
    );
  console.log(
    `gateway sync I/O: ${sites.length} remaining call sites, none new`,
  );
}
