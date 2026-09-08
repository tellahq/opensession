import { describe, expect, test } from "bun:test";
import { skipBotSynchronize } from "./webhook";

const base = {
  senderIsBot: true,
  action: "synchronize",
  codeLockHeld: false,
  autoFixActive: false,
  handoffActive: false,
};

describe("bot-sender synchronize gate", () => {
  // Regression (tella-fusion #6295, 2026-09-07): with a split push token every
  // session `git push` arrives as the bot sender. Once the handoff cleared on a
  // satisfied review, every later push was dropped and the PR was never
  // re-reviewed until someone toggled the review label.
  test("a session push with no code loop in flight is admitted", () => {
    expect(skipBotSynchronize(base)).toBe(false);
  });

  test("a push while a code loop holds the PR is skipped", () => {
    expect(skipBotSynchronize({ ...base, codeLockHeld: true })).toBe(true);
  });

  test("a push while auto-fix is marked active is skipped", () => {
    expect(skipBotSynchronize({ ...base, autoFixActive: true })).toBe(true);
  });

  test("an active handoff round always admits the push", () => {
    expect(
      skipBotSynchronize({ ...base, codeLockHeld: true, handoffActive: true }),
    ).toBe(false);
  });

  test("human senders and non-synchronize actions are never skipped here", () => {
    expect(
      skipBotSynchronize({ ...base, senderIsBot: false, codeLockHeld: true }),
    ).toBe(false);
    expect(
      skipBotSynchronize({ ...base, action: "opened", codeLockHeld: true }),
    ).toBe(false);
  });
});
