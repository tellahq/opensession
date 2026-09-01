import { describe, expect, it } from "bun:test";
import {
  cacheMissNotice,
  isGitHubAttribution,
  parseAttribution,
  parseRecoveryNotice,
  parseReviewHandoff,
  parseSessionNotice,
  parseWorkerReport,
  parseWorkflowNotice,
  classifyEntries,
  classifyEntry,
} from "./notices";
import type { TranscriptEntry } from "./session";

describe("human reply attribution", () => {
  it("parses bracketed attributions", () => {
    expect(parseAttribution("[Kent] Please check this")).toEqual({
      name: "Kent",
      body: "Please check this",
    });
  });

  it("identifies GitHub automation attributions", () => {
    expect(isGitHubAttribution("GitHub")).toBe(true);
    expect(isGitHubAttribution("GitHub (automation)")).toBe(true);
    expect(isGitHubAttribution("Kent")).toBe(false);
  });
});

describe("review handoff detection", () => {
  it("detects the sentinel form and strips it", () => {
    const parsed = parseReviewHandoff(
      "<!--os:review-handoff-->\n🔍 This session's PR #5109 “Fix previews” (branch `x`) was just reviewed…",
    );
    expect(parsed?.prNumber).toBe(5109);
    expect(parsed?.body.startsWith("🔍 This session's")).toBe(true);
  });

  it("detects pre-sentinel handoffs by their opener", () => {
    const parsed = parseReviewHandoff(
      "🔍 This session's PR #42 “t” was just reviewed…",
    );
    expect(parsed?.prNumber).toBe(42);
  });

  it("ignores other GitHub FYIs", () => {
    expect(parseReviewHandoff("🔀 PR #42 was merged")).toBeNull();
    expect(parseReviewHandoff("plain message")).toBeNull();
  });
});

describe("worker report detection", () => {
  const id = "bks-019fa49c-71bb-7000-85d4-c8cc61d0ca85";

  it("detects the delivered sentinel form and strips both markers", () => {
    const parsed = parseWorkerReport(
      `[worker ${id}] <!--os:worker-report-->\nInspection complete.`,
    );
    expect(parsed).toEqual({ sessionId: id, body: "Inspection complete." });
  });

  it("detects pre-sentinel reports by their worker attribution", () => {
    // parseAttribution can't: "worker <id>" is 47 chars, over its 40 cap —
    // which is why these used to render as raw text in the human's bubble.
    expect(parseAttribution(`[worker ${id}] Done.`)).toBeNull();
    expect(parseWorkerReport(`[worker ${id}] Done.`)).toEqual({
      sessionId: id,
      body: "Done.",
    });
  });

  it("carries the worker's id so the card can link back to it", () => {
    expect(
      parseWorkerReport(`<!--os:worker-report:${id}-->\nDone.`)?.sessionId,
    ).toBe(id);
  });

  it("recovers server failure beacons written before they carried a sentinel", () => {
    expect(
      parseWorkerReport(
        `Server notice: worker task \`${id}\` ended in error without reporting back.\nerror: timed out`,
      ),
    ).toEqual({
      sessionId: id,
      body: `Worker task \`${id}\` ended in error without reporting back.\nerror: timed out`,
    });
  });

  it("drops a stacked notice sentinel the card would render as raw HTML", () => {
    // A worker whose whole job was a workflow reports the workflow's own
    // nudge back, so the turn carries both sentinels.
    const parsed = parseWorkerReport(
      `<!--os:worker-report:${id}--><!--os:workflow-notice:wf-1-->\n✅ Workflow "crop-modal-review" finished`,
    );
    expect(parsed).toEqual({
      sessionId: id,
      body: '✅ Workflow "crop-modal-review" finished',
    });
  });

  it("leaves ordinary turns alone", () => {
    expect(parseWorkerReport("Please review the worker output")).toBeNull();
    expect(parseWorkerReport("[Kent] worker bks-1 looks stuck")).toBeNull();
  });
});

