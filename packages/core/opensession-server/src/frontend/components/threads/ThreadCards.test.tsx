import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { UnifiedSession } from "../../lib/types";
import { ThreadCardSummary } from "./ThreadCards";

function thread(overrides: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id: "review-thread",
    source: "opensession",
    startedBy: null,
    branch: null,
    worktreeDir: null,
    title: "Review changes",
    lastActivity: "2026-11-17T10:00:00Z",
    createdAt: "2026-11-17T09:00:00Z",
    isRunning: false,
    mode: "ask",
    ...overrides,
  };
}

const render = (overrides: Partial<UnifiedSession> = {}) =>
  renderToStaticMarkup(<ThreadCardSummary thread={thread(overrides)} />);

describe("compact delegated thread rows", () => {
  test("shows the title and one outcome instead of Idle and Answered", () => {
    const html = render();
    expect(html).toContain("Review changes");
    expect(html).toContain("Answered");
    expect(html).not.toContain("Idle");
  });

  test("working appears once and respects reduced motion", () => {
    const html = render({ isRunning: true });
    expect(html.match(/Working/g)).toHaveLength(1);
    expect(html).toContain("motion-safe:animate-pulse");
  });

  test("preserves blockers and failure status", () => {
    const waiting = render({ waitingForInput: true });
    expect(waiting).toContain("Waiting for an answer");
    expect(waiting).toContain("text-blue");
    expect(
      render({
        lastRunError: {
          message: "The check failed",
          at: "2026-11-17T10:00:00Z",
        },
      }),
    ).toContain("Run failed");
  });

  test("keeps pull request readiness without repeating a generic state", () => {
    const html = render({ prState: "OPEN", prNumber: 42 });
    expect(html).toContain("#42 open");
    expect(html).not.toContain("Ready to ship");
  });

  test("keeps a merged outcome without an extra Shipped label", () => {
    const html = render({ prState: "MERGED", prNumber: 42 });
    expect(html).toContain("Merged #42");
    expect(html).not.toContain("Shipped");
  });
});
