/**
 * Source extractors for Open Session's vendored calldiff adaptation.
 * The call-tree model and TS/TSX/Rust behavior are derived from calldiff by
 * Tanishq Kancharla (MIT, see LICENSE). ReScript support and the TypeScript
 * compiler / Lezer implementations are Open Session additions.
 */
import ts from "typescript";
import { parser as rustParser } from "@lezer/rust";
import type { SyntaxNode } from "@lezer/common";
import type {
  CallStep,
  FunctionIndex,
  FunctionInfo,
  SourceLocation,
} from "./core";

export interface SourceRecord {
  path: string;
  content: string;
}

const SUPPORTED = /\.(?:[cm]?[jt]sx?|rs|res|resi)$/i;
export const supportsCodeFlow = (path: string) => SUPPORTED.test(path);

function addFunction(index: FunctionIndex, info: FunctionInfo) {
  const key = `${info.file ?? "<unknown>"}::${info.key}`;
  const existing = index.get(key);
  if (!existing && index.size >= 800) {
    index.truncated = true;
    return;
  }
  if (!existing || (!existing.exported && info.exported))
    index.set(key, { ...info, key });
}

function compact(text: string, max = 80): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function tsLocation(file: ts.SourceFile, node: ts.Node): SourceLocation {
  const start =
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const end = file.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return {
    file: file.fileName,
    line: start,
    ...(end > start ? { endLine: end } : {}),
  };
}

