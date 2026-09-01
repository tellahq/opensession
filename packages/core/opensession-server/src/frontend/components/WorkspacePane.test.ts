import { expect, test } from "bun:test";

const source = await Bun.file(
  new URL("./WorkspacePane.tsx", import.meta.url),
).text();
const viewerSource = await Bun.file(
  new URL("./SessionViewer.tsx", import.meta.url),
).text();
const prPanelSource = await Bun.file(
  new URL("./PrPanel.tsx", import.meta.url),
).text();
const prOverviewPageSource = await Bun.file(
  new URL("./pr/PrOverviewPage.tsx", import.meta.url),
).text();
const prFilesPageSource = await Bun.file(
  new URL("./pr/PrFilesPage.tsx", import.meta.url),
).text();
const prDataSource = await Bun.file(
  new URL("../hooks/usePrData.ts", import.meta.url),
).text();
const diffPanelSource = await Bun.file(
  new URL("./DiffPanel.tsx", import.meta.url),
).text();
const codeDisplaySource = await Bun.file(
  new URL("./CodeDisplaySettings.tsx", import.meta.url),
).text();
const commentableDiffSource = await Bun.file(
  new URL("./CommentableDiff.tsx", import.meta.url),
).text();
const pendingCommentsSource = await Bun.file(
  new URL("../hooks/usePendingComments.ts", import.meta.url),
).text();
const reviewToolbarSource = await Bun.file(
  new URL("./pr/ReviewToolbar.tsx", import.meta.url),
).text();
const summarySource = await Bun.file(
  new URL("./WorkspaceSummary.tsx", import.meta.url),
).text();
const baseCssSource = await Bun.file(
  new URL("../styles/base.css", import.meta.url),
).text();

test("workspace draft composers accept and persist attachments", () => {
  const composerStart = source.lastIndexOf("<Composer");
  const composerEnd = source.indexOf("/>", composerStart);
  const composer = source.slice(composerStart, composerEnd);
  const configStart = composer.indexOf("config={{");
  const configEnd = composer.indexOf("actions={{", configStart);
  const config = composer.slice(configStart, configEnd);

  expect(composerStart).toBeGreaterThan(-1);
  expect(configStart).toBeGreaterThan(-1);
  expect(configEnd).toBeGreaterThan(configStart);
  expect(config).toContain("images,");
  expect(config).toContain("files,");
  expect(composer).toContain("actions={{");
  expect(composer).toContain("onImagesChange: setImages,");
  expect(composer).toContain("onFilesChange: setFiles,");
  expect(composer).toContain("onAddAttachments: addWorkspaceAttachments,");
  expect(source).toContain('window.addEventListener("drop", handleDrop, true)');
  expect(source).toContain(
    "saveDraft(draftKey, { text: prompt, images, files })",
  );
});

test("the first workspace session receives its draft attachments", () => {
  const sendStart = source.indexOf('type: "create_session"');
  const sendEnd = source.indexOf("// App navigates", sendStart);
  const payload = source.slice(sendStart, sendEnd);

  expect(sendStart).toBeGreaterThan(-1);
  expect(payload).toContain("...(images.length ? { images } : {})");
  expect(payload).toContain("files: files.map");
  expect(source).toContain("dropStagingAttachments(draftKey)");
});

test("workspace Review keeps the implementation summary beside the PR canvas", () => {
  expect(source).toContain("sessionCarriesPr(s, reviewTarget)");
  expect(source).toContain("s.workspaceId === workspace.id");
  expect(source).toContain("fetchWorkspaceOverview(workspace.id)");
  expect(source).toContain("<WorkspaceSummary");
  expect(source).toContain("session={presentationSession}");
  expect(source).toContain("onOpenChange={setReviewSummaryOpen}");
  expect(source).toContain("compactToolbar={reviewSummaryVisible}");
  expect(source).toMatch(
    /const reviewSummaryVisible =\s*tab === "review" &&\s*!!presentationSession &&/,
  );
  expect(viewerSource).toContain("compactToolbar={summaryVisible}");
  expect(viewerSource).not.toContain("WS_SUMMARY_REVIEW_CLEARANCE");
  expect(source).toContain("walkthrough={presentationSession?.walkthrough}");
});

