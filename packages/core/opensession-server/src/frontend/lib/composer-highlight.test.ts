import { describe, expect, test } from "bun:test";
import {
  composerHighlightHtml,
  SESSION_GLYPH_SLOT,
  SESSION_PILL_MARGIN,
  composerMentionRanges,
  composerSessionRanges,
  needsComposerHighlight,
} from "./composer-highlight";

const TEAM = [
  { name: "Michiel", fullName: "Michiel Westerbeek" },
  { name: "Kent", fullName: "Kent de Bruin" },
];
const ID = "os-01a006d8-eddd-7000-bca2-b010caf2d8e7";
const WORKSPACE_ID = "ws-28712580-a369-4d58-996b-f8c23e523ed1";

describe("composerHighlightHtml", () => {
  test("plain text passes through escaped", () => {
    expect(composerHighlightHtml("hello <b>world</b>")).toBe(
      "hello &lt;b&gt;world&lt;/b&gt;​",
    );
  });

  test("inline code", () => {
    expect(composerHighlightHtml("run `bun test` now")).toBe(
      'run <span class="cmp-code">`bun test`</span> now​',
    );
  });

  test("closed fence keeps backticks and skips inline parsing inside", () => {
    expect(
      composerHighlightHtml("see:\n```ts\nconst `x` = 1;\n```\ndone"),
    ).toBe(
      'see:\n<span class="cmp-fence">```ts\nconst `x` = 1;\n```</span>\ndone​',
    );
  });

  test("open-ended fence (still typing) styles to end of draft", () => {
    expect(composerHighlightHtml("```bash\necho hi")).toBe(
      '<span class="cmp-fence">```bash\necho hi</span>​',
    );
  });

  test("empty inline backticks are not code", () => {
    expect(composerHighlightHtml("a `` b")).toBe("a `` b​");
  });

  test("inline code never spans lines", () => {
    expect(composerHighlightHtml("a `x\ny` b")).toBe("a `x\ny` b​");
  });

  test("escapes html inside code", () => {
    expect(composerHighlightHtml("`<img>`")).toBe(
      '<span class="cmp-code">`&lt;img&gt;`</span>​',
    );
  });
});

describe("composerMentionRanges", () => {
  test("a finished mention of a teammate", () => {
    expect(composerMentionRanges("ask @Kent about it", TEAM)).toEqual([
      { start: 4, end: 9, name: "Kent" },
    ]);
  });

  test("a name still being typed is not a mention yet", () => {
    // "@Kent" is a whole roster name, but the draft may still become
    // "@Kentucky" — nothing chips until something terminates it.
    expect(composerMentionRanges("ask @Kent", TEAM)).toEqual([]);
    expect(composerMentionRanges("ask @Kentucky ", TEAM)).toEqual([]);
  });

  test("trailing punctuation stays in the sentence", () => {
    expect(composerMentionRanges("thanks @Kent!", TEAM)).toEqual([
      { start: 7, end: 12, name: "Kent" },
    ]);
  });

  test("only roster names count", () => {
    expect(composerMentionRanges("mail @nobody now", TEAM)).toEqual([]);
    expect(composerMentionRanges("see me@kent.com now", TEAM)).toEqual([]);
  });

  test("the roster spelling wins over what was typed", () => {
    expect(composerMentionRanges("@michiel ", TEAM)).toEqual([
      { start: 0, end: 8, name: "Michiel" },
    ]);
  });
});

describe("mentions in the mirror", () => {
  test("a finished mention becomes a pill", () => {
    expect(composerHighlightHtml("ask @Kent now", TEAM)).toBe(
      'ask <span class="cmp-mention">@Kent</span> now​',
    );
  });

  test("a mention inside code stays plain", () => {
    expect(composerHighlightHtml("`@Kent ` and ```\n@Kent \n```", TEAM)).toBe(
      '<span class="cmp-code">`@Kent `</span> and <span class="cmp-fence">```\n@Kent \n```</span>​',
    );
  });

  test("a teammate with a GitHub login gets a face over the @", () => {
    const html = composerHighlightHtml("ask @Kent now", [
      { name: "Kent", fullName: "Kent de Bruin", github: "kentdebruin" },
    ]);
    expect(html).toBe(
      'ask <span class="cmp-mention cmp-faced" style="--cmp-face:url(&quot;https://github.com/kentdebruin.png?size=48&quot;)"><span class="cmp-at">@</span>Kent</span> now​',
    );
  });

  test("without a roster nothing chips", () => {
    expect(composerHighlightHtml("ask @Kent now")).toBe("ask @Kent now​");
  });
});