describe("workflow notice detection", () => {
  const run = "wf-019fadb0-1b1a-7000-bb6f-4e889643002f";

  it("detects the sentinel through the human attribution it's delivered under", () => {
    const parsed = parseWorkflowNotice(
      `[Alex Rivera] <!--os:workflow-notice:${run}-->\n✅ Workflow "perspective-review" finished (${run}) — 2 agents: 2 done.`,
    );
    expect(parsed?.runId).toBe(run);
    expect(parsed?.body.startsWith("✅ Workflow")).toBe(true);
  });

  it("detects pre-sentinel notices by their status opener", () => {
    expect(
      parseWorkflowNotice(`⚠️ Workflow "audit" failed (${run}) — 3 agents.`)
        ?.runId,
    ).toBe(run);
  });

  it("keeps the error tail with the notice", () => {
    const parsed = parseWorkflowNotice(
      `⚠️ Workflow "audit" failed (${run}).\nError: boom`,
    );
    expect(parsed?.body.endsWith("Error: boom")).toBe(true);
  });

  it("leaves a turn the human typed into alone", () => {
    // Typing while the notice lands merges both into one turn — dimming that
    // into the system pill would hide the question they actually asked.
    expect(
      parseWorkflowNotice(
        `✅ Workflow "perspective-review" finished (${run}) — 2 agents: 2 done.\n\nshould also be rendered as a different card`,
      ),
    ).toBeNull();
  });

  it("leaves ordinary turns alone", () => {
    expect(parseWorkflowNotice("Workflow finished, what now?")).toBeNull();
    expect(parseWorkflowNotice("✅ done")).toBeNull();
  });
});

describe("service restart recovery detection", () => {
  it("detects synthetic continuation prompts across persona names", () => {
    const content =
      "This session was interrupted by an Ada service restart mid-run. Review what you had already done.";
    expect(parseRecoveryNotice(content)).toEqual({ body: content });
    expect(
      parseRecoveryNotice(
        "This session was interrupted by an OS1 service restart mid-run. Pick up where you left off.",
      ),
    ).not.toBeNull();
  });

  it("leaves human messages that merely quote a recovery prompt alone", () => {
    expect(
      parseRecoveryNotice(
        "Can we collapse this?\n\nThis session was interrupted by an Ada service restart mid-run.",
      ),
    ).toBeNull();
  });
});

describe("cross-session notice detection", () => {
  const headsUp =
    "Heads-up from another session (Ada, working on the sidebar): a shared-checkout commit picked up your changes.\n\nNothing was lost.";

  it("detects an existing unmarked heads-up", () => {
    expect(parseSessionNotice(headsUp)).toEqual({
      body: headsUp,
      sessionId: null,
    });
  });

  it("strips the marker and delivery attribution from new notices", () => {
    expect(
      parseSessionNotice(`[Alex] <!--os:session-notice-->\n${headsUp}`),
    ).toEqual({ body: headsUp, sessionId: null });
  });

  it("recovers historical agent deliveries regardless of their prose", () => {
    for (const id of [
      "os-01a01e56-a1fc-7000-bb91-bc99b916c4ad",
      "bks-019fa49c-71bb-7000-85d4-c8cc61d0ca85",
    ]) {
      expect(
        parseSessionNotice(`[agent ${id}] Please reconcile these changes.`),
      ).toEqual({
        body: "Please reconcile these changes.",
        sessionId: id,
      });
    }
  });

  it("rejects a loose agent label that does not name a native session", () => {
    expect(
      parseSessionNotice("[agent release-bot] Please ship this."),
    ).toBeNull();
  });

  it("leaves ordinary prompts as user turns", () => {
    expect(
      parseSessionNotice("Please keep editing and commit the fix."),
    ).toBeNull();
  });

  it("does not hide a separately attributed prompt merged into the entry", () => {
    expect(
      parseSessionNotice(
        `<!--os:session-notice-->\n${headsUp}\n\n[Kent] Please also run the tests.`,
      ),
    ).toBeNull();
  });
});