test("reviews with and without a PR share the review toolbar", () => {
  const reviewBar = prPanelSource.slice(
    prPanelSource.indexOf("const reviewBar"),
    prPanelSource.indexOf("const reviewBar") + 500,
  );

  expect(prPanelSource.match(/<ReviewToolbar/g)?.length).toBe(2);
  expect(prPanelSource).toMatch(
    /<ReviewToolbar\s+compact=\{compactToolbar\}\s*>\s*<div className=\{PR_NO_PR_BAR\}>/,
  );
  expect(reviewToolbarSource).not.toContain("maskStickyFileHeaders");
  expect(reviewToolbarSource).toContain("desktop:pt-2.5");
  expect(reviewToolbarSource).not.toContain("desktop:mt-2.5");
  expect(reviewToolbarSource).not.toContain("sticky top-[52px]");
  expect(reviewToolbarSource).not.toContain("linear-gradient");
  expect(reviewToolbarSource).toContain("desktop:mb-2");
  expect(reviewToolbarSource).toContain("desktop:overflow-hidden");
  expect(reviewToolbarSource).toContain("desktop:rounded-lg");
  expect(reviewToolbarSource).toContain("desktop:smooth-shadow-ring-sm");
  expect(reviewToolbarSource).not.toContain("desktop:border");
  expect(reviewBar).toContain("h-11");
  expect(reviewBar).toContain("bg-surface");
  expect(reviewBar).toContain("desktop:hidden");
  expect(reviewBar).not.toContain("desktop:absolute");
  expect(prPanelSource).toContain('["files", "Files",');
  expect(prPanelSource).toContain('label="Code view"');
  expect(prPanelSource).toContain(
    '<SegmentedOption value="all">Changes</SegmentedOption>',
  );
  expect(prPanelSource).toContain("showViewedProgress: false");
  expect(prPanelSource).not.toContain("<ActiveCodeViewIcon");
});

test("a review without a PR combines and aligns its controls", () => {
  expect(prPanelSource).toContain("ref={setWorktreeToolbarTarget}");
  expect(prPanelSource).toContain("toolbarTarget={worktreeToolbarTarget}");
  expect(
    prPanelSource.match(
      /`selectable relative flex h-full min-h-0 flex-col bg-surface \$\{compactToolbar \? "overflow-x-hidden overflow-y-auto" : "overflow-hidden"\}`/g,
    )?.length,
  ).toBe(2);
  expect(prPanelSource).toContain(
    'compactToolbar ? "overflow-y-visible" : "overflow-y-auto"',
  );
  expect(prPanelSource).toContain(
    '${compactToolbar ? `w-auto pt-0 ${WS_SUMMARY_REVIEW_CANVAS_CLEARANCE}` : "mx-auto w-full pt-2"}',
  );
  expect(diffPanelSource).toContain("toolbarTarget === undefined");
  expect(diffPanelSource).toContain(
    "createPortal(toolbarContents, toolbarTarget)",
  );
  expect(diffPanelSource).toContain(
    'toolbarTarget === undefined ? "px-2.5 pt-2.5" : "px-0 pt-0"',
  );
});

