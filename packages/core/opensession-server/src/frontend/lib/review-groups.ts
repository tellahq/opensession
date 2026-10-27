import type { DiffFileGroup } from "./types";

/**
 * Instant grouping by file role, shown while the AI guide is being written
 * (or when it isn't available). Deterministic and path-only, so it is ready on
 * the first frame and never disagrees with itself between renders.
 */
const RULES: ReadonlyArray<{ title: string; test: RegExp }> = [
  {
    title: "Generated",
    test: /(^|\/)(dist|build|generated|__generated__|__snapshots__|vendor)\/|\.(snap|min\.js|min\.css|map|pb\.go)$|(_pb2\.py|\.generated\.\w+)$/,
  },
  {
    title: "Dependencies",
    test: /(^|\/)(package\.json|bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.(toml|lock)|Gemfile(\.lock)?|go\.(mod|sum)|requirements[^/]*\.txt|poetry\.lock|uv\.lock|pyproject\.toml|composer\.(json|lock)|Podfile(\.lock)?|Package\.(swift|resolved)|flake\.lock)$/,
  },
  {
    title: "Tests",
    test: /(^|\/)(tests?|__tests__|spec|e2e|fixtures?)\/|[._-](test|spec)\.\w+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/,
  },
  {
    title: "Docs",
    test: /\.(md|mdx|rst|adoc|txt)$|(^|\/)(docs?|documentation)\/|(^|\/)(LICENSE|CHANGELOG|README)[^/]*$/i,
  },
  {
    title: "Config",
    test: /(^|\/)\.[^/]+$|(^|\/)\.(github|circleci|vscode|husky)\/|\.(ya?ml|toml|ini|cfg|conf|env(\.\w+)?)$|(^|\/)(Dockerfile|Makefile|Procfile)[^/]*$|(^|\/)[^/]*\.config\.\w+$|(^|\/)tsconfig[^/]*\.json$/,
  },
];

/** The rule-based category for one path. */
export function ruleGroupTitle(path: string): string {
  return RULES.find((rule) => rule.test.test(path))?.title ?? "Code";
}

const ORDER = ["Code", "Tests", "Docs", "Config", "Dependencies", "Generated"];

/** Rule-based groups in review order: code first, machine output last. */
export function ruleGroups(paths: readonly string[]): DiffFileGroup[] {
  const byTitle = new Map<string, string[]>();
  for (const path of paths) {
    const title = ruleGroupTitle(path);
    const files = byTitle.get(title);
    if (files) files.push(path);
    else byTitle.set(title, [path]);
  }
  return ORDER.flatMap((title) => {
    const files = byTitle.get(title);
    return files ? [{ title, files }] : [];
  });
}

export interface ReviewGroupProgress {
  title: string;
  files: string[];
  reviewed: number;
  changed: number;
}

/**
 * Groups restricted to `paths`, with files no group claimed collected last,
 * and each group's review progress. Group order is kept; file order follows
 * `paths` so the tree reads in the same order as the diff.
 */
export function groupReviewProgress(
  groups: readonly DiffFileGroup[],
  paths: readonly string[],
  reviewed?: ReadonlySet<string>,
  changed?: ReadonlySet<string>,
  leftoverTitle = "Everything else",
): ReviewGroupProgress[] {
  const position = new Map(paths.map((path, index) => [path, index]));
  const claimed = new Set<string>();
  const result: ReviewGroupProgress[] = [];
  const add = (title: string, files: string[]) => {
    if (!files.length) return;
    files.sort((left, right) => position.get(left)! - position.get(right)!);
    result.push({
      title,
      files,
      reviewed: files.filter((path) => reviewed?.has(path)).length,
      changed: files.filter((path) => changed?.has(path)).length,
    });
  };
  for (const group of groups) {
    const files = group.files.filter((path) => {
      if (!position.has(path) || claimed.has(path)) return false;
      claimed.add(path);
      return true;
    });
    add(group.title, files);
  }
  add(
    leftoverTitle,
    paths.filter((path) => !claimed.has(path)),
  );
  return result;
}

/** The paths a bulk review action should flip to reach the requested state. */
export function bulkReviewChanges(
  paths: readonly string[],
  reviewed: ReadonlySet<string>,
  action: "mark" | "reset" | "invert",
) {
  const mark: string[] = [];
  const unmark: string[] = [];
  for (const path of paths) {
    const isReviewed = reviewed.has(path);
    if (action === "mark" && !isReviewed) mark.push(path);
    else if (action === "reset" && isReviewed) unmark.push(path);
    else if (action === "invert") (isReviewed ? unmark : mark).push(path);
  }
  return { mark, unmark };
}

export interface LineBreakdownRow {
  title: string;
  additions: number;
  deletions: number;
}

/**
 * Lines changed per file role, in review order, skipping empty roles. When
 * the caller knows larger totals than the files add up to (a provider that
 * caps its file list), the remainder is reported as "Other" so the rows
 * still sum to the headline.
 */
export function lineBreakdown(
  files: ReadonlyArray<{ path: string; additions: number; deletions: number }>,
  totals?: { additions: number; deletions: number },
): LineBreakdownRow[] {
  const byTitle = new Map<string, LineBreakdownRow>();
  for (const file of files) {
    const title = ruleGroupTitle(file.path);
    const row = byTitle.get(title) ?? { title, additions: 0, deletions: 0 };
    row.additions += file.additions;
    row.deletions += file.deletions;
    byTitle.set(title, row);
  }
  const rows = ORDER.flatMap((title) => {
    const row = byTitle.get(title);
    return row && row.additions + row.deletions > 0 ? [row] : [];
  });
  if (totals) {
    const additions =
      totals.additions - rows.reduce((sum, row) => sum + row.additions, 0);
    const deletions =
      totals.deletions - rows.reduce((sum, row) => sum + row.deletions, 0);
    if (additions > 0 || deletions > 0)
      rows.push({
        title: "Other",
        additions: Math.max(0, additions),
        deletions: Math.max(0, deletions),
      });
  }
  return rows;
}
