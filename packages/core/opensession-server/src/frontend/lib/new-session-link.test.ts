import { describe, expect, test } from "bun:test";
import { parseNewSessionLink } from "./new-session-link";

describe("parseNewSessionLink", () => {
  test("reads a same-origin new-session handoff", () => {
    expect(
      parseNewSessionLink(
        "https://os.tella.dev/new?mode=ask&repo=tella-fusion&branch=fix-blur&prompt=Investigate%20blur",
        "https://os.tella.dev",
      ),
    ).toEqual({
      mode: "ask",
      prompt: "Investigate blur",
      repo: "tella-fusion",
      branch: "fix-blur",
    });
  });

  test("rejects external and unrelated links", () => {
    expect(
      parseNewSessionLink("https://example.com/new", "https://os.tella.dev"),
    ).toBeNull();
    expect(
      parseNewSessionLink(
        "https://os.tella.dev/reports",
        "https://os.tella.dev",
      ),
    ).toBeNull();
  });
});
