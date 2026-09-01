import { buildChangedTrees, type FlowTree } from "./vendor/calldiff/core";
import {
  buildFunctionIndex,
  type SourceRecord,
} from "./vendor/calldiff/extract";

export interface CodeFlowSourcePair {
  path: string;
  oldPath?: string;
  before: string | null;
  after: string | null;
}

export interface CodeFlowResult {
  repo: string;
  base: string;
  head: string;
  diffVersion: string;
  trees: FlowTree[];
  languages: string[];
  skippedFiles: number;
  truncated?: boolean;
}

export interface CodeFlowAnalysisInput {
  repo: string;
  base: string;
  head: string;
  diffVersion: string;
  pairs: CodeFlowSourcePair[];
  skippedFiles: number;
}

function languageFor(path: string): string | null {
  if (/\.rs$/i.test(path)) return "Rust";
  if (/\.resi?$/i.test(path)) return "ReScript";
  if (/\.[cm]?tsx$/i.test(path)) return "TSX";
  if (/\.[cm]?ts$/i.test(path)) return "TypeScript";
  if (/\.[cm]?jsx$/i.test(path)) return "JSX";
  if (/\.[cm]?js$/i.test(path)) return "JavaScript";
  return null;
}

export function analyzeCodeFlow(input: CodeFlowAnalysisInput): CodeFlowResult {
  const before: SourceRecord[] = [];
  const after: SourceRecord[] = [];
  const languages = new Set<string>();
  for (const pair of input.pairs) {
    const language =
      languageFor(pair.path) ??
      (pair.oldPath ? languageFor(pair.oldPath) : null);
    if (language) languages.add(language);
    // Normalize a rename onto the new path so unchanged functions still match.
    if (pair.before !== null)
      before.push({ path: pair.path, content: pair.before });
    if (pair.after !== null)
      after.push({ path: pair.path, content: pair.after });
  }
  const changed = buildChangedTrees(
    buildFunctionIndex(before),
    buildFunctionIndex(after),
  );
  return {
    repo: input.repo,
    base: input.base,
    head: input.head,
    diffVersion: input.diffVersion,
    trees: changed.trees,
    languages: [...languages].sort(),
    skippedFiles: input.skippedFiles,
    ...(changed.truncated || input.skippedFiles > 0 ? { truncated: true } : {}),
  };
}
