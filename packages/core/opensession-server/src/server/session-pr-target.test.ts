import { describe, expect, test } from "bun:test";
import {
  projectWorkspacePrRefs,
  sessionPrBranch,
  shareWorkspacePrRefs,
} from "./session-pr-target";
import type { UnifiedSession } from "./types";
import type { Workspace } from "./workspaces";

const session = {
  id: "bks-ghpr-5286-review",
  branch: "add-lottie-primitive-os-review",
  automation: "github-pr-review",
} as UnifiedSession;

const workspace = {
  id: "ws-review",
  name: "#5286 Add Lottie timeline primitive",
  createdBy: "GitHub (automation)",
  createdAt: "2026-07-28T00:00:00.000Z",
  prNumber: 5286,
  branch: "add-lottie-primitive",
} as Workspace;

describe("shareWorkspacePrRefs", () => {
  const pr = {
    repo: "opensession",
    branch: "fix-workspace-prs",
    source: "primary" as const,
    number: 123,
    url: "https://github.com/tellahq/opensession/pull/123",
    state: "OPEN" as const,
  };

  test("shares a PR with every tab in its workspace", () => {
    const owner = {
      id: "os-owner",
      workspaceId: "ws-one",
      prs: [pr],
    } as UnifiedSession;
    const sibling = {
      id: "os-sibling",
      workspaceId: "ws-one",
    } as UnifiedSession;

    shareWorkspacePrRefs([owner, sibling]);

    expect(owner.prs).toEqual([pr]);
    expect(sibling.prs).toEqual([{ ...pr, source: "discovered" }]);
  });

  test("projects legacy flat PR fields from indexed rows", () => {
    const owner = {
      id: "os-owner",
      workspaceId: "ws-one",
      repo: pr.repo,
      branch: pr.branch,
      prUrl: pr.url,
      prNumber: pr.number,
      prState: pr.state,
    } as UnifiedSession;
    const sibling = {
      id: "os-sibling",
      workspaceId: "ws-one",
    } as UnifiedSession;

    shareWorkspacePrRefs([owner, sibling]);

    expect(owner.prs).toEqual([pr]);
    expect(sibling.prs).toEqual([{ ...pr, source: "discovered" }]);
  });

  test("shares every PR while preserving each tab's own primary", () => {
    const secondPr = {
      ...pr,
      branch: "fix-workspace-prs-ios",
      number: 124,
      url: "https://github.com/tellahq/opensession/pull/124",
    };
    const first = {
      id: "os-first",
      workspaceId: "ws-many",
      prs: [pr],
    } as UnifiedSession;
    const second = {
      id: "os-second",
      workspaceId: "ws-many",
      prs: [secondPr],
    } as UnifiedSession;

    shareWorkspacePrRefs([first, second]);

    expect(first.prs).toEqual([pr, { ...secondPr, source: "discovered" }]);
    expect(second.prs).toEqual([secondPr, { ...pr, source: "discovered" }]);
  });

  test("projects indexed sibling PRs onto one authoritative detail row", () => {
    const detail = {
      id: "os-detail",
      workspaceId: "ws-one",
      repo: "tella-fusion",
      branch: "parent-branch",
    } as UnifiedSession;
    const indexedDetail = {
      ...detail,
      prs: [
        {
          repo: "opensession",
          branch: "footer-pr",
          source: "discovered" as const,
          number: 122,
        },
      ],
    };
    const sibling = {
      id: "os-sibling",
      workspaceId: "ws-one",
      prs: [pr],
    } as UnifiedSession;

    const projected = projectWorkspacePrRefs(detail, [indexedDetail, sibling]);

    expect(projected.prs).toEqual([
      { ...indexedDetail.prs[0], source: "discovered" },
      { ...pr, source: "discovered" },
    ]);
    expect(detail.prs).toBeUndefined();
  });

  test("does not leak PRs across workspaces", () => {
    const owner = {
      id: "os-owner",
      workspaceId: "ws-one",
      prs: [pr],
    } as UnifiedSession;
    const other = {
      id: "os-other",
      workspaceId: "ws-two",
    } as UnifiedSession;

    shareWorkspacePrRefs([owner, other]);

    expect(other.prs).toBeUndefined();
  });

  test("does not turn a bare attached branch into a PR", () => {
    const owner = {
      id: "os-owner",
      workspaceId: "ws-one",
      prs: [
        {
          repo: "infra",
          branch: "infra-feature",
          source: "attached" as const,
        },
      ],
    } as UnifiedSession;
    const sibling = {
      id: "os-sibling",
      workspaceId: "ws-one",
    } as UnifiedSession;

    shareWorkspacePrRefs([owner, sibling]);

    expect(sibling.prs).toBeUndefined();
  });

  test("fills sparse refs without changing how a tab owns the PR", () => {
    const owner = {
      id: "os-owner",
      workspaceId: "ws-one",
      prs: [pr],
    } as UnifiedSession;
    const sibling = {
      id: "os-sibling",
      workspaceId: "ws-one",
      prs: [
        {
          repo: pr.repo,
          branch: pr.branch,
          source: "linked" as const,
        },
      ],
    } as UnifiedSession;

    shareWorkspacePrRefs([owner, sibling]);

    expect(sibling.prs).toEqual([{ ...pr, source: "linked" }]);
  });
});

