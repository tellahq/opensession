/** Architecture tripwire for the 2026-09-17 gateway stall: an async function
 * is not a safety boundary if it synchronously probes every session's checkout.
 * Runtime scale tests live in agents/github/session-notify.test.ts. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const sourceRoot = resolve(import.meta.dir, "..");
function source(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(resolve(sourceRoot, path), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}
function visit(node: ts.Node, fn: (node: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

describe("GitHub ownership gateway boundary", () => {
  test("matching has only catalog/config dependencies and no sync I/O escape hatch", () => {
    const file = source("agents/github/session-matching.ts");
    const allowed = new Set([
      "../../server/config",
      "../../server/session-list-store",
      "../../server/session-list-protocol",
      "../../server/types",
    ]);
    visit(file, (node) => {
      if (ts.isImportDeclaration(node)) {
        expect(
          allowed.has((node.moduleSpecifier as ts.StringLiteral).text),
        ).toBe(true);
        // A config getter must receive the asynchronously loaded snapshot.
        const bindings = node.importClause?.namedBindings;
        if (
          (node.moduleSpecifier as ts.StringLiteral).text ===
            "../../server/config" &&
          bindings &&
          ts.isNamedImports(bindings)
        ) {
          expect(
            bindings.elements
              .map((e) => (e.propertyName ?? e.name).text)
              .sort(),
          ).toEqual(["configuredRepos", "defaultRepo", "getConfigAsync"]);
        }
      }
      if (!ts.isCallExpression(node)) return;
      expect(node.expression.kind).not.toBe(ts.SyntaxKind.ImportKeyword);
      const name = node.expression.getText(file);
      expect(name).not.toMatch(
        /Sync$|^(require|eval|Function|Bun\.which|Bun\.spawn)$/,
      );
      if (name === "configuredRepos" || name === "defaultRepo")
        expect(node.arguments.length).toBe(1);
    });
    expect(file.text).toContain("await indexedLiveSessionsByRepoBranch(");
  });

  test("all GitHub matching consumers await the catalog and cannot enumerate sessions/checkouts", () => {
    for (const name of [
      "session-notify",
      "handoff",
      "model-inversion",
      "pr-conflict",
    ]) {
      const file = source(`agents/github/${name}.ts`);
      visit(file, (node) => {
        if (ts.isIdentifier(node))
          expect(node.text).not.toMatch(
            /^(listSessions|getAllSessions|getAllSessionsAsync|getCachedSessions|getCachedSessionsAsync|worktreeHeadBranch|isSharedCheckoutDir|readdirSync|readdir)$/,
          );
        if (
          ts.isCallExpression(node) &&
          node.expression.getText(file) === "matchSessions"
        ) {
          expect(ts.isAwaitExpression(node.parent)).toBe(true);
          // repo, branch, and optionally an `{ order }` literal: never a
          // caller-supplied session list or checkout to probe.
          expect([2, 3]).toContain(node.arguments.length);
          const opts = node.arguments[2];
          if (opts) {
            expect(ts.isObjectLiteralExpression(opts)).toBe(true);
            expect(
              (opts as ts.ObjectLiteralExpression).properties.map((p) =>
                p.name?.getText(file),
              ),
            ).toEqual(["order"]);
          }
        }
      });
    }
  });

  test("turn-boundary reconciliation is targeted and asynchronous", () => {
    const file = source("server/session-branch-ownership.ts");
    visit(file, (node) => {
      if (ts.isIdentifier(node))
        expect(node.text).not.toMatch(
          /Sync$|^(readdir|listSessions|getCachedSessions|worktreeHeadBranch|isSharedCheckoutDir)$/,
        );
      if (ts.isImportDeclaration(node))
        expect((node.moduleSpecifier as ts.StringLiteral).text).not.toBe(
          "node:fs",
        );
    });
    const run = source("server/run-session.ts").text;
    expect(run).toContain("await ownedWorktreeHeadBranch(session.worktreeDir)");
    expect(run).not.toContain("worktreeHeadBranch(");
  });

  test("cold-list workspace filing cannot reintroduce checkout probes", () => {
    const file = source("server/session-workspace.ts");
    for (const statement of file.statements) {
      if (
        !ts.isFunctionDeclaration(statement) ||
        !statement.name ||
        !["ensureSessionWorkspaces", "workspaceForBranch"].includes(
          statement.name.text,
        )
      )
        continue;
      visit(statement, (node) => {
        if (!ts.isCallExpression(node)) return;
        expect(node.expression.getText(file)).not.toMatch(
          /^(ownedWorktree|isSharedCheckoutDir|getRepo|canonicalPath)$|Sync$/,
        );
      });
    }
    expect(file.text).toContain("catalogWorktreeOwnership(");
  });

  test("a review resolves author ownership once, not twice per review", () => {
    const file = source("agents/github/review.ts");
    let lookups = 0;
    visit(file, (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(file) === "authorFamilyFor"
      ) {
        lookups++;
        expect(ts.isAwaitExpression(node.parent)).toBe(true);
      }
    });
    expect(lookups).toBe(1);
    expect(file.text).toContain("inverseReviewModel(author, reviewModel)");
  });
});