describe("session ids in the mirror", () => {
  test("a bare id becomes a pill, with the prefix lending the glyph its slot", () => {
    expect(composerHighlightHtml(`look at ${ID} first`)).toBe(
      'look at <span class="cmp-session"><span class="cmp-sid">os-</span>' +
        "01a006d8-eddd-7000-bca2-b010caf2d8e7</span> first​",
    );
  });

  test("a known session shows its name behind the chat glyph", () => {
    const title = "Clean pasted open session links";
    const label = SESSION_GLYPH_SLOT + title;
    expect(
      composerHighlightHtml(
        `look at ${label} first`,
        [],
        [{ start: 8, end: 8 + label.length, id: ID, label }],
      ),
    ).toBe(
      'look at <span class="cmp-session cmp-session-named">' +
        `<span class="cmp-sglyph">${SESSION_GLYPH_SLOT}</span>` +
        "Clean pasted open session links</span> first​",
    );
  });

  test("an archived session uses the archived glyph class", () => {
    const label = SESSION_GLYPH_SLOT + "Clean pasted session links";
    expect(
      composerHighlightHtml(
        label,
        [],
        [{ start: 0, end: label.length, id: ID, label, archived: true }],
      ),
    ).toContain('class="cmp-session cmp-session-named cmp-archived"');
  });

  test("keeps projected margin outside the painted session pill", () => {
    const label = SESSION_GLYPH_SLOT + "Clean pasted session links";
    const shown = SESSION_PILL_MARGIN + label + SESSION_PILL_MARGIN;
    expect(
      composerHighlightHtml(
        `before ${shown} after`,
        [],
        [
          {
            start: 7,
            end: 7 + shown.length,
            id: ID,
            label,
          },
        ],
      ),
    ).toBe(
      `before ${SESSION_PILL_MARGIN}<span class="cmp-session cmp-session-named">` +
        `<span class="cmp-sglyph">${SESSION_GLYPH_SLOT}</span>` +
        `Clean pasted session links</span>${SESSION_PILL_MARGIN} after​`,
    );
  });

  test("markdown in a session title stays inside the session pill", () => {
    const title = "Fix `inline` and ``` fences";
    expect(
      composerHighlightHtml(
        title,
        [],
        [{ start: 0, end: title.length, id: ID, label: title }],
      ),
    ).toBe(
      '<span class="cmp-session cmp-session-named">Fix `inline` and ``` fences</span>​',
    );
  });

  test("title backticks do not consume a following code fence", () => {
    const title = "Fix ``` fences";
    const text = `${title}\n\`\`\`\ncode\n\`\`\`\nplain`;
    expect(
      composerHighlightHtml(
        text,
        [],
        [{ start: 0, end: title.length, id: ID, label: title }],
      ),
    ).toBe(
      '<span class="cmp-session cmp-session-named">Fix ``` fences</span>\n' +
        '<span class="cmp-fence">```\ncode\n```</span>\nplain​',
    );
  });

  test("a workspace mention becomes an atomic named pill", () => {
    const canonical = `Review @workspace:${WORKSPACE_ID} now`;
    expect(composerSessionRanges(canonical)).toEqual([
      {
        start: 7,
        end: 7 + `@workspace:${WORKSPACE_ID}`.length,
        id: WORKSPACE_ID,
        kind: "workspace",
      },
    ]);
    expect(
      composerHighlightHtml(
        "Release planning",
        [],
        [
          {
            start: 0,
            end: "Release planning".length,
            id: WORKSPACE_ID,
            kind: "workspace",
            label: "Release planning",
          },
        ],
      ),
    ).toBe(
      '<span class="cmp-session cmp-session-named cmp-workspace">Release planning</span>​',
    );
  });

  test("the longer legacy prefix lends the same slot", () => {
    expect(composerSessionRanges(`bks-${ID.slice(3)}`)).toEqual([
      { start: 0, end: 40, id: `bks-${ID.slice(3)}` },
    ]);
    expect(composerHighlightHtml(`bks-${ID.slice(3)}`)).toContain(
      '<span class="cmp-sid">bks-</span>',
    );
  });

  // The renderer chips a pasted URL whole, so a pill over its last forty
  // characters would promise a chip in a place no chip appears.
  test("an id inside a URL is not a pill of its own", () => {
    expect(composerSessionRanges(`https://os.tella.dev/session/${ID}`)).toEqual(
      [],
    );
    expect(composerSessionRanges(`/workspace/ws-1/session/${ID}`)).toEqual([]);
  });

  test("an id inside code stays plain", () => {
    expect(composerHighlightHtml(`\`${ID}\``)).toBe(
      `<span class="cmp-code">\`${ID}\`</span>​`,
    );
  });

  test("a half-typed or mis-shaped id is not a pill", () => {
    expect(composerSessionRanges("os-01a006d8-eddd")).toEqual([]);
    expect(composerSessionRanges("os-release")).toEqual([]);
  });

  test("a mention and an id in one draft both chip, in order", () => {
    expect(composerHighlightHtml(`@Kent see ${ID}`, TEAM)).toBe(
      '<span class="cmp-mention">@Kent</span> see ' +
        '<span class="cmp-session"><span class="cmp-sid">os-</span>' +
        "01a006d8-eddd-7000-bca2-b010caf2d8e7</span>​",
    );
  });
});

describe("needsComposerHighlight", () => {
  test("a backtick, a finished mention, or a session id", () => {
    expect(needsComposerHighlight("plain")).toBe(false);
    expect(needsComposerHighlight("has `code`")).toBe(true);
    expect(needsComposerHighlight("ask @Kent now", TEAM)).toBe(true);
    expect(needsComposerHighlight("ask @Kent now")).toBe(false);
    expect(needsComposerHighlight(`look at ${ID}`)).toBe(true);
    // A draft full of hyphens is not a draft full of pills.
    expect(needsComposerHighlight("a well-worn re-check")).toBe(false);
  });
});
