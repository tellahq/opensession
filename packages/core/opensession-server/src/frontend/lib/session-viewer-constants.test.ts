import { expect, test } from "bun:test";

// SessionViewer.tsx must source its module-scope singletons and pure
// key-decoders from these focused files instead of redefining them inline —
// and must keep the useMemo/useState calls that give them their per-render
// identity in the component itself, not in the extracted modules.
test("SessionViewer owners import constants and derive helpers instead of redefining them", async () => {
  const [viewer, review, reader, viewState] = await Promise.all([
    Bun.file(
      new URL("../components/SessionViewer.tsx", import.meta.url),
    ).text(),
    Bun.file(
      new URL("../hooks/useSessionReviewController.ts", import.meta.url),
    ).text(),
    Bun.file(
      new URL("../hooks/useTranscriptReaderController.ts", import.meta.url),
    ).text(),
    Bun.file(
      new URL("../hooks/useSessionViewStateController.ts", import.meta.url),
    ).text(),
  ]);
  const owners = [viewer, review, reader, viewState].join("\n");

  expect(owners).toContain('from "../lib/session-viewer-constants"');
  expect(review).toContain('from "../lib/session-viewer-derive"');
  expect(review).toContain('from "../components/session-viewer/shell-timing"');

  // The singleton/decoder definitions themselves no longer live inline.
  expect(owners).not.toContain("const NO_SUBAGENTS:");
  expect(owners).not.toContain("const NO_WORKFLOW_RUNS:");
  expect(owners).not.toContain("const EMPTY_SUGGESTIONS:");
  expect(owners).not.toContain("const NO_REVIEW_REPOS:");
  expect(owners).not.toContain("const EMPTY_TRANSCRIPT_ENTRIES:");
  expect(owners).not.toContain("function reviewReposFromKey(");
  expect(owners).not.toContain("function discoveredPrsFromKey(");
  expect(owners).not.toContain("function toolPathRootsFromKey(");
  expect(owners).not.toContain("class SessionShellTiming");

  // The memoization moves with its state owner, not into the pure modules.
  expect(review).toContain("() => reviewReposFromKey(reviewReposKey)");
  expect(review).toContain("() => discoveredPrsFromKey(discoveredPrsKey)");
  expect(review).toContain("() => toolPathRootsFromKey(toolPathRootsKey)");
  expect(review).toContain(
    "const [shellTiming] = useState(\n    () => new SessionShellTiming(performance.now()),\n  );",
  );
});

test("the extracted constants module has no React hooks and only owns module-scope singletons", async () => {
  const constants = await Bun.file(
    new URL("./session-viewer-constants.ts", import.meta.url),
  ).text();
  expect(constants).not.toContain("useMemo");
  expect(constants).not.toContain("useState");
  expect(constants).not.toContain("useEffect");
  expect(constants).toContain("export const NO_SUBAGENTS");
  expect(constants).toContain("export const EMPTY_TRANSCRIPT_ENTRIES");
});

test("the extracted derive helpers module is pure, with no React import", async () => {
  const derive = await Bun.file(
    new URL("./session-viewer-derive.ts", import.meta.url),
  ).text();
  expect(derive).not.toContain('from "react"');
  expect(derive).not.toContain("useMemo");
  expect(derive).toContain("export function reviewReposFromKey");
  expect(derive).toContain("export function discoveredPrsFromKey");
  expect(derive).toContain("export function toolPathRootsFromKey");
});

test("the extracted shell-timing module keeps the class free of hooks", async () => {
  const shellTiming = await Bun.file(
    new URL("../components/session-viewer/shell-timing.ts", import.meta.url),
  ).text();
  expect(shellTiming).not.toContain("useState");
  expect(shellTiming).toContain("export class SessionShellTiming");
});
