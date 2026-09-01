import { expect, test } from "bun:test";

const sidebarSource = await Bun.file(
  new URL("./Sidebar.tsx", import.meta.url),
).text();
const personalBandSource = await Bun.file(
  new URL("./sidebar/PersonalBand.tsx", import.meta.url),
).text();
const projectBandsSource = await Bun.file(
  new URL("./sidebar/ProjectBands.tsx", import.meta.url),
).text();

test("personal and project bands own their render wrappers", () => {
  expect(sidebarSource).toContain("<PersonalBand");
  expect(sidebarSource).toContain("<ProjectBands");
  expect(sidebarSource).not.toContain("<Reorder.Group");
  expect(sidebarSource).not.toContain("data-repo-id={project.repo}");
  expect(sidebarSource).not.toContain("repoLabel(project.repo)");

  expect(personalBandSource).toContain("pinned.open && (");
  expect(personalBandSource).toContain("<Reorder.Group");
  expect(personalBandSource).toContain("dragListener={pinned.canDrag}");

  expect(projectBandsSource).toContain("projects.bands.map((project)");
  expect(projectBandsSource).toContain("data-repo-id={project.repo}");
  expect(projectBandsSource).toContain("selectedReviewRows.map");
});