function hasExport(node: ts.Node): boolean {
  return Boolean(
    ts
      .getModifiers(node as ts.HasModifiers)
      ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function tsMemberKey(
  expr: ts.Expression,
  className: string | null,
): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return className;
  if (ts.isPropertyAccessExpression(expr)) {
    const prop = expr.name.text;
    if (expr.expression.kind === ts.SyntaxKind.ThisKeyword && className)
      return `${className}.${prop}`;
    if (ts.isIdentifier(expr.expression))
      return `${expr.expression.text}.${prop}`;
    return className ? `${className}.${prop}` : prop;
  }
  return null;
}

function hookKey(
  node: ts.CallExpression,
  file: ts.SourceFile,
  base: string,
): string {
  if (
    !/^(?:useEffect|useLayoutEffect|useInsertionEffect|useMemo|useCallback|useImperativeHandle)$/.test(
      base,
    )
  )
    return base;
  const deps = node.arguments[1];
  return deps && ts.isArrayLiteralExpression(deps)
    ? `${base}(${compact(deps.getText(file), 64)})`
    : base;
}

function tsSteps(
  file: ts.SourceFile,
  root: ts.Node,
  className: string | null,
  index: FunctionIndex,
): CallStep[] {
  const steps: CallStep[] = [];
  const nestedSteps = (node: ts.Node) => tsSteps(file, node, className, index);
  const visit = (node: ts.Node) => {
    if (node !== root && (ts.isFunctionLike(node) || ts.isClassLike(node)))
      return;
    if (ts.isIfStatement(node)) {
      steps.push({
        type: "branch",
        key: `if:${compact(node.expression.getText(file))}`,
        label: `if (${compact(node.expression.getText(file))})`,
        ...tsLocation(file, node.expression),
        children: nestedSteps(node.thenStatement),
      });
      if (node.elseStatement) {
        steps.push({
          type: "branch",
          key: ts.isIfStatement(node.elseStatement)
            ? `else-if:${compact(node.elseStatement.expression.getText(file))}`
            : "else",
          label: ts.isIfStatement(node.elseStatement)
            ? `else if (${compact(node.elseStatement.expression.getText(file))})`
            : "else",
          ...tsLocation(file, node.elseStatement),
          children: nestedSteps(
            ts.isIfStatement(node.elseStatement)
              ? node.elseStatement.thenStatement
              : node.elseStatement,
          ),
        });
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      const raw = tsMemberKey(node.expression, className);
      if (raw) {
        const children = node.arguments.flatMap((arg) =>
          ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)
            ? tsSteps(file, arg.body, className, index)
            : [],
        );
        steps.push({
          type: "call",
          key: hookKey(node, file, raw),
          ...tsLocation(file, node.expression),
          ...(children.length ? { children } : {}),
        });
      }
      for (const arg of node.arguments) {
        if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg))
          ts.forEachChild(arg, visit);
      }
      return;
    }
    if (ts.isNewExpression(node)) {
      const raw = tsMemberKey(node.expression, null);
      if (raw)
        steps.push({
          type: "call",
          key: `new ${raw}`,
          ...tsLocation(file, node.expression),
        });
      return;
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = opening.tagName.getText(file);
      const isComponent = /^[A-Z]/.test(tag) || tag.includes(".");
      const children = ts.isJsxElement(node)
        ? node.children.flatMap((child) =>
            tsSteps(file, child, className, index),
          )
        : [];
      if (isComponent) {
        steps.push({
          type: "call",
          key: tag,
          ...tsLocation(file, opening.tagName),
          ...(children.length ? { children } : {}),
        });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  if (steps.length > 250) index.truncated = true;
  return steps.slice(0, 250);
}

function tsSignature(
  node: ts.SignatureDeclarationBase,
  file: ts.SourceFile,
): string {
  const generics = node.typeParameters?.length
    ? `<${node.typeParameters.map((p) => compact(p.getText(file), 40)).join(", ")}>`
    : "";
  const params = `(${node.parameters.map((p) => compact(p.getText(file), 64)).join(", ")})`;
  const returns = node.type ? `: ${compact(node.type.getText(file), 64)}` : "";
  return compact(`${generics}${params}${returns}`, 180);
}

function extractTypeScript(record: SourceRecord, index: FunctionIndex) {
  const kind = /\.[cm]?tsx$/i.test(record.path)
    ? ts.ScriptKind.TSX
    : /\.[cm]?jsx$/i.test(record.path)
      ? ts.ScriptKind.JSX
      : /\.[cm]?js$/i.test(record.path)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const file = ts.createSourceFile(
    record.path,
    record.content,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const add = (
    key: string,
    node: ts.FunctionLikeDeclaration,
    exported: boolean,
    className: string | null,
  ) => {
    if (!node.body) return;
    addFunction(index, {
      key,
      label: `${key}${tsSignature(node, file)}`,
      ...tsLocation(file, node),
      steps: tsSteps(file, node.body, className, index),
      exported,
    });
  };
  const visit = (
    node: ts.Node,
    exported = false,
    className: string | null = null,
  ) => {
    const isExported = exported || hasExport(node);
    if (ts.isFunctionDeclaration(node) && node.name) {
      add(node.name.text, node, isExported, null);
      return;
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer))
        ) {
          add(declaration.name.text, declaration.initializer, isExported, null);
        }
      }
      return;
    } else if (ts.isClassDeclaration(node) && node.name) {
      for (const member of node.members) {
        if (
          (ts.isMethodDeclaration(member) ||
            ts.isConstructorDeclaration(member)) &&
          member.body
        ) {
          const name = ts.isConstructorDeclaration(member)
            ? "constructor"
            : member.name.getText(file);
          const key = `${node.name.text}.${name}`;
          add(key, member, isExported || hasExport(member), node.name.text);
          if (name === "constructor") {
            const info = index.get(`${record.path}::${key}`);
            if (info)
              addFunction(index, {
                ...info,
                key: `new ${node.name.text}`,
                label: `new ${node.name.text}${tsSignature(member, file)}`,
              });
          }
        }
      }
      return;
    }
    if (
      ts.isModuleDeclaration(node) ||
      ts.isModuleBlock(node) ||
      ts.isSourceFile(node)
    )
      ts.forEachChild(node, (child) => visit(child, isExported, className));
  };
  visit(file);
}

function rustChildren(node: SyntaxNode): SyntaxNode[] {
  const children: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling)
    children.push(child);
  return children;
}

function rustChild(node: SyntaxNode, name: string): SyntaxNode | null {
  return rustChildren(node).find((child) => child.name === name) ?? null;
}

function rustText(source: string, node: SyntaxNode): string {
  return source.slice(node.from, node.to);
}

function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle]! <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function offsetLocation(
  path: string,
  starts: number[],
  node: SyntaxNode,
): SourceLocation {
  const line = lineAt(starts, node.from);
  const endLine = lineAt(starts, node.to);
  return { file: path, line, ...(endLine > line ? { endLine } : {}) };
}

