import { describe, expect, test } from "bun:test";
import { announcesNextAction } from "./auto-continue";

describe("announcesNextAction", () => {
  test("matches the observed bks-019f533e announce-then-stop tail", () => {
    expect(
      announcesNextAction(
        "Research is complete across all three areas. Now let me read the exact code at the key insertion points before implementing.",
      ),
    ).toBe(true);
  });

  test("matches classic I'll-do-X-then-Y endings", () => {
    expect(
      announcesNextAction("I'll rebase onto master and then open the PR."),
    ).toBe(true);
    expect(
      announcesNextAction(
        "The tests pass. Next, I will wire the frontend half.",
      ),
    ).toBe(true);
    expect(announcesNextAction("I’m going to restart the service now.")).toBe(
      true,
    );
  });

  test("matches unfinished tails from bks-019fad64 after tool use", () => {
    expect(
      announcesNextAction(
        "The init effect has no readiness check, so I need to check whether that static value ever updates in the editor, and where.",
      ),
    ).toBe(true);
    expect(
      announcesNextAction(
        "The Seeking branch pushes unconditionally. I need to check whether pushCommand is a safe no-op before init runs.",
      ),
    ).toBe(true);
    expect(
      announcesNextAction(
        "Both edits applied. Now the init effect's deps need `uploadsReady` added so it re-runs when readiness flips.",
      ),
    ).toBe(true);
  });

  test("matches noun-phrase step announcements (observed bks-019fc72d tail)", () => {
    expect(
      announcesNextAction(
        "The MCP tools dropped; continuing with native tools. Next: where the render path turns `audio_source: Enhanced` into an actual file, and whether it silently falls back.",
      ),
    ).toBe(true);
    expect(
      announcesNextAction("Then: the fallback readiness check in segment.rs."),
    ).toBe(true);
    expect(
      announcesNextAction("Next step: wire the frontend half of the flag."),
    ).toBe(true);
  });

  test("does not match non-step colon tails", () => {
    expect(
      announcesNextAction(
        "Summary: the cache key never included the audio source.",
      ),
    ).toBe(false);
    expect(announcesNextAction("Result: all four tests pass.")).toBe(false);
  });

  test("matches bare gerund announcements (observed bks-019f54f8 tail)", () => {
    expect(announcesNextAction("Fetching the review comments on #4791.")).toBe(
      true,
    );
    expect(announcesNextAction("Now running the failing tests.")).toBe(true);
    expect(announcesNextAction("Checking the CI status before pushing.")).toBe(
      true,
    );
    expect(announcesNextAction("Working on it right away.")).toBe(true);
  });

  test("does not match gerund-shaped completions or -ing non-verbs", () => {
    expect(announcesNextAction("Testing complete.")).toBe(false);
    expect(announcesNextAction("Everything is working now.")).toBe(false);
    expect(
      announcesNextAction("During the run, the flag was already set."),
    ).toBe(false);
    expect(announcesNextAction("Nothing matching the pattern was found.")).toBe(
      false,
    );
    expect(
      announcesNextAction("Assuming the flag is set, this behaves the same."),
    ).toBe(false);
  });

  test("does not match completions", () => {
    expect(announcesNextAction("Implemented and pushed as e9e13a7e.")).toBe(
      false,
    );
    expect(
      announcesNextAction(
        "Live verification completed: the bundle contains the new label and health checks pass.",
      ),
    ).toBe(false);
  });

  test("does not treat explanatory needs as announced work", () => {
    expect(
      announcesNextAction("Users need to log in before opening this page."),
    ).toBe(false);
    expect(
      announcesNextAction("Now users need to log in before opening this page."),
    ).toBe(false);
  });

  test("does not match questions or handoffs to the human", () => {
    expect(
      announcesNextAction("Should I also apply this to the Slack loop?"),
    ).toBe(false);
    expect(
      announcesNextAction(
        "I pushed the fix — let me know if you want the toast variant instead.",
      ),
    ).toBe(false);
    expect(
      announcesNextAction("I'll wait for your decision on the schema."),
    ).toBe(false);
    expect(
      announcesNextAction(
        "Done. Say the word if you want me to merge it as well.",
      ),
    ).toBe(false);
  });

  test("ignores empty and trivial tails", () => {
    expect(announcesNextAction("")).toBe(false);
    expect(announcesNextAction("Done.")).toBe(false);
  });
});
