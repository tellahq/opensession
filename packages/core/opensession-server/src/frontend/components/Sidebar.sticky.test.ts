import { describe, expect, test } from "bun:test";
import {
  type FadeNode,
  pinnedFadeTargets,
} from "../hooks/useSidebarStickyHeadings";
import { sidebarHeader } from "../lib/sidebar-classes";

const sidebarSource = await Bun.file(
  new URL("./Sidebar.tsx", import.meta.url),
).text();
const source = await Bun.file(
  new URL("../hooks/useSidebarStickyHeadings.ts", import.meta.url),
).text();
const workspaceRenderersSource = await Bun.file(
  new URL("./sidebar/sidebar-workspace-renderers.tsx", import.meta.url),
).text();
const projectBandsSource = await Bun.file(
  new URL("./sidebar/ProjectBands.tsx", import.meta.url),
).text();

describe("sidebar sticky headings", () => {
  test("keeps the stuck marker across React className updates", () => {
    // React replaces an element's managed className on any sidebar rerender.
    // The scroll position may not change afterward, so an imperative class
    // would disappear without another scroll event to restore it.
    expect(source).toContain('el.hasAttribute("data-stuck")');
    expect(source).toContain('el.toggleAttribute("data-stuck", stuck)');
    expect(source).not.toContain('classList.toggle("is-stuck"');
  });

  test("a pinned heading paints no fill over the chrome", () => {
    // Over the desktop shell's translucent material, a fill reads as a
    // shaded band; the rows fade out as they slide under the heading.
    const sticky = sidebarHeader({ kind: "lane", sticky: true });
    expect(sticky).not.toContain("data-[stuck]:before");
    expect(sticky).not.toContain("data-[stuck]:after");
    expect(sticky).not.toContain("is-stuck");
  });

  test("fades the rows after a pinned heading, never a heading", () => {
    // A minimal element: an id, children, and whether it is a heading.
    interface Fake extends FadeNode<Fake> {
      id: string;
      head: boolean;
      children: Fake[];
      nextElementSibling: Fake | null;
    }
    const holdsHead = (n: Fake): boolean =>
      n.children.some((k) => k.head || holdsHead(k));
    const node = (id: string, children: Fake[] = [], head = false): Fake => {
      const fake: Fake = {
        id,
        head,
        children,
        nextElementSibling: null,
        matches: () => head,
        querySelector: () => (holdsHead(fake) ? fake : null),
      };
      return fake;
    };
    const link = (parent: Fake) => {
      parent.children.forEach((kid, i) => {
        kid.nextElementSibling = parent.children[i + 1] ?? null;
        link(kid);
      });
      return parent;
    };
    // A repo band: its heading, then a block holding a lane (a heading over
    // rows), then a tall list block that fades row by row, then a short one.
    const lane = node("lane", [], true);
    const repo = node("repo", [], true);
    link(
      node("band", [
        repo,
        node("lanes", [node("laneBox", [lane, node("r1"), node("r2")])]),
        node("list", [node("a1"), node("a2")]),
        node("short", [node("label")]),
      ]),
    );
    const height = (el: Fake) => (el.id === "list" ? 400 : 36);
    const ids = (head: Fake) =>
      pinnedFadeTargets(head, height).map((el) => el.id);
    expect(ids(repo)).toEqual(["r1", "r2", "a1", "a2", "short"]);
    expect(ids(lane)).toEqual(["r1", "r2"]);
  });

  test("reveals keyboard-selected rows below the sticky caption", () => {
    expect(sidebarSource).toContain(
      '"desktop:scroll-pt-[var(--sidebar-cap-h)]"',
    );
  });

  test("does not treat the loose scratch namespace as a nested repo lane", () => {
    const activeStart = workspaceRenderersSource.indexOf(
      "function renderActiveSection",
    );
    const activeEnd = workspaceRenderersSource.indexOf(
      "function renderWorkspaceGrouping",
      activeStart,
    );
    const activeSection = workspaceRenderersSource.slice(
      activeStart,
      activeEnd,
    );
    expect(activeSection).toContain("sticky: true, nested })");
    expect(activeSection).not.toContain("nested: !!ns");
    expect(workspaceRenderersSource).toContain("const nested = !!laneRepo;");
    expect(projectBandsSource).toContain(
      'projects.scratchRows,\n            "scratch::",',
    );
  });
});