function rustCallKey(
  node: SyntaxNode,
  source: string,
  owner: string | null,
  types: Map<string, string>,
): string | null {
  if (node.name === "Identifier" || node.name === "BoundIdentifier")
    return rustText(source, node);
  if (node.name === "FieldExpression") {
    const parts = rustChildren(node);
    const object = parts[0];
    const field = parts.find((child) => child.name === "FieldIdentifier");
    if (!object || !field) return null;
    const objectName = rustText(source, object);
    const type = objectName === "self" ? owner : types.get(objectName);
    return type
      ? `${type}.${rustText(source, field)}`
      : `${objectName}.${rustText(source, field)}`;
  }
  if (node.name === "ScopedIdentifier") {
    const parts = rustText(source, node).split("::");
    const name = parts.pop();
    const scope = parts.pop();
    if (!name) return null;
    return name === "new" && scope
      ? `new ${scope}`
      : scope
        ? `${scope}.${name}`
        : name;
  }
  return null;
}

function rustSteps(
  path: string,
  source: string,
  starts: number[],
  root: SyntaxNode,
  owner: string | null,
  types: Map<string, string>,
  index: FunctionIndex,
): CallStep[] {
  const steps: CallStep[] = [];
  const walk = (node: SyntaxNode) => {
    if (
      node !== root &&
      (node.name === "FunctionItem" ||
        node.name === "ClosureExpression" ||
        node.name === "ImplItem")
    )
      return;
    if (node.name === "IfExpression") {
      const children = rustChildren(node);
      const blocks = children.filter((child) => child.name === "Block");
      const condition = children.find(
        (child) =>
          !["if", "else", "Block", "IfExpression"].includes(child.name),
      );
      steps.push({
        type: "branch",
        key: `if:${condition ? compact(rustText(source, condition)) : ""}`,
        label: condition
          ? `if (${compact(rustText(source, condition))})`
          : "if",
        ...offsetLocation(path, starts, condition ?? node),
        children: blocks[0]
          ? rustSteps(path, source, starts, blocks[0], owner, types, index)
          : [],
      });
      if (blocks[1])
        steps.push({
          type: "branch",
          key: "else",
          label: "else",
          ...offsetLocation(path, starts, blocks[1]),
          children: rustSteps(
            path,
            source,
            starts,
            blocks[1],
            owner,
            types,
            index,
          ),
        });
      return;
    }
    if (node.name === "CallExpression") {
      const callee = rustChildren(node)[0];
      const key = callee ? rustCallKey(callee, source, owner, types) : null;
      if (key)
        steps.push({
          type: "call",
          key,
          ...offsetLocation(path, starts, callee!),
        });
    }
    for (const child of rustChildren(node)) walk(child);
  };
  walk(root);
  if (steps.length > 250) index.truncated = true;
  return steps.slice(0, 250);
}

function rustParams(
  source: string,
  params: SyntaxNode | null,
): { label: string; types: Map<string, string> } {
  const types = new Map<string, string>();
  const names: string[] = [];
  for (const param of params ? rustChildren(params) : []) {
    if (param.name === "SelfParameter") {
      names.push("self");
      continue;
    }
    if (param.name !== "Parameter") continue;
    const nameNode =
      rustChild(param, "BoundIdentifier") ?? rustChild(param, "Identifier");
    const typeNode = rustChildren(param).find((child) =>
      /Type$/.test(child.name),
    );
    const name = nameNode ? rustText(source, nameNode) : "_";
    names.push(name);
    if (nameNode && typeNode)
      types.set(
        name,
        compact(rustText(source, typeNode)).replace(/^&(?:mut )?/, ""),
      );
  }
  return { label: `(${names.join(", ")})`, types };
}

