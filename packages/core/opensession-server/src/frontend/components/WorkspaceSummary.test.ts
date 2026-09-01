import { expect, test } from "bun:test";

const summarySource = await Bun.file(
  new URL("./WorkspaceSummary.tsx", import.meta.url),
).text();
const infoSource = await Bun.file(
  new URL("./WorkspaceInfo.tsx", import.meta.url),
).text();
const apiSource = await Bun.file(
  new URL("../lib/api/workspaces.ts", import.meta.url),
).text();

test("workspace surfaces keep committed and uncommitted work separate", () => {
  expect(apiSource).toContain("commits?: WorkspaceCommit[]");
  expect(summarySource).toContain("(diffIsCommitted || hasCommitDetails)");
  expect(summarySource).toContain(">Committed</div>");
  expect(summarySource).toContain(">Uncommitted</div>");
  expect(summarySource).toContain("commits.map(committedRow)");
  expect(infoSource).toContain("commits.map((commit)");
  expect(infoSource).toContain(
    "<CommitRow key={commit.sha} commit={commit} />",
  );
});

test("the Committed section folds open to every PR or workspace commit", () => {
  expect(summarySource).toContain("const prCommits = pr?.commits ?? []");
  expect(summarySource).toContain(
    "const [commitsOpen, setCommitsOpen] = useState(false)",
  );
  expect(summarySource).toContain(
    "const commitCount = prCommits.length || commits.length",
  );
  expect(summarySource).toContain("aria-expanded={commitsOpen}");
  expect(summarySource).toContain("{commitCount}</span>");
  expect(summarySource).toContain("<IconChevronRight");
  expect(summarySource).toContain('commitsOpen && "rotate-90"');
  expect(summarySource).toContain("hover:bg-transparent hover:text-faint");
  expect(summarySource).not.toContain(
    'title={commitsOpen ? "Hide commits" : "Show all commits"}',
  );
  expect(summarySource).toContain("prCommits.map(prCommittedRow)");
  expect(summarySource).toContain("commits.map(committedRow)");
});

test("a commit opens its details in a nested overlay instead of GitHub", () => {
  expect(summarySource).toContain("function setCommitDetailsOpen(");
  expect(summarySource).toContain("fetchCommit(sha, repo)");
  expect(summarySource).toContain("function commitDetailsPopup(");
  expect(summarySource).toContain("exclusive={false}");
  expect(summarySource).toContain('side={embedded ? "top" : "left"}');
  expect(summarySource).not.toContain("href={commit.url}");
});

test("uncommitted work opens Changes without using the separate commit action", () => {
  expect(summarySource).toContain("function openUncommittedChanges()");
  expect(summarySource).toContain('onOpenPanelTab("changes")');
  expect(summarySource).toContain("onClick={openUncommittedChanges}");
  expect(summarySource).toContain("onClick={askCommit}");
  expect(summarySource).toContain('title="View uncommitted changes"');
});

test("reviewers stay hidden until a pull request is connected", () => {
  expect(summarySource).toContain("if (!pr) return []");
  expect(summarySource).toContain(
    "const hasConnectedPr = sessionHasConnectedPr(session)",
  );
  expect(summarySource).toContain('!hasConnectedPr && "hidden!"');
});

test("an assigned reviewer can be changed or cleared from the summary", () => {
  expect(summarySource).toContain("reviewRequestSessionId?: string");
  expect(summarySource).toContain("Clear review request");
  expect(summarySource).toContain(
    "const owner = (previous && reviewRequestSessionId) || session.id",
  );
  expect(summarySource).toContain("onReviewChange?.(owner, next)");
  expect(summarySource).toContain("onReviewChange?.(owner, previous)");
});

test("submitted review facts stay separate from the reviewer picker", () => {
  expect(summarySource).toContain('requested: reviewer.state === "PENDING"');
  expect(summarySource).toContain("const pickerReviewer =");
  expect(summarySource).toContain("{passiveReviewers.map((reviewer) => (");
  expect(summarySource).toContain("{!pickerReviewer && (");
  expect(summarySource).toMatch(
    /passiveReviewers\.length > 0\s*\?\s*"Ask for review"/,
  );
});

test("popup review heading keeps a small gap after a lone PR band", () => {
  expect(summarySource).toContain('"[&>.ws-summary-band:last-child]:mb-0"');
  expect(summarySource).toContain(
    '"[.ws-summary-pr-group:has(>.ws-summary-band:last-child)+.ws-summary-review-group_&]:mt-1"',
  );
});

test("pull request page navigation stays in the review toolbar", () => {
  expect(summarySource).not.toContain('aria-label="Pull request pages"');
  expect(summarySource).not.toContain("onReviewPageChange");
});
