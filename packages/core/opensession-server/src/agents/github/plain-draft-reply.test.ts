import { afterEach, expect, test } from "bun:test";
import {
  footerPlainSession,
  messagesWithPlainDraftReply,
  plainDraftReplyPrompt,
} from "./session-notify";

const threads: Record<string, string> = {
  "os-triage": "th_acme",
  "bks-ghpr-7-review": "th_acme",
};
const threadOf = (id: string) => threads[id];

test("a Plain triage session is asked for a draft reply, others keep the FYI", () => {
  const out = messagesWithPlainDraftReply(
    ["os-triage", "os-other", "bks-ghpr-7-review"],
    "PR #7 deployed. No action needed.",
    threadOf,
    {
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      stage: "deployed",
      replaceBase: true,
    },
  );
  expect(out.get("os-other")).toBe("PR #7 deployed. No action needed.");
  // The PR agent's own runs never draft customer replies.
  expect(out.get("bks-ghpr-7-review")).toBe(
    "PR #7 deployed. No action needed.",
  );
  const ask = out.get("os-triage")!;
  expect(ask).toBe(
    plainDraftReplyPrompt(
      7,
      "th_acme",
      "deployed",
      "https://github.com/acme/app/pull/7",
    ),
  );
  expect(ask).toContain("says https://github.com/acme/app/pull/7 is deployed");
  expect(ask).toContain("Plain thread th_acme");
  expect(ask).toContain("mcp__plain__create_note");
  expect(ask).toContain("DRAFT REPLY:");
  expect(ask).not.toContain("No action needed");
});

test("a verify prompt keeps its text and gets the draft ask after it", () => {
  const out = messagesWithPlainDraftReply(
    ["os-triage"],
    "Verify the deploy.",
    threadOf,
    { number: 7, stage: "deployed", replaceBase: false },
  );
  expect(out.get("os-triage")).toStartWith("Verify the deploy.\n\n");
  expect(out.get("os-triage")).toContain("DRAFT REPLY:");
});

const priorSlug = process.env.OPENSESSION_GITHUB_APP_SLUG;
afterEach(() => {
  if (priorSlug === undefined) delete process.env.OPENSESSION_GITHUB_APP_SLUG;
  else process.env.OPENSESSION_GITHUB_APP_SLUG = priorSlug;
});

test("the trusted PR footer finds a triage session on another branch", () => {
  process.env.OPENSESSION_GITHUB_APP_SLUG = "acme-os";
  const control = {
    getSession: (id: string) =>
      ({
        "os-triage": { id, plainThreadId: "th_acme" },
        "os-plain": { id },
        "os-done": { id, plainThreadId: "th_old", archived: true },
      })[id] as any,
  };
  const pr = (login: string, id: string) => ({
    user: { login },
    body: `Fix\n\nStarted by A in [this OS session](https://example.test/session/${id})`,
  });
  expect(footerPlainSession(pr("acme-os[bot]", "os-triage"), control)).toBe(
    "os-triage",
  );
  // Not a Plain session, an archived one, an untrusted author, or no footer: nothing extra.
  expect(
    footerPlainSession(pr("acme-os[bot]", "os-plain"), control),
  ).toBeUndefined();
  expect(
    footerPlainSession(pr("acme-os[bot]", "os-done"), control),
  ).toBeUndefined();
  expect(
    footerPlainSession(pr("stranger", "os-triage"), control),
  ).toBeUndefined();
  expect(
    footerPlainSession({ user: { login: "acme-os[bot]" } }, control),
  ).toBeUndefined();
});