function extractRust(record: SourceRecord, index: FunctionIndex) {
  const tree = rustParser.parse(record.content);
  const starts = [0];
  for (let i = 0; i < record.content.length; i++)
    if (record.content.charCodeAt(i) === 10) starts.push(i + 1);
  const add = (
    node: SyntaxNode,
    owner: string | null,
    trait: string | null,
    scope: string,
  ) => {
    const nameNode =
      rustChild(node, "BoundIdentifier") ?? rustChild(node, "Identifier");
    const body = rustChild(node, "Block");
    if (!nameNode || !body) return;
    const name = rustText(record.content, nameNode);
    const params = rustParams(record.content, rustChild(node, "ParamList"));
    const scopedOwner = owner ? `${scope}${owner}` : null;
    const key = scopedOwner ? `${scopedOwner}.${name}` : `${scope}${name}`;
    const info: FunctionInfo = {
      key,
      label: `${name === "new" && scopedOwner ? `new ${scopedOwner}` : key}${params.label}`,
      ...offsetLocation(record.path, starts, node),
      steps: rustSteps(
        record.path,
        record.content,
        starts,
        body,
        scopedOwner,
        params.types,
        index,
      ),
      exported: Boolean(rustChild(node, "Vis")) || !name.startsWith("_"),
    };
    addFunction(index, info);
    if (scopedOwner && name === "new")
      addFunction(index, { ...info, key: `new ${scopedOwner}` });
    if (trait) {
      const scopedTrait = `${scope}${trait}`;
      addFunction(index, {
        ...info,
        key: `${scopedTrait}.${name}`,
        label: `${scopedTrait}.${name}${params.label}`,
      });
    }
  };
  const visitItems = (root: SyntaxNode, scope = "") => {
    for (const node of rustChildren(root)) {
      if (node.name === "FunctionItem") {
        add(node, null, null, scope);
        continue;
      }
      if (node.name === "ImplItem") {
        const typeNodes = rustChildren(node).filter(
          (child) => child.name === "TypeIdentifier",
        );
        const owner = typeNodes.at(-1)
          ? rustText(record.content, typeNodes.at(-1)!)
          : null;
        const trait =
          typeNodes.length > 1 ? rustText(record.content, typeNodes[0]!) : null;
        const list = rustChild(node, "DeclarationList");
        if (owner && list)
          for (const item of rustChildren(list))
            if (item.name === "FunctionItem") add(item, owner, trait, scope);
        continue;
      }
      if (node.name === "ModItem") {
        const nameNode =
          rustChild(node, "BoundIdentifier") ??
          rustChild(node, "Identifier") ??
          rustChild(node, "TypeIdentifier");
        const list = rustChild(node, "DeclarationList");
        if (nameNode && list)
          visitItems(list, `${scope}${rustText(record.content, nameNode)}::`);
      }
    }
  };
  visitItems(tree.topNode);
}

interface ReToken {
  text: string;
  start: number;
  end: number;
  line: number;
}

