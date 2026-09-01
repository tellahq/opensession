import { expect, test } from "bun:test";

// SessionViewer.tsx must source its module-scope singletons and pure
// key-decoders from these focused files instead of redefining them inline —
// and must keep the useMemo/useState calls that give them their per-render
// identity in the component itself, not in the extracted modules.
test("SessionViewer imports its constants and derive helpers instead of redefining them", async () => {
  const viewer = await Bun.file(
    new URL("../components/SessionViewer.tsx", import.meta.url),
  ).text();

  expect(viewer).toContain(
    'import {\n  NO_SUBAGENTS,\n  NO_WORKFLOW_RUNS,\n  EMPTY_SUGGESTIONS,\n  NO_REVIEW_REPOS,\n  HIDDEN_REOPEN_MS,\n  RESUME_GROWTH_WINDOW_MS,\n  LEGACY_OPEN_SETTLE_MAX_MS,\n  INDEXED_OPEN_SETTLE_MAX_MS,\n  JUMP_PAGE_ENTRIES,\n  JUMP_MAX_ENTRIES,\n  EMPTY_TRANSCRIPT_ENTRIES,\n} from "../lib/session-viewer-constants";',
  );
  expect(viewer).toContain(
    'import {\n  reviewReposFromKey,\n  discoveredPrsFromKey,\n  toolPathRootsFromKey,\n} from "../lib/session-viewer-derive";',
  );
  expect(viewer).toContain(
    'import { SessionShellTiming } from "./session-viewer/shell-timing";',
  );

  // The singleton/decoder definitions themselves no longer live inline.
  expect(viewer).not.toContain("const NO_SUBAGENTS:");
  expect(viewer).not.toContain("const NO_WORKFLOW_RUNS:");
  expect(viewer).not.toContain("const EMPTY_SUGGESTIONS:");
  expect(viewer).not.toContain("const NO_REVIEW_REPOS:");
  expect(viewer).not.toContain("const EMPTY_TRANSCRIPT_ENTRIES:");
  expect(viewer).not.toContain("function reviewReposFromKey(");
  expect(viewer).not.toContain("function discoveredPrsFromKey(");
  expect(viewer).not.toContain("function toolPathRootsFromKey(");
  expect(viewer).not.toContain("class SessionShellTiming");

  // But the memoization that gives them per-render identity stays put: this
  // extraction moves definitions, not hook behavior.
  expect(viewer).toContain("() => reviewReposFromKey(reviewReposKey)");
  expect(viewer).toContain("() => discoveredPrsFromKey(discoveredPrsKey)");
  expect(viewer).toContain("() => toolPathRootsFromKey(toolPathRootsKey)");
  expect(viewer).toContain(
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
