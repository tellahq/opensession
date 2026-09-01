import { describe, expect, test } from "bun:test";
import { walkthroughLede } from "./walkthrough-lede";

describe("walkthroughLede", () => {
  test("takes the first paragraph", () => {
    expect(
      walkthroughLede(
        "The composer now keeps its draft.\nSwitching sessions no longer loses it.\n\nVerified at phone width.",
      ),
    ).toBe(
      "The composer now keeps its draft. Switching sessions no longer loses it.",
    );
  });

  test("skips a heading and a fence before the prose", () => {
    expect(
      walkthroughLede(
        "## What changed\n\n```sh\nbun test\n```\n\nThe fold opens.",
      ),
    ).toBe("The fold opens.");
  });

  test("reads markup as the text it renders", () => {
    expect(
      walkthroughLede(
        "- **Sessions** now show a [walkthrough](https://os.tella.dev) with `--session-col` ![shot](/a.png) width.",
      ),
    ).toBe("Sessions now show a walkthrough with --session-col width.");
  });

  test("keeps underscores inside an identifier", () => {
    expect(
      walkthroughLede("Renamed publish_walkthrough to publish_demo."),
    ).toBe("Renamed publish_walkthrough to publish_demo.");
  });

  test("has nothing to say about an empty writeup", () => {
    expect(walkthroughLede("")).toBe("");
    expect(walkthroughLede(undefined)).toBe("");
    expect(walkthroughLede("### Only a heading")).toBe("");
  });
});