describe("cacheMissNotice", () => {
  it("names the cost in thousands of tokens", () => {
    expect(cacheMissNotice(123_400)).toBe(
      "This turn re-uploaded the conversation · ~123k tokens re-cached",
    );
    expect(cacheMissNotice(20_500)).toBe(
      "This turn re-uploaded the conversation · ~21k tokens re-cached",
    );
  });

  it("drops a count that would round to nothing", () => {
    const bare = "This turn re-uploaded the conversation";
    expect(cacheMissNotice(0)).toBe(bare);
    expect(cacheMissNotice(999)).toBe(bare);
    expect(cacheMissNotice(undefined)).toBe(bare);
  });

  it("reads as a neutral system notice once persisted", () => {
    const classified = classifyEntry({
      id: "e1",
      type: "system",
      content: cacheMissNotice(123_400),
      timestamp: "2026-08-08T10:00:00.000Z",
    });
    expect(classified.notice).toEqual({
      kind: "system",
      title: "This turn re-uploaded the conversation · ~123k tokens re-cached",
      tone: "info",
    });
  });
});

describe("classifyEntry", () => {
  const entry = (over: Partial<TranscriptEntry>): TranscriptEntry => ({
    id: "e1",
    type: "user",
    content: "",
    timestamp: "2026-08-08T10:00:00.000Z",
    ...over,
  });

  it("leaves an ordinary message alone, by reference", () => {
    const e = entry({ content: "Can we simplify all these different ways?" });
    expect(classifyEntry(e)).toBe(e);
  });

  it("tones a system line by what it says", () => {
    expect(
      classifyEntry(entry({ type: "system", content: "run failed: boom" }))
        .notice,
    ).toMatchObject({ kind: "system", tone: "error" });
    expect(
      classifyEntry(
        entry({
          type: "system",
          content:
            "Switched Opus 5 + Fable oracle → GPT-5.6 sol · out of credits",
        }),
      ).notice,
    ).toMatchObject({ kind: "system", tone: "warn" });
    expect(
      classifyEntry(entry({ type: "system", content: "switched account" }))
        .notice,
    ).toMatchObject({ kind: "system", tone: "info" });
  });

  it("strips a glyph a notice already carries into the title", () => {
    const c = classifyEntry(
      entry({ type: "system", content: "⚠️ couldn't push" }),
    );
    expect(c.notice?.title).toBe("couldn't push");
    expect(c.content).toBe("couldn't push");
  });

  it("reads a recap inline and a compaction as a title", () => {
    expect(
      classifyEntry(
        entry({
          type: "system",
          content: "Fixed the build.",
          noticeKind: "recap",
        }),
      ).notice,
    ).toMatchObject({ kind: "recap", body: "inline" });
    expect(
      classifyEntry(
        entry({
          type: "system",
          content: "Earlier…",
          noticeKind: "compaction",
        }),
      ).notice,
    ).toMatchObject({
      kind: "compaction",
      title: "Context compacted",
    });
    expect(
      classifyEntry(
        entry({
          type: "system",
          content: "Earlier…",
          noticeKind: "compaction",
        }),
      ).notice?.body,
    ).toBeUndefined();
  });

  it("turns a worker report into a notice that links back to the worker", () => {
    const c = classifyEntry(
      entry({ content: "[worker os-123] <!--os:worker-report-->\nFound it." }),
    );
    expect(c.notice).toMatchObject({
      kind: "worker-report",
      title: "Worker report",
      body: "collapsed",
      link: { label: "Open worker", sessionId: "os-123" },
    });
    // The plumbing is gone: content is what a reader should see.
    expect(c.content).toBe("Found it.");
  });

  it("titles a review handoff with its PR", () => {
    const c = classifyEntry(
      entry({
        content:
          "[GitHub] <!--os:review-handoff-->\n🔍 This session's PR #42 has findings",
      }),
    );
    expect(c.notice).toMatchObject({
      kind: "review-handoff",
      title: "PR #42 review feedback",
      body: "collapsed",
    });
  });

  it("keeps a short GitHub status as a title-only notice, without its emoji", () => {
    const c = classifyEntry(entry({ content: "[GitHub] 🔀 merged" }));
    expect(c.notice).toMatchObject({ kind: "system", title: "merged" });
    expect(c.notice?.body).toBeUndefined();
  });

  it("gives merge and deploy notices an icon instead of a leading emoji", () => {
    const merged = classifyEntry(
      entry({
        content:
          '[GitHub] 🔀 This session\'s PR #4921 "Collapse player controls" was just merged into main by tella-butler.',
      }),
    );
    expect(merged.notice).toMatchObject({ tone: "info", icon: "merge" });
    expect(merged.notice?.title.startsWith("This session's")).toBe(true);
    expect(merged.content).not.toContain("🔀");

    // Every wording session-notify.ts has shipped classifies the same way.
    for (const content of [
      '[GitHub] PR #4921 "Collapse" was merged into main by Kent.',
      "[GitHub] PR #4921 merged by Kent. Deploying. No action needed.",
      "[GitHub] PR #4921 merged into release by Kent. No action needed.",
    ]) {
      expect(classifyEntry(entry({ content })).notice).toMatchObject({
        kind: "system",
        icon: "merge",
      });
    }

    const deployed = classifyEntry(
      entry({
        content: "[GitHub] 🚀 Deploy finished for PR #4921. The merge is live.",
      }),
    );
    expect(deployed.notice).toMatchObject({ icon: "deploy" });
    expect(deployed.notice?.title.startsWith("Deploy finished")).toBe(true);
    expect(
      classifyEntry(
        entry({ content: "[GitHub] PR #4921 deployed. No action needed." }),
      ).notice,
    ).toMatchObject({ icon: "deploy" });
  });

  it("strips a workflow notice's emoji and keeps the outcome in tone and icon", () => {
    const done = classifyEntry(
      entry({
        content:
          '<!--os:workflow-notice-->✅ Workflow "nightly" finished (wf-1)',
      }),
    );
    expect(done.notice).toMatchObject({
      kind: "workflow",
      tone: "info",
      icon: "done",
    });
    expect(done.notice?.title).toBe('Workflow "nightly" finished (wf-1)');

    const failed = classifyEntry(
      entry({
        content: '<!--os:workflow-notice-->⚠️ Workflow "nightly" failed (wf-1)',
      }),
    );
    expect(failed.notice).toMatchObject({ kind: "workflow", tone: "warn" });
    expect(failed.notice?.icon).toBeUndefined();
    expect(failed.notice?.title).toBe('Workflow "nightly" failed (wf-1)');
  });

  it("classifies workflow, session-notice and restart deliveries", () => {
    expect(
      classifyEntry(
        entry({
          content: '<!--os:workflow-notice-->✅ Workflow "nightly" finished',
        }),
      ).notice,
    ).toMatchObject({ kind: "workflow" });
    expect(
      classifyEntry(
        entry({ content: "<!--os:session-notice-->\nFYI: staging is down." }),
      ).notice,
    ).toMatchObject({
      kind: "session-notice",
      title: "Message from another session",
      body: "collapsed",
    });
    const historical = classifyEntry(
      entry({
        content:
          "[agent os-01a01e56-a1fc-7000-bb91-bc99b916c4ad] Please avoid overlapping edits.",
      }),
    );
    expect(historical.content).toBe("Please avoid overlapping edits.");
    expect(historical.notice).toMatchObject({
      kind: "session-notice",
      link: {
        label: "Open session",
        sessionId: "os-01a01e56-a1fc-7000-bb91-bc99b916c4ad",
      },
    });
    expect(
      classifyEntry(
        entry({
          content:
            "This session was interrupted by an OS service restart mid-run. Continue.",
        }),
      ).notice,
    ).toEqual({
      kind: "recovery",
      title: "Session resumed after a service restart",
      tone: "info",
    });
  });

  it("credits steered turns and routed-back answers with their real origin", () => {
    const steer = classifyEntry(entry({ content: "[Kent] check the logs" }));
    expect(steer.notice).toBeUndefined();
    expect(steer).toMatchObject({ sender: "Kent", content: "check the logs" });

    const inAppAnswer = classifyEntry(
      entry({ content: "💬 **Michiel** answered:\n\nShip it." }),
    );
    expect(inAppAnswer.notice).toBeUndefined();
    expect(inAppAnswer).toMatchObject({
      sender: "Michiel",
      content: "Ship it.",
    });
    expect(inAppAnswer.senderVia).toBeUndefined();

    const slackAnswer = classifyEntry(
      entry({ content: "💬 **Michiel** answered (via Slack):\n\nShip it." }),
    );
    expect(slackAnswer).toMatchObject({
      sender: "Michiel",
      senderVia: "slack",
      content: "Ship it.",
    });
  });

  it("carries exact answered-ask data into the read-only card notice", () => {
    const ask = {
      version: 1 as const,
      questions: [
        {
          header: "Demo choice",
          question: "Which version?",
          options: [
            { label: "Compact", description: "One calm card." },
            { label: "Detailed" },
          ],
          answer: "Detailed",
        },
      ],
    };
    const classified = classifyEntry(
      entry({
        type: "system",
        noticeKind: "ask",
        content:
          "Answered: Compact\n**Demo choice: Which version?**\n\n- **A. Compact**\n- B. Detailed",
        ask,
      }),
    );
    expect(classified.notice).toMatchObject({ kind: "ask", ask });
    expect(classified.notice?.ask?.questions[0].answer).toBe("Detailed");
    expect(classified.content).toStartWith("**Demo choice:");
  });

  it("falls back to legacy markdown when structured ask data is unsupported", () => {
    const classified = classifyEntry(
      entry({
        type: "system",
        noticeKind: "ask",
        content:
          "Answered: Compact\n**Demo choice: Which version?**\n\n- **A. Compact**\n- B. Detailed",
        ask: { version: 2, questions: [] } as never,
      }),
    );
    expect(classified.notice?.ask?.questions[0].answer).toBe("Compact");
  });

  it("upgrades an ask already classified by an older server", () => {
    const classified = classifyEntry(
      entry({
        type: "system",
        content:
          "**Demo choice: Which version?**\n\n- **A. Compact**\n- B. Detailed",
        notice: {
          kind: "ask",
          title: "Answered: Compact",
          tone: "info",
          body: "collapsed",
        },
      }),
    );
    expect(classified.notice?.ask?.questions[0].answer).toBe("Compact");
  });

  it("upgrades legacy answered-ask markdown for already-written records", () => {
    const classified = classifyEntry(
      entry({
        type: "system",
        noticeKind: "ask",
        content:
          "Answered: Compact\n**Demo choice: Which version?**\n\n- **A. Compact**\n- B. Detailed",
      }),
    );
    expect(classified.notice?.ask).toEqual({
      version: 1,
      questions: [
        {
          header: "Demo choice",
          question: "Which version?",
          options: [{ label: "Compact" }, { label: "Detailed" }],
          answer: "Compact",
        },
      ],
    });
  });

  it("is idempotent — a second pass can't strip twice", () => {
    const once = classifyEntry(
      entry({ content: "[worker os-9] <!--os:worker-report-->\nDone." }),
    );
    expect(classifyEntry(once)).toBe(once);
  });

  it("returns the same array when a batch holds only messages", () => {
    const batch = [
      entry({ content: "hi" }),
      entry({ id: "e2", type: "assistant", content: "hello" }),
    ];
    expect(classifyEntries(batch)).toBe(batch);
  });
});
