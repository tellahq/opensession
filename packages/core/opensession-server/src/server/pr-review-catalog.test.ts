import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "./session-kernel";

// state.ts resolves its directory at import, so the scratch root has to be in
// place before the modules below load.
const root = mkdtempSync(`${tmpdir()}/pr-review-catalog-test-`);
const previousRoot = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;
const { importApplicationCatalog } = await import("./catalog-documents");
const { publishPrReview, readPrReviews } = await import("./pr-review-catalog");
const { getPrReviewStatus } = await import("./pr-cache");

afterAll(() => {
  if (previousRoot === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
beforeEach(() => {
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
});
afterEach(() => {
  __setSessionKernelStoreForTest(previousStore);
  store.close();
});

const review = {
  verdict: "approve",
  confidence: 4,
  findings: 1,
  blocking: 0,
  sha: "abc123",
  at: "2026-01-01T00:00:00.000Z",
};

function prState(prNumber: number, extra: Record<string, unknown> = {}) {
  return {
    prNumber,
    headRef: `branch-${prNumber}`,
    reviewedShas: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

describe("pr review catalog projection", () => {
  test("boot import projects existing state files once", async () => {
    mkdirSync(`${root}/.opensession-github`, { recursive: true });
    writeFileSync(
      `${root}/.opensession-github/501.json`,
      JSON.stringify(prState(501, { lastReview: review })),
    );
    writeFileSync(
      `${root}/.opensession-github/502.json`,
      JSON.stringify(
        prState(502, {
          activeRun: {
            kind: "review",
            requestedBy: "acme",
            startedAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      ),
    );
    await importApplicationCatalog();
    const projections = await readPrReviews(["501", "502", "503"]);
    expect(projections.get("501")).toEqual({
      reviewRunning: false,
      lastReview: review,
    });
    expect(projections.get("502")).toEqual({ reviewRunning: true });
    expect(projections.has("503")).toBe(false);
  });

  test("review status reads the published projection, not the files", async () => {
    await publishPrReview("601", prState(601, { lastReview: review }) as never);
    expect(await getPrReviewStatus(601, undefined, "abc123")).toEqual({
      reviewActive: false,
      osReview: {
        verdict: "approve",
        confidence: 4,
        findings: 1,
        blocking: 0,
        stale: false,
        at: review.at,
      },
    });
    expect(
      (await getPrReviewStatus(601, undefined, "newer")).osReview?.stale,
    ).toBe(true);
    expect(await getPrReviewStatus(602, undefined, "abc123")).toEqual({
      reviewActive: false,
      osReview: undefined,
    });
  });
});
