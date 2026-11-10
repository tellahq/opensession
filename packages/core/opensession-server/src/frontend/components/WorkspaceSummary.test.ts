import { expect, test } from "bun:test";

const summarySource = await Bun.file(
  new URL("./WorkspaceSummary.tsx", import.meta.url),
).text();
const infoSource = await Bun.file(
  new URL("./WorkspaceInfo.tsx", import.meta.url),
).text();
const collaboratorsSource = await Bun.file(
  new URL("./WorkspaceCollaborators.tsx", import.meta.url),
).text();
const apiSource = await Bun.file(
  new URL("../lib/api/workspaces.ts", import.meta.url),
).text();

test("workspace surfaces keep committed and uncommitted work separate", () => {
  expect(apiSource).toContain("commits?: WorkspaceCommit[]");
  expect(summarySource).toContain("function workRow()");
  expect(summarySource).toContain(">Uncommitted</div>");
  expect(summarySource).toContain("commits.map(committedRow)");
  expect(infoSource).toContain("commits.map((commit)");
  expect(infoSource).toContain(
    "<CommitRow key={commit.sha} commit={commit} />",
  );
});

test("the work row expands to files with hover diff previews", () => {
  expect(summarySource).toContain(
    "onClick={() => setWorkOpen((open) => !open)}",
  );
  expect(summarySource).toContain("changeFiles.map(fileChangeRow)");
  expect(summarySource).toContain("openOnHover={Boolean(file.patch)}");
  expect(summarySource).toContain("<PatchFileDiff");
  expect(summarySource).toContain("useSessionPrDiffResource(");
  expect(summarySource).not.toContain("files committed");
});

test("commits and changed files share one row with a files or commits switch", () => {
  expect(summarySource).toContain("const prCommits = pr?.commits ?? []");
  expect(summarySource).toContain(
    "const commitCount = prCommits.length || commits.length",
  );
  expect(summarySource).toContain("aria-expanded={workOpen}");
  expect(summarySource).toContain('aria-label="Show files or commits"');
  expect(summarySource).toContain('["commits", "Commits", commitCount]');
  expect(summarySource).not.toContain("<Segmented");
  expect(summarySource).toContain(
    "<span className={WS_SUMMARY_LABEL}>Changes</span>",
  );
  expect(summarySource).toContain("prCommits.map(prCommittedRow)");
  expect(summarySource).toContain("commits.map(committedRow)");
  expect(summarySource).not.toContain("<span>Committed</span>");
  expect(summarySource).not.toContain(">Changes</div>");
});

test("a commit opens its details and code changes in a nested overlay", () => {
  expect(summarySource).toContain("function setCommitDetailsOpen(");
  expect(summarySource).toContain(
    "fetchCommit(sha, repo, { includeChanges: true })",
  );
  expect(summarySource).toContain("function commitDetailsPopup(");
  expect(summarySource).toContain(
    '((workOpen && workTab === "files") || Boolean(openCommit))',
  );
  expect(summarySource).toContain("prCommits.length === 1");
  expect(summarySource).toContain("{rawPatch?.trim() && (");
  expect(summarySource).toContain("<PatchDiffs");
  expect(summarySource).toContain("Some large changes aren’t shown.");
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
  expect(summarySource).toContain("const pickerReviewer =");
  expect(summarySource).toContain("{passiveReviewers.map((reviewer) => (");
});

test("adding a reviewer is a + on the Review heading", () => {
  expect(summarySource).not.toContain('"No reviewers"');
  expect(summarySource).not.toContain(">Ask for review</span>");
  expect(summarySource).toContain(
    '<WorkspaceSummaryAdd label="Ask for review" disabled={reviewBusy}>',
  );
  expect(collaboratorsSource).not.toContain("No collaborators");
  // An empty section is one row with its own glyph, never a bare heading.
  expect(summarySource).toContain('action="Ask for review"');
  expect(summarySource).toContain('reviewEmpty && "hidden"');
});

test("collaborators are added from the summary card and the ⋯ menu, not the presence pile", () => {
  expect(summarySource).toContain("<WorkspaceSummaryCollaborators");
  expect(collaboratorsSource).toContain(
    '<WorkspaceSummaryAdd label="Add collaborator">',
  );
  // An empty section is one add row, so the first collaborator needs no pile.
  expect(collaboratorsSource).toContain('action="Add collaborator"');
  expect(collaboratorsSource).not.toContain("export function HeaderPeople(");
  expect(collaboratorsSource).toContain(
    "export function CollaboratorsSubmenu(",
  );
});

test("popup review heading keeps a small gap after a lone PR band", () => {
  expect(summarySource).toContain('"[&>.ws-summary-band:last-child]:mb-0"');
  expect(summarySource).toContain(
    '"[.ws-summary-pr-group:has(>.ws-summary-band:last-child)+.ws-summary-review-group_&]:mt-1"',
  );
});

test("a stale automated review offers an inline re-review action", () => {
  expect(summarySource).toContain(
    'const canRerunOsReview = pr?.state === "OPEN" && Boolean(osReview?.stale)',
  );
  expect(summarySource).toContain("async function rerunOsReview()");
  expect(summarySource).toContain('session.id,\n        "review",');
  expect(summarySource).toContain("{ ...pr, reviewActive: true }");
  expect(summarySource).toContain("New commits");
  expect(summarySource).toContain("Re-review");
});

test("the review label opens the review with an adjacent arrow", () => {
  expect(summarySource).toContain('aria-label="Open review"');
  expect(summarySource).toContain("group-hover/review:translate-x-0.5");
  expect(summarySource).toContain("[font-size:inherit] [font-weight:inherit]");
  expect(summarySource).not.toContain("w-[calc(100%+16px)]");
  expect(summarySource).not.toContain(
    ">\n              Open\n            </Button>",
  );
});

test("pull request page navigation stays in the review toolbar", () => {
  expect(summarySource).not.toContain('aria-label="Pull request pages"');
  expect(summarySource).not.toContain("onReviewPageChange");
});