test("sidebar Changes shares Review's code display options", () => {
  expect(prPanelSource).toContain(
    "<CodeDisplaySettings {...codeDisplaySettings} />",
  );
  expect(diffPanelSource).toContain(
    "<CodeDisplaySettings {...codeDisplaySettings} />",
  );
  expect(diffPanelSource).toContain('<SettingRow label="Code view">');
  expect(diffPanelSource).toContain("<CodeOrganizationSettings");
  expect(prPanelSource).toContain("<CodeOrganizationSettings");
  expect(viewerSource.match(/showFileList=\{false\}/g)?.length).toBe(2);
  expect(diffPanelSource).toMatch(
    /\{showFileList &&\s*fileListMode !== "hidden"/,
  );
  expect(diffPanelSource).toContain("showFileListSetting={showFileList}");
  expect(codeDisplaySource).toContain("{showFileListSetting && (");
  expect(prPanelSource).toContain("<DiffSourceSetting");
  expect(diffPanelSource).toContain("<DiffSourceSetting");
  expect(viewerSource).toContain('if (next === "pull-request") openReview?.()');
  expect(diffPanelSource).toContain("showGroupsStatus: false");
  expect(diffPanelSource).toContain('aria-label="Organizing files"');
  expect(diffPanelSource).toContain("diffStyle: codeDisplaySettings.diffStyle");
  expect(diffPanelSource).toContain("wrapLines: codeDisplaySettings.wrapLines");
  expect(diffPanelSource).toMatch(
    /structuralHighlighting:\s*codeDisplaySettings\.structuralHighlighting/,
  );
  expect(diffPanelSource).toContain(
    "showFileStats: codeDisplaySettings.showFileStats",
  );
  expect(diffPanelSource).toContain("codeTheme: codeDisplaySettings.codeTheme");
  expect(diffPanelSource).toContain(
    "stickyFileHeaders: toolbarTarget === undefined",
  );
  expect(diffPanelSource).toContain("--review-file-header-top");
  expect(commentableDiffSource).toContain(
    "top-[calc(var(--review-file-header-top,0px)-1px)]",
  );
  expect(commentableDiffSource).toContain("z-[6] bg-surface");
  expect(commentableDiffSource).toContain("rounded-md bg-surface");
  expect(commentableDiffSource).toContain(
    "mx-2 mt-1.5 max-w-full overflow-clip rounded-lg bg-code-well",
  );
  expect(commentableDiffSource).toContain(
    '"--diffs-bg": "var(--code-well-light)"',
  );
  expect(commentableDiffSource).toContain(
    'backgroundColor: "var(--code-well-light)"',
  );
  expect(commentableDiffSource).toContain(
    '"--diffs-bg": "var(--code-well-dark)"',
  );
  expect(commentableDiffSource).toContain(
    'backgroundColor: "var(--code-well-dark)"',
  );
  expect(commentableDiffSource).toContain("style={DIFF_SURFACE_STYLE[theme]}");
  expect(baseCssSource).toContain("--code-well-light: #f6f8fa");
  expect(baseCssSource).toContain("--code-well-dark: #0d0f13");
  expect(commentableDiffSource).not.toContain("border border-line bg-bg");
  expect(commentableDiffSource).not.toContain("data-[stuck]:overflow-visible");
  expect(commentableDiffSource).not.toContain("-inset-x-px");
  expect(viewerSource).toContain("--diff-panel-top");
  expect(codeDisplaySource).toContain('label="Wrap lines"');
  expect(codeDisplaySource).toContain('value="split"');
  expect(codeDisplaySource).toContain('value="unified"');
  expect(codeDisplaySource).toContain('value="system"');
});

test("CommentableDiff delegates pending-comment state behind one options prop", () => {
  expect(commentableDiffSource).toContain("options: CommentableDiffOptions");
  expect(commentableDiffSource).toContain("usePendingComments({");
  expect(pendingCommentsSource).toContain("const [draft, setDraft]");
  expect(pendingCommentsSource).toContain("const annotationsByFile = new Map");
});

test("wide Review keeps page navigation in the identity bar", () => {
  expect(source).toContain("page={reviewPage}");
  expect(source).not.toContain("onReviewPageChange={setReviewPage}");
  expect(source).toContain("compactToolbar={reviewSummaryVisible}");
  expect(prPanelSource).toContain('label="Pull request pages"');
  expect(prPanelSource).toContain('className="shrink-0 phone:hidden"');
  expect(prPanelSource).toContain('className="flex h-11');
  expect(prPanelSource).toContain("desktop:hidden");
  expect(prPanelSource).toContain("{phoneLayout && fileControls}");
  expect(prPanelSource).toContain(
    "{(compactToolbar || !phoneLayout) && fileControls}",
  );
  expect(prFilesPageSource).not.toContain("desktop:pt-12");
  expect(prOverviewPageSource).not.toContain("desktop:pt-12");
  expect(summarySource).not.toContain('aria-label="Pull request pages"');
  expect(summarySource).not.toContain("onReviewPageChange");
  expect(prPanelSource).toContain(
    'compactToolbar ? "overflow-x-hidden overflow-y-auto"',
  );
  expect(reviewToolbarSource).toContain("sticky top-0");
  expect(reviewToolbarSource).toContain("desktop:mb-0");
  expect(reviewToolbarSource).toContain("desktop:pb-2");
  expect(reviewToolbarSource).not.toContain("-mb-2.5");
  expect(reviewToolbarSource).toContain("WS_SUMMARY_REVIEW_BAR_CLEARANCE");
  expect(prFilesPageSource).toContain("WS_SUMMARY_REVIEW_CANVAS_CLEARANCE");
  expect(prOverviewPageSource).toContain("WS_SUMMARY_REVIEW_CANVAS_CLEARANCE");
  expect(prFilesPageSource).toContain(
    "desktop:[--review-file-tree-gap:0px] desktop:[--review-file-tree-top:60px]",
  );
  expect(prFilesPageSource).toContain(
    'compactToolbar ? "overflow-y-visible" : "overflow-y-auto"',
  );
  expect(prOverviewPageSource).toContain(
    'compactToolbar ? "overflow-y-visible" : "overflow-y-auto"',
  );
  expect(prPanelSource).toContain("stickyFileHeaders: false");
  expect(prPanelSource).not.toContain("--review-file-header-top");
  expect(prFilesPageSource).toContain('${compactToolbar ? "pt-0" : "pt-2"}');
});

test("Review data and pages keep their extracted ownership", () => {
  expect(prPanelSource).toContain("usePrData({");
  expect(prPanelSource).toContain("<PrOverviewPage");
  expect(prPanelSource).toContain("<PrFilesPage");
  expect(prPanelSource).not.toContain("fetchPrPreviewGuide");
  expect(prPanelSource).not.toContain("fetchPrPreviewCodeFlow");
  expect(prDataSource).toContain("activeLoadTargetRef");
  expect(prDataSource).toContain("loadGenerationRef");
  expect(prDataSource).toContain("guideGenerationRef");
  expect(prDataSource).toContain("codeFlowGenerationRef");
  expect(prOverviewPageSource).toContain("<ConversationView");
  expect(prFilesPageSource).toContain("<CommentableDiff");
});

test("Review loading and errors stay centered beside the summary", () => {
  expect(prPanelSource).toContain(
    'const reviewStateClass = `flex-1 ${compactToolbar ? WS_SUMMARY_REVIEW_CANVAS_CLEARANCE : ""}`',
  );
  expect(prPanelSource).toContain(
    "<LoadingState className={`${reviewStateClass} -translate-y-5`}>",
  );
  expect(prPanelSource).toContain('title="Couldn’t load pull request"');
  expect(prPanelSource).toContain(
    'className={reviewStateClass}\n          role="alert"',
  );
});

test("a lone Review hides the tab strip, closes the toolbar gap, and keeps New tab in the header", () => {
  expect(source).toContain("tabStripVisible: boolean");
  expect(source).toContain("!tabStripVisible && onNewSession");
  expect(source).toContain("tabStripVisible={tabStripVisible}");
  expect(source).toContain("flushToolbarTop={!tabStripVisible}");
  expect(viewerSource).toContain("flushToolbarTop={!tabStripVisible}");
  expect(source).toContain('aria-label="New tab"');
});

test("the PR top bar leaves merge to the summary and actions menu", () => {
  const headerStart = prPanelSource.indexOf('<TopBar as="header"');
  const menuStart = prPanelSource.indexOf("<Menu.Root>", headerStart);
  const menuEnd = prPanelSource.indexOf("</Menu.Root>", menuStart);

  expect(headerStart).toBeGreaterThan(-1);
  expect(menuStart).toBeGreaterThan(headerStart);
  expect(prPanelSource.slice(headerStart, menuStart)).not.toContain(
    "Squash and merge",
  );
  expect(prPanelSource.slice(menuStart, menuEnd)).toContain("Squash and merge");
});
