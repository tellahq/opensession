import { describe, expect, test } from "bun:test";
import { extractQuickActions, latestAssistantReplyText } from "./quick-actions";
import type { TranscriptEntry } from "./types";

describe("extractQuickActions", () => {
  test("extracts ```copy <label> fences and human-action URLs without touching URLs inside code fences", () => {
    const md = [
      "Opened https://github.com/tellahq/app/pull/42 and queued the refund:",
      "[Approve refund](https://dashboard.stripe.com/approval_requests/ar_123)",
      "Run this locally:",
      "```copy migrate command",
      "bun run db:migrate",
      "```",
      "```sh",
      "curl https://github.com/tellahq/app/pull/999",
      "```",
    ].join("\n");

    const actions = extractQuickActions(md);
    expect(actions).toEqual([
      {
        kind: "copy",
        id: "copy-0",
        label: "Copy migrate command",
        value: "bun run db:migrate",
      },
      {
        kind: "link",
        id: "link-0",
        label: "Review Stripe approval",
        url: "https://dashboard.stripe.com/approval_requests/ar_123",
      },
      {
        kind: "link",
        id: "link-1",
        label: "Open PR #42",
        url: "https://github.com/tellahq/app/pull/42",
      },
    ]);
  });

  test("deduplicates URLs and handles Linear, Vercel preview, and explicit action links", () => {
    const md = [
      "Tracked in https://linear.app/acme/issue/ENG-123 and https://linear.app/acme/issue/ENG-123.",
      "Preview live at https://app-pr-9.vercel.app.",
      "[Review release notes](https://docs.example.com/release/v2)",
    ].join("\n");

    const actions = extractQuickActions(md);
    expect(actions.map((a) => a.label)).toEqual([
      "Review release notes",
      "Open ENG-123",
      "Open preview",
    ]);
  });

  test("ignores plain non-action prose and non-action URLs", () => {
    const md = "See https://example.com/docs for background details.";
    expect(extractQuickActions(md)).toEqual([]);
  });
});

describe("latestAssistantReplyText", () => {
  test("collects only assistant entries after the last user prompt", () => {
    const entries: TranscriptEntry[] = [
      {
        id: "1",
        type: "user",
        content: "first",
        timestamp: "2026-01-01T00:00:00Z",
      },
      {
        id: "2",
        type: "assistant",
        content: "old reply https://github.com/tellahq/app/pull/1",
        timestamp: "2026-01-01T00:00:01Z",
      },
      {
        id: "3",
        type: "user",
        content: "second",
        timestamp: "2026-01-01T00:00:02Z",
      },
      {
        id: "4",
        type: "assistant",
        content: "new reply https://github.com/tellahq/app/pull/2",
        timestamp: "2026-01-01T00:00:03Z",
      },
    ];

    expect(latestAssistantReplyText(entries)).toBe(
      "new reply https://github.com/tellahq/app/pull/2",
    );
  });
});
