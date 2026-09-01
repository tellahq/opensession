import { describe, expect, test } from "bun:test";
import { internalUrlTarget, pastedSessionId } from "./session-url";

const ID = "os-01a006d8-eddd-7000-bca2-b010caf2d8e7";
const WS = "ws-3ca573ab-45b9-4047-ae9d-c282c3e85c3a";
const HOST = "http://127.0.0.1:3850";

describe("internalUrlTarget", () => {
  test("reads a session id out of both path shapes", () => {
    expect(internalUrlTarget(`${HOST}/session/${ID}`)?.sessionId).toBe(ID);
    expect(
      internalUrlTarget(`${HOST}/workspace/${WS}/session/${ID}`)?.sessionId,
    ).toBe(ID);
  });

  test("tolerates the legacy path prefixes and a trailing slash", () => {
    expect(
      internalUrlTarget(`${HOST}/opensession/session/${ID}/`)?.sessionId,
    ).toBe(ID);
    expect(
      internalUrlTarget(`${HOST}/backstage/session/${ID}`)?.sessionId,
    ).toBe(ID);
  });

  test("another host is not us", () => {
    expect(internalUrlTarget(`https://github.com/session/${ID}`)).toBeNull();
  });

  test("another port on our host is an external preview", () => {
    expect(
      internalUrlTarget(`http://127.0.0.1:25779/session/${ID}`),
    ).toBeNull();
  });
});

describe("pastedSessionId", () => {
  test("a link on its own becomes the id it carries", () => {
    expect(pastedSessionId(`${HOST}/workspace/${WS}/session/${ID}`)).toBe(ID);
    expect(pastedSessionId(`  ${HOST}/session/${ID}\n`)).toBe(ID);
  });

  // Rewriting a link somebody dropped in is tidying; rewriting inside the
  // paragraph, list or code block they pasted is editing their content.
  test("a link inside a larger paste is left alone", () => {
    expect(pastedSessionId(`see ${HOST}/session/${ID}`)).toBeUndefined();
    expect(
      pastedSessionId(`${HOST}/session/${ID} ${HOST}/session/${ID}`),
    ).toBeUndefined();
  });

  // A bare word of this shape is not a chip in prose, so shortening one would
  // trade a working link for dead text.
  test("a legacy slug id keeps its URL", () => {
    const slug = `${HOST}/session/bks-ghpr-15-review`;
    expect(internalUrlTarget(slug)?.sessionId).toBe("bks-ghpr-15-review");
    expect(pastedSessionId(slug)).toBeUndefined();
  });

  test("anything that is not a session link is left alone", () => {
    expect(
      pastedSessionId(
        `${HOST}/automations/auto-01a006d8-eddd-7000-bca2-b010caf2d8e7`,
      ),
    ).toBeUndefined();
    expect(
      pastedSessionId("https://github.com/tellahq/opensession/pull/92"),
    ).toBeUndefined();
    expect(pastedSessionId(ID)).toBeUndefined();
    expect(pastedSessionId("")).toBeUndefined();
  });
});
