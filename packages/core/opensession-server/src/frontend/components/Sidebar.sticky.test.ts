import { describe, expect, test } from "bun:test";
import { pinnedContentMask } from "../hooks/useSidebarStickyHeadings";
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
    // shaded band; the rows under the heading are masked instead.
    const sticky = sidebarHeader({ kind: "lane", sticky: true });
    expect(sticky).not.toContain("data-[stuck]:before");
    expect(sticky).not.toContain("data-[stuck]:after");
    expect(sticky).not.toContain("is-stuck");
  });

  test("masks content under a pinned heading down to its bottom edge", () => {
    expect(pinnedContentMask(0, false)).toBeNull();
    expect(pinnedContentMask(-4, false)).toBeNull();
    expect(pinnedContentMask(20, false)).toBe(
      "linear-gradient(transparent 20px, #000 32px)",
    );
    // A band's content holds its own pinned lanes, which sit right under the
    // band's heading: a fade there would dim them.
    expect(pinnedContentMask(20, true)).toBe(
      "linear-gradient(transparent 20px, #000 20px)",
    );
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
