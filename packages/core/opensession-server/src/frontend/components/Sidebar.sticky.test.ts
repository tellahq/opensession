import { describe, expect, test } from "bun:test";
import {
  SIDEBAR_STICKY_LANE,
  SIDEBAR_STUCK_BACKING,
} from "../lib/sidebar-classes";

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
    // would disappear without another scroll event to restore the backing.
    expect(source).toContain('el.hasAttribute("data-stuck")');
    expect(source).toContain('el.toggleAttribute("data-stuck", stuck)');
    expect(source).not.toContain('classList.toggle("is-stuck"');
  });

  test("keys both sticky surfaces from the persistent marker", () => {
    expect(SIDEBAR_STICKY_LANE).toContain("data-[stuck]:after");
    expect(SIDEBAR_STUCK_BACKING).toContain("data-[stuck]:before");
    expect(`${SIDEBAR_STICKY_LANE} ${SIDEBAR_STUCK_BACKING}`).not.toContain(
      "is-stuck",
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
    expect(activeSection).toContain("nested && SIDEBAR_STICKY_LANE_NESTED");
    expect(activeSection).not.toContain("ns && SIDEBAR_STICKY_LANE_NESTED");
    expect(workspaceRenderersSource).toContain("const nested = !!laneRepo;");
    expect(projectBandsSource).toContain(
      'projects.scratchRows,\n            "scratch::",',
    );
  });
});
