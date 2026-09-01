import { test, expect, describe } from "bun:test";
import { noticeTone, stripNoticeGlyph } from "./notices";

// The strings below are copied from the call sites that write them, so this
// test fails if a message is reworded without re-checking its tone.
describe("noticeTone", () => {
  test("terminal run failures read as errors", () => {
    // run-session.ts, both choke points.
    expect(noticeTone("Run failed: pi prompt failed: rate limit")).toBe(
      "error",
    );
    expect(
      noticeTone("Run stopped: Usage limit reached on every account"),
    ).toBe("error");
    // SessionViewer's live `error` event, which prefixes its own glyph.
    expect(noticeTone("⚠ Run failed: Session is busy")).toBe("error");
    // The per-turn time limit (turnTimeoutNotice/turnTimeoutError).
    expect(
      noticeTone(
        "Stopped after 3 hours — the limit for a single turn. " +
          "Everything up to here is saved; send a message to continue.",
      ),
    ).toBe("error");
    expect(
      noticeTone("Stopped after 90 minutes — the limit for a single turn."),
    ).toBe("error");
    // The pre-2026-07-31 wording, still sitting in older transcripts.
    expect(
      noticeTone(
        "Turn stopped after 180 minutes — it hit the wall-clock limit " +
          "(turnTimeoutMinutes in ~/.opensession-pi.json). Work up to here is saved; " +
          "send a message to continue.",
      ),
    ).toBe("error");
    // A sandbox workspace with nothing to fall back to.
    expect(
      noticeTone(
        "Sandbox unavailable (boot timeout) — this workspace lives in the sandbox and has no host fallback.",
      ),
    ).toBe("error");
    expect(
      noticeTone("Frontend rebuild failed — see logs. (Error: oops)"),
    ).toBe("error");
    expect(
      noticeTone(
        'Frontend rebuild failed — still serving the last good bundle. PrPanel.tsx: Expected closing JSX tag to match opening tag "<main>"',
      ),
    ).toBe("error");
  });

  test("recovered-from trouble reads as a warning", () => {
    expect(
      noticeTone(
        "Sandbox unavailable (egress blocked) — running on the host this turn.",
      ),
    ).toBe("warn");
    expect(
      noticeTone(
        "Couldn't recreate the worktree (fatal: branch not found); running in the main checkout instead.",
      ),
    ).toBe("warn");
    expect(
      noticeTone(
        "This session's worktree is gone; running in the main checkout.",
      ),
    ).toBe("warn");
    expect(noticeTone("App update paused. No action needed.")).toBe("warn");
  });

  test("routine operational chatter stays neutral", () => {
    expect(
      noticeTone(
        "Session was busy — message queued; it sends when the current run finishes.",
      ),
    ).toBe("info");
    expect(
      noticeTone("Holding 2 queued messages until the agent fully completes."),
    ).toBe("info");
    expect(
      noticeTone(
        "Opus 4.8 hit its usage limit — using Sonnet 5 for this turn only.",
      ),
    ).toBe("info");
    expect(
      noticeTone("Still mid-task — auto-continuing first; 1 queued message."),
    ).toBe("info");
    expect(noticeTone("")).toBe("info");
  });

  test("a run that merely mentions failure is not itself a failure", () => {
    // The word appears constantly in agent-written status lines; only the
    // runner's own prefixes count.
    expect(
      noticeTone("Background task update: the build failed, retrying"),
    ).toBe("info");
  });
});

test("stripNoticeGlyph drops a leading glyph the tone re-supplies", () => {
  expect(stripNoticeGlyph("⚠ Run failed: boom")).toBe("Run failed: boom");
  expect(stripNoticeGlyph("Run failed: boom")).toBe("Run failed: boom");
  // Only leading glyphs go — an arrow inside the sentence is content.
  expect(
    stripNoticeGlyph("Turn stopped after 3 minutes — it hit ⚠ the limit"),
  ).toBe("Turn stopped after 3 minutes — it hit ⚠ the limit");
});