describe("sessionPrBranch", () => {
  test("uses the PR workspace branch for a GitHub review checkout", () => {
    expect(sessionPrBranch(session, workspace)).toBe("add-lottie-primitive");
  });

  test("does not rewrite ordinary session branches", () => {
    expect(
      sessionPrBranch(
        { ...session, automation: undefined } as UnifiedSession,
        workspace,
      ),
    ).toBe("add-lottie-primitive-os-review");
  });

  test("requires a structurally PR-backed workspace", () => {
    expect(
      sessionPrBranch(session, { ...workspace, prNumber: undefined }),
    ).toBe("add-lottie-primitive-os-review");
  });

  // An ask-style session shares its workspace's checkout but stores no branch of
  // its own, so without the fallback it showed "Create PR" beside a sibling
  // tab on the same workspace's connected PR.
  test("a branchless session inherits its workspace's branch", () => {
    expect(
      sessionPrBranch(
        { id: "bks-ask", branch: null } as unknown as UnifiedSession,
        workspace,
      ),
    ).toBe("add-lottie-primitive");
  });

  test("inherits from a workspace with no PR of its own yet", () => {
    expect(
      sessionPrBranch({ id: "bks-ask" } as UnifiedSession, {
        ...workspace,
        prNumber: undefined,
      }),
    ).toBe("add-lottie-primitive");
  });

  test("stays branchless when the workspace owns no branch", () => {
    expect(
      sessionPrBranch({ id: "bks-ask" } as UnifiedSession, {
        ...workspace,
        branch: undefined,
      }),
    ).toBeNull();
  });

  test("an explicit null workspace opts out of inheriting", () => {
    expect(
      sessionPrBranch({ id: "bks-ask" } as UnifiedSession, null),
    ).toBeNull();
  });

  // A workspace can hold sessions from several repos; the branch belongs to one.
  test("never inherits a branch from another repo", () => {
    expect(
      sessionPrBranch(
        { id: "bks-ask", repo: "opensession" } as UnifiedSession,
        {
          ...workspace,
          repo: "tella-fusion",
        },
      ),
    ).toBeNull();
  });

  test("inherits when both sides name the same repo", () => {
    expect(
      sessionPrBranch(
        { id: "bks-ask", repo: "tella-fusion" } as UnifiedSession,
        {
          ...workspace,
          repo: "tella-fusion",
        },
      ),
    ).toBe("add-lottie-primitive");
  });
});
