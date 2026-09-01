import { beforeEach, describe, expect, test } from "bun:test";
import {
  resetResolvedSessionTitles,
  setResolvedSessionTitles,
  setSessionTitles,
  setWorkspaceTitles,
} from "./markdown";
import { SESSION_GLYPH_SLOT, SESSION_PILL_MARGIN } from "./composer-highlight";
import {
  applyComposerSessionEdit,
  composerCanonicalSelection,
  composerDisplayOffset,
  projectComposerSessions,
} from "./composer-session-projection";

const ID = "os-01a006d8-eddd-7000-bca2-b010caf2d8e7";
const OTHER_ID = "os-01a00733-0547-7000-9abb-cc2b8fc3502f";
const WORKSPACE_ID = "ws-28712580-a369-4d58-996b-f8c23e523ed1";

describe("composer session projection", () => {
  beforeEach(() => {
    resetResolvedSessionTitles();
    setSessionTitles([[ID, "Clean pasted session links"]]);
    setWorkspaceTitles([[WORKSPACE_ID, "Release planning"]]);
  });

  test("shows the title, behind a slot for the chat glyph, while retaining the canonical id", () => {
    const label = `${SESSION_GLYPH_SLOT}Clean pasted session links`;
    const projected = projectComposerSessions(`Compare ${ID} now`);
    expect(projected.displayText).toBe(
      `Compare ${SESSION_PILL_MARGIN}${label}${SESSION_PILL_MARGIN} now`,
    );
    expect(projected.canonicalText).toBe(`Compare ${ID} now`);
    expect(projected.sessions).toEqual([
      {
        start: 8,
        end:
          8 +
          SESSION_PILL_MARGIN.length +
          label.length +
          SESSION_PILL_MARGIN.length,
        id: ID,
        canonicalStart: 8,
        canonicalEnd: 47,
        label,
      },
    ]);
  });

  test("marks an on-demand archived title for the archive glyph", () => {
    setSessionTitles([]);
    setResolvedSessionTitles([
      { requestedId: ID, title: "Clean pasted session links", archived: true },
    ]);
    const projected = projectComposerSessions(ID);
    expect(projected.sessions[0]).toMatchObject({
      id: ID,
      label: `${SESSION_GLYPH_SLOT}Clean pasted session links`,
      archived: true,
    });
  });

  test("keeps edits outside a token in canonical text", () => {
    const projected = projectComposerSessions(`Compare ${ID} now`);
    expect(
      applyComposerSessionEdit(
        projected,
        `Please compare ${SESSION_PILL_MARGIN}${SESSION_GLYPH_SLOT}Clean pasted session links${SESSION_PILL_MARGIN} now`,
      ).canonicalText,
    ).toBe(`Please compare ${ID} now`);
  });

  test("removes the whole token when its title is edited", () => {
    const projected = projectComposerSessions(`Compare ${ID} now`);
    expect(
      applyComposerSessionEdit(
        projected,
        `Compare ${SESSION_PILL_MARGIN}${SESSION_GLYPH_SLOT}Clean pasted sesion links${SESSION_PILL_MARGIN} now`,
      ).canonicalText,
    ).toBe("Compare  now");
  });

  test("also removes plain text selected beside a token", () => {
    const projected = projectComposerSessions(`Compare ${ID} now`);
    const next = "Compare now";
    expect(applyComposerSessionEdit(projected, next, 8, 8).canonicalText).toBe(
      next,
    );
  });

  test("shows a workspace name while retaining its stable mention token", () => {
    const canonical = `Review @workspace:${WORKSPACE_ID} today`;
    const projected = projectComposerSessions(canonical);
    expect(projected.displayText).toBe(
      `Review ${SESSION_PILL_MARGIN}Release planning${SESSION_PILL_MARGIN} today`,
    );
    expect(projected.sessions).toEqual([
      {
        start: 7,
        end: 7 + SESSION_PILL_MARGIN.length * 2 + "Release planning".length,
        id: WORKSPACE_ID,
        kind: "workspace",
        canonicalStart: 7,
        canonicalEnd: 7 + `@workspace:${WORKSPACE_ID}`.length,
        label: "Release planning",
      },
    ]);
  });

  test("an exact edit range distinguishes sessions with the same title", () => {
    setSessionTitles([
      [ID, "Same title"],
      [OTHER_ID, "Same title"],
    ]);
    const label = `${SESSION_GLYPH_SLOT}Same title`;
    const projected = projectComposerSessions(`${ID} ${OTHER_ID}`);
    expect(projected.displayText).toBe(
      `${label}${SESSION_PILL_MARGIN} ${SESSION_PILL_MARGIN}${label}`,
    );
    expect(
      applyComposerSessionEdit(projected, SESSION_PILL_MARGIN + label, 0, 0, {
        start: 0,
        end: label.length + SESSION_PILL_MARGIN.length + 1,
      }).canonicalText,
    ).toBe(OTHER_ID);
  });

  test("copying part of a title expands to the canonical session id", () => {
    const projected = projectComposerSessions(`Compare ${ID} now`);
    expect(composerCanonicalSelection(projected, 14, 22)).toEqual({
      start: 8,
      end: 47,
    });
  });

  test("maps a canonical caret past the token into display text", () => {
    const projected = projectComposerSessions(`Compare ${ID} now`);
    const label = `${SESSION_GLYPH_SLOT}Clean pasted session links`;
    const projectedLength =
      SESSION_PILL_MARGIN.length + label.length + SESSION_PILL_MARGIN.length;
    expect(composerDisplayOffset(projected, 47)).toBe(8 + projectedLength);
    expect(composerDisplayOffset(projected, 51)).toBe(12 + projectedLength);
  });

  test("leaves session ids inside code untouched", () => {
    expect(projectComposerSessions(`\`${ID}\``).displayText).toBe(`\`${ID}\``);
    expect(projectComposerSessions(`\`\`\`\n${ID}\n\`\`\``).displayText).toBe(
      `\`\`\`\n${ID}\n\`\`\``,
    );
  });

  test("turns a newly pasted id into a named token on the next projection", () => {
    const empty = projectComposerSessions("Compare ");
    const canonical = applyComposerSessionEdit(
      empty,
      `Compare ${ID}`,
    ).canonicalText;
    expect(canonical).toBe(`Compare ${ID}`);
    expect(projectComposerSessions(canonical).displayText).toBe(
      `Compare ${SESSION_PILL_MARGIN}${SESSION_GLYPH_SLOT}Clean pasted session links`,
    );
  });

  test("keeps display-only margins inside the atomic token and off field edges", () => {
    const label = `${SESSION_GLYPH_SLOT}Clean pasted session links`;
    expect(projectComposerSessions(ID).displayText).toBe(label);
    const projected = projectComposerSessions(`Before ${ID} after`);
    expect(
      composerCanonicalSelection(
        projected,
        projected.sessions[0]!.start,
        projected.sessions[0]!.start + SESSION_PILL_MARGIN.length,
      ),
    ).toEqual({ start: 7, end: 46 });
  });
});