function reTokens(source: string): ReToken[] {
  const tokens: ReToken[] = [];
  let i = 0;
  let line = 1;
  while (i < source.length) {
    const char = source[i]!;
    if (/\s/.test(char)) {
      if (char === "\n") line++;
      i++;
      continue;
    }
    if (source.startsWith("//", i)) {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (source.startsWith("/*", i)) {
      i += 2;
      while (i < source.length && !source.startsWith("*/", i)) {
        if (source[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      const tokenLine = line;
      const start = i++;
      while (i < source.length) {
        if (source[i] === "\\") i += 2;
        else {
          if (source[i] === "\n") line++;
          if (source[i++] === quote) break;
        }
      }
      tokens.push({ text: "<string>", start, end: i, line: tokenLine });
      continue;
    }
    const ident = source.slice(i).match(/^[A-Za-z_$][\w$']*/)?.[0];
    if (ident) {
      tokens.push({ text: ident, start: i, end: i + ident.length, line });
      i += ident.length;
      continue;
    }
    const op = ["=>", "->", "|>", "==", "!=", "<=", ">="].find((value) =>
      source.startsWith(value, i),
    );
    const text = op ?? char;
    tokens.push({ text, start: i, end: i + text.length, line });
    i += text.length;
  }
  return tokens;
}

function matching(
  tokens: ReToken[],
  start: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i]!.text === open) depth++;
    if (tokens[i]!.text === close && --depth === 0) return i;
  }
  return tokens.length - 1;
}

function reCallSteps(
  path: string,
  tokens: ReToken[],
  start: number,
  end: number,
  index: FunctionIndex,
): CallStep[] {
  const steps: CallStep[] = [];
  const ignored = new Set([
    "if",
    "else",
    "switch",
    "for",
    "while",
    "let",
    "module",
    "open",
    "include",
  ]);
  for (let i = start; i < end; i++) {
    const token = tokens[i]!;
    if (token.text === "<" && /^[A-Z]/.test(tokens[i + 1]?.text ?? "")) {
      let key = tokens[++i]!.text;
      while (
        tokens[i + 1]?.text === "." &&
        /^[A-Za-z_$]/.test(tokens[i + 2]?.text ?? "")
      ) {
        key += `.${tokens[i + 2]!.text}`;
        i += 2;
      }
      steps.push({ type: "call", key, file: path, line: token.line });
      continue;
    }
    if (!/^[A-Za-z_$]/.test(token.text) || ignored.has(token.text)) continue;
    let key = token.text;
    let cursor = i;
    while (
      tokens[cursor + 1]?.text === "." &&
      /^[A-Za-z_$]/.test(tokens[cursor + 2]?.text ?? "")
    ) {
      key += `.${tokens[cursor + 2]!.text}`;
      cursor += 2;
    }
    if (tokens[cursor + 1]?.text === "(") {
      steps.push({ type: "call", key, file: path, line: token.line });
      i = cursor;
    }
  }
  if (steps.length > 250) index.truncated = true;
  return steps.slice(0, 250);
}

function extractReScript(record: SourceRecord, index: FunctionIndex) {
  const tokens = reTokens(record.content);
  const scan = (start: number, end: number, prefix = "", baseDepth = 0) => {
    let depth = baseDepth;
    for (let i = start; i < end; i++) {
      const text = tokens[i]!.text;
      if (text === "{") {
        depth++;
        continue;
      }
      if (text === "}") {
        depth--;
        continue;
      }
      if (depth !== baseDepth) continue;
      if (
        text === "module" &&
        /^[A-Z]/.test(tokens[i + 1]?.text ?? "") &&
        tokens[i + 2]?.text === "=" &&
        tokens[i + 3]?.text === "{"
      ) {
        const close = matching(tokens, i + 3, "{", "}");
        scan(i + 4, close, `${prefix}${tokens[i + 1]!.text}.`, baseDepth);
        i = close;
        continue;
      }
      if (text !== "let") continue;
      let nameAt = i + 1;
      if (tokens[nameAt]?.text === "rec") nameAt++;
      const name = tokens[nameAt]?.text;
      if (!name || !/^[A-Za-z_$]/.test(name)) continue;
      let equal = nameAt + 1;
      while (
        equal < end &&
        tokens[equal]!.text !== "=" &&
        tokens[equal]!.line <= tokens[i]!.line + 3
      )
        equal++;
      if (tokens[equal]?.text !== "=") continue;
      let arrow = equal + 1;
      let parens = 0;
      while (arrow < end) {
        if (tokens[arrow]!.text === "(") parens++;
        if (tokens[arrow]!.text === ")") parens--;
        if (tokens[arrow]!.text === "=>" && parens === 0) break;
        if (tokens[arrow]!.line > tokens[i]!.line + 8) break;
        arrow++;
      }
      if (tokens[arrow]?.text !== "=>") continue;
      const bodyStart = arrow + 1;
      let bodyEnd: number;
      const blockBody = tokens[bodyStart]?.text === "{";
      if (blockBody) {
        bodyEnd = matching(tokens, bodyStart, "{", "}");
      } else {
        bodyEnd = end;
        let nested = 0;
        for (let cursor = bodyStart; cursor < end; cursor++) {
          const value = tokens[cursor]!.text;
          if (["(", "[", "{"].includes(value)) nested++;
          if ([")", "]", "}"].includes(value)) nested--;
          if (
            nested === 0 &&
            (value === ";" ||
              (cursor > bodyStart && ["let", "module"].includes(value)))
          ) {
            bodyEnd = cursor;
            break;
          }
        }
      }
      const key = `${prefix}${name}`;
      const params = compact(
        tokens
          .slice(equal + 1, arrow)
          .map((token) => token.text)
          .join(""),
        64,
      );
      addFunction(index, {
        key,
        label: `${key}${params.startsWith("(") ? params : `(${params})`}`,
        file: record.path,
        line: tokens[i]!.line,
        steps: reCallSteps(record.path, tokens, bodyStart, bodyEnd, index),
        exported: !name.startsWith("_") && !record.path.endsWith(".resi"),
      });
      i = blockBody ? bodyEnd : bodyEnd - 1;
    }
  };
  scan(0, tokens.length);
}

export function buildFunctionIndex(records: SourceRecord[]): FunctionIndex {
  const index: FunctionIndex = new Map();
  for (const record of records) {
    if (!supportsCodeFlow(record.path)) continue;
    if (/\.rs$/i.test(record.path)) extractRust(record, index);
    else if (/\.resi?$/i.test(record.path)) extractReScript(record, index);
    else extractTypeScript(record, index);
  }
  return index;
}
