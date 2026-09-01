import { describe, expect, test } from "bun:test";
import { progressHeaderText, taskCardTitle } from "./progress";

describe("Slack progress card copy", () => {
  const session = {
    sessionUrl: "https://os.tella.dev/session/slack-C123-456",
    linkText: "fix-comment-layout",
  };

  test("describes a new session as newly created", () => {
    expect(progressHeaderText(session)).toBe(
      "Created and started working on <https://os.tella.dev/session/slack-C123-456|fix-comment-layout>",
    );
  });

  test("describes a follow-up as a comment on the existing session", () => {
    expect(
      progressHeaderText({ ...session, continuedBy: "Kent de Bruin" }),
    ).toBe(
      "Kent de Bruin added a comment to <https://os.tella.dev/session/slack-C123-456|fix-comment-layout>",
    );
  });

  test("uses the Slack comment as the task title", () => {
    expect(
      taskCardTitle("And also shorten that text. It can just be '22h ago'"),
    ).toBe("And also shorten that text. It can just be '22h ago'");
  });
});
