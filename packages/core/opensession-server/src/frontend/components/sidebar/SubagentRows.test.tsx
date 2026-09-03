import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";
import type { UnifiedSession } from "../../lib/types";

Object.assign(globalThis, {
  window: Object.assign(globalThis.window ?? {}, {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    matchMedia: () => ({ matches: false }),
    setInterval: () => 0,
  }),
  localStorage: Object.assign(globalThis.localStorage ?? {}, {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  }),
  document: Object.assign(globalThis.document ?? {}, {
    documentElement: { dataset: {}, style: { colorScheme: "" } },
    querySelector: () => null,
    addEventListener: () => {},
    visibilityState: "visible",
  }),
});

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

const clickHandler = z.function({ input: [], output: z.void() });
const clickableElement = z.object({
  props: z.object({ onClick: clickHandler }),
});
const subagentTree = z.object({
  props: z.object({
    children: z.array(
      z.object({
        props: z.object({
          children: z.tuple([
            clickableElement,
            z.object({ props: z.object({ children: clickableElement }) }),
          ]),
        }),
      }),
    ),
  }),
});

function rowButtons(tree: NonNullable<ReturnType<typeof SubagentRows>>) {
  const [row] = subagentTree.parse(tree).props.children;
  if (!row) throw new Error("Expected a rendered subagent row");
  const [open, tooltip] = row.props.children;
  return { open, archive: tooltip.props.children };
}

describe("SubagentRows", () => {
  test("renders semantic indented child rows and selected state", () => {
    const direct = session("direct");
    const nested = session("nested", { parentSessionId: "direct" });
    const html = renderToStaticMarkup(
      <SubagentRows
        items={[
          { session: direct, depth: 1, inline: false, sharesRootPr: false },
          { session: nested, depth: 2, inline: false, sharesRootPr: false },
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
        items={[
          { session: worker, depth: 1, inline: false, sharesRootPr: false },
        ]}
        selectedId={null}
        onSelect={() => {}}
        onArchive={() => {}}
      />,
    );

    expect(html).toContain("Worker pr, subagent, Merged");
    expect(html).toContain('title="PR merged"');
    expect(html).toContain("text-purple");
  });

  test("does not repeat the root workspace's PR icon", () => {
    const worker = session("same-pr", {
      isRunning: false,
      prUrl: "https://github.com/tellahq/example/pull/1",
      prState: "MERGED",
    });
    const html = renderToStaticMarkup(
      <SubagentRows
        items={[
          { session: worker, depth: 1, inline: false, sharesRootPr: true },
        ]}
        selectedId={null}
        onSelect={() => {}}
        onArchive={() => {}}
      />,
    );

    expect(html).toContain("Worker same-pr, subagent, Merged");
    expect(html).not.toContain('title="PR merged"');
    expect(html).not.toContain("text-purple");
  });

  test("opens and archives the exact child session", () => {
    const child = session("child");
    const opened: UnifiedSession[] = [];
    const archived: UnifiedSession[] = [];
    const tree = SubagentRows({
      items: [{ session: child, depth: 1, inline: false, sharesRootPr: false }],
      selectedId: null,
      onSelect: (session) => {
        opened.push(session);
      },
      onArchive: (session) => {
        archived.push(session);
      },
    });
    if (!tree) throw new Error("Expected rendered subagent rows");
    const buttons = rowButtons(tree);

    buttons.open.props.onClick();
    buttons.archive.props.onClick();
    expect(opened).toEqual([child]);
    expect(archived).toEqual([child]);
  });
});
