import { describe, expect, test } from "bun:test";
import {
  SECTIONS,
  TOOL_SECTIONS,
  scopeLabel,
  settingsPaletteActions,
} from "./settings-sections";
import { SETTINGS_KEYWORDS } from "./settings-search";

// The palette and the Settings nav used to keep separate lists of where you
// can go, and the palette's had three of the nav's twenty-five entries. These
// assert the two cannot drift apart again: the palette's set is derived from
// the nav table, so every section the nav offers has to come out the other end.

const navSections = SECTIONS.filter((s) => !TOOL_SECTIONS.has(s.key));

describe("settingsPaletteActions", () => {
  test("splits settings into personal, organization and server tabs", () => {
    const scope = (key: string) =>
      SECTIONS.find((section) => section.key === key)?.scope;
    expect(scope("myAccounts")).toBe("personal");
    expect(scope("general")).toBe("organization");
    expect(scope("sandboxes")).toBe("server");
    expect(SECTIONS.find((section) => section.key === "memory")?.label).toBe(
      "Memory",
    );
  });

  test("keeps identity settings inside General", () => {
    expect(SECTIONS.map((section) => String(section.key))).not.toContain(
      "identity",
    );
    expect(SETTINGS_KEYWORDS.general).toContain("identity");
  });

  test("keeps sign-in inside General", () => {
    expect(SECTIONS.map((section) => String(section.key))).not.toContain(
      "authentication",
    );
    expect(SETTINGS_KEYWORDS.general).toContain("sign in");
  });

  test("combines model, provider and usage settings under Models", () => {
    const sections = SECTIONS.map((section) => ({
      key: String(section.key),
      label: section.label,
    }));
    expect(sections).toContainEqual({ key: "providers", label: "Models" });
    expect(sections.map((section) => section.key)).not.toContain("models");
    expect(sections.map((section) => section.key)).not.toContain("usage");
    expect(SETTINGS_KEYWORDS.providers).toEqual(
      expect.arrayContaining(["providers", "usage", "quota"]),
    );
  });

  test("covers every non-tool section", () => {
    const actions = settingsPaletteActions();
    expect(actions.map((a) => a.section).sort()).toEqual(
      navSections.map((s) => s.key).sort(),
    );
  });

  test("leaves the tool sections to their own palette entries", () => {
    const sections = settingsPaletteActions().map((a) => a.section);
    for (const key of TOOL_SECTIONS) expect(sections).not.toContain(key);
  });

  test("ids are unique and namespaced so they cannot collide with other actions", () => {
    const ids = settingsPaletteActions().map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith("settings-")).toBe(true);
  });

  test("carries the section's label, tab and keywords", () => {
    const actions = settingsPaletteActions();
    for (const action of actions) {
      const section = navSections.find((s) => s.key === action.section);
      expect(section).toBeTruthy();
      expect(action.label).toBe(section!.label);
      expect(action.description).toBe(
        `Settings · ${scopeLabel(section!.scope)}`,
      );
      expect(action.keywords).toEqual(SETTINGS_KEYWORDS[action.section] ?? []);
      // House style: a middle dot, never an em dash.
      expect(action.description).not.toContain("—");
    }
  });

  test("every non-tool section has search keywords", () => {
    const missing = navSections
      .filter((s) => !SETTINGS_KEYWORDS[s.key]?.length)
      .map((s) => s.key);
    expect(missing).toEqual([]);
  });
});
