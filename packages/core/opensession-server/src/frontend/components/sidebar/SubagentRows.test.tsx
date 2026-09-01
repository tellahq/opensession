import { describe, expect, test } from "bun:test";
import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UnifiedSession } from "../../lib/types";

Object.assign(
  ((globalThis as unknown as { window?: Record<string, unknown> }).window ??=
    {}),
  {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    matchMedia: () => ({ matches: false }),
    setInterval: () => 0,
  },
);
Object.assign(
  ((
    globalThis as unknown as { localStorage?: Record<string, unknown> }
  ).localStorage ??= {}),
  {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
);
Object.assign(
  ((
    globalThis as unknown as { document?: Record<string, unknown> }
  ).document ??= {}),
  {
    documentElement: { dataset: {}, style: { colorScheme: "" } },
    querySelector: () => null,
    addEventListener: () => {},
    visibilityState: "visible",
  },
);

const { SubagentRows } = await import("./SubagentRows");

function session(
  id: string,
  overrides: Partial<UnifiedSession> = {},
): UnifiedSession {
  return {
    id,
    claudeSessionId: null,
    source: "opensession",
    branch: null,
    worktreeDir: null,
    startedBy: "Michiel",
    title: `Worker ${id}`,
    lastActivity: "2026-08-18T10:00:00Z",
    createdAt: "2026-08-18T10:00:00Z",
    isRunning: true,
    transcriptPath: null,
    parentSessionId: "parent",
    ...overrides,
  };
}

function rowButtons(tree: ReactElement<{ children: React.ReactNode }>) {
  const row = React.Children.toArray(tree.props.children)[0] as ReactElement<{
    children: React.ReactNode;
  }>;
  const children = React.Children.toArray(row.props.children);
  const open = children[0] as ReactElement<{ onClick: () => void }>;
  const tooltip = children[1] as ReactElement<{ children: React.ReactNode }>;
  const archive = tooltip.props.children as ReactElement<{
    onClick: () => void;
  }>;
  return { open, archive };
}

describe("SubagentRows", () => {
  test("renders semantic indented child rows and selected state", () => {
    const direct = session("direct");
    const nested = session("nested", { parentSessionId: "direct" });
    const html = renderToStaticMarkup(
      <SubagentRows
        items={[
          { session: direct, depth: 1 },
          { session: nested, depth: 2 },
        ]}
        selectedId="nested"
        onSelect={() => {}}
        onArchive={() => {}}
      />,
    );

    expect(html.match(/data-subagent-row/g)).toHaveLength(2);
    expect(html).toContain('data-parent-session-id="parent"');
    expect(html).toContain('data-parent-session-id="direct"');
    expect(html).toContain('aria-current="page"');
    // Direct workers indent one compact step; deeper workers take another.
    expect(html).toContain("--sidebar-icon-left:29px");
    expect(html).toContain("--sidebar-icon-left:39px");
    expect(html).toContain(
      'd="M6.75 5.75V9.25C6.75 13.116 9.884 16.25 13.75 16.25H18.25"',
    );
    expect(html).toContain("Worker nested, subagent, Running");
    expect(html).toContain('aria-label="Archive Worker nested"');
  });

  test("shows PR status after an idle worker merges", () => {
    const worker = session("pr", {
      isRunning: false,
      prUrl: "https://github.com/tellahq/example/pull/1",
      prState: "MERGED",
    });
    const html = renderToStaticMarkup(
      <SubagentRows
        items={[{ session: worker, depth: 1 }]}
        selectedId={null}
        onSelect={() => {}}
        onArchive={() => {}}
      />,
    );

    expect(html).toContain("Worker pr, subagent, Merged");
    expect(html).toContain('title="PR merged"');
    // The merged tone rides a StyleX registered override marker (sx-styles-*).
    expect(html).toMatch(/class="sx-styles-[a-z0-9]+"/);
  });

  test("opens and archives the exact child session", () => {
    const child = session("child");
    let opened: UnifiedSession | null = null;
    let archived: UnifiedSession | null = null;
    const tree = SubagentRows({
      items: [{ session: child, depth: 1 }],
      selectedId: null,
      onSelect: (session) => {
        opened = session;
      },
      onArchive: (session) => {
        archived = session;
      },
    }) as ReactElement<{ children: React.ReactNode }>;
    const buttons = rowButtons(tree);

    buttons.open.props.onClick();
    buttons.archive.props.onClick();
    expect((opened as UnifiedSession | null)?.id).toBe("child");
    expect((archived as UnifiedSession | null)?.id).toBe("child");
  });
});
