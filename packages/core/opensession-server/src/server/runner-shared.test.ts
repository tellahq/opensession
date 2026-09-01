import { describe, expect, test } from "bun:test";
import {
  askBashDenyReason,
  declaredRunFailure,
  describeUsageLimitReset,
  hasRunStatusDeclaration,
  isClaudeBridgeLaunchError,
  isClaudeSubscriptionError,
  isClaudeUsageLimitError,
  isClaudeMalformedTerminalError,
  isProviderOverloadError,
  isTransientRunError,
  isUpstreamIdleStallError,
  usageLimitResetAt,
} from "./runner-shared";

describe("isClaudeUsageLimitError", () => {
  test("recognizes provider notices before they leak into streamed output", () => {
    expect(
      isClaudeUsageLimitError(
        "You've reached your Fable 5 limit. Switch to another model to continue.",
        false,
      ),
    ).toBe(true);
    expect(
      isClaudeUsageLimitError(
        "You've hit your weekly limit · resets Aug 20, 9am (UTC)",
        false,
      ),
    ).toBe(true);
  });
});

describe("isClaudeSubscriptionError", () => {
  test("recognizes subscription and organization policy blocks", () => {
    expect(
      isClaudeSubscriptionError(
        "Claude Max subscription issue. Check your subscription status.",
      ),
    ).toBe(true);
    expect(
      isClaudeSubscriptionError(
        "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access",
      ),
    ).toBe(true);
    expect(isClaudeSubscriptionError("ordinary tool failure")).toBe(false);
  });
});

describe("isClaudeBridgeLaunchError", () => {
  test("matches the two shapes the agent SDK emits", () => {
    expect(
      isClaudeBridgeLaunchError(
        "Claude Code native binary at /home/ubuntu/projects/opensession/node_modules/.bin/claude exists but failed to launch.",
      ),
    ).toBe(true);
    expect(
      isClaudeBridgeLaunchError(
        "Claude Code native binary not found at /opt/claude. Please ensure Claude Code is installed via native installer.",
      ),
    ).toBe(true);
  });

  test("does not claim faults that belong to another recovery lane", () => {
    // Usage limits and subscription faults are account-level and own their own
    // (much longer) sideline; a model's own words about a launch must never
    // wedge the account either.
    expect(isClaudeBridgeLaunchError("Claude AI usage limit reached")).toBe(
      false,
    );
    expect(
      isClaudeBridgeLaunchError(
        "Claude Max subscription issue. Check your subscription status.",
      ),
    ).toBe(false);
    expect(
      isClaudeBridgeLaunchError(
        "the deploy script failed to launch the server",
      ),
    ).toBe(false);
    expect(isClaudeBridgeLaunchError("command not found: claude")).toBe(false);
    expect(isClaudeBridgeLaunchError("")).toBe(false);
  });
});

describe("isUpstreamIdleStallError", () => {
  test("matches Meridian's idle-guard kill", () => {
    // The exact shape from the 2026-08-03 bks-019fc819 incident.
    expect(
      isUpstreamIdleStallError("Upstream stalled: no data for 160090ms"),
    ).toBe(true);
    expect(
      isUpstreamIdleStallError(
        "AI_APICallError: Upstream stalled: no data for 91150ms",
      ),
    ).toBe(true);
  });

  test("does not match other stalls or provider errors", () => {
    expect(isUpstreamIdleStallError("Claude AI usage limit reached")).toBe(
      false,
    );
    expect(isUpstreamIdleStallError("upstream timeout while connecting")).toBe(
      false,
    );
    expect(isUpstreamIdleStallError("no data received")).toBe(false);
    expect(isUpstreamIdleStallError("")).toBe(false);
  });
});

describe("isClaudeMalformedTerminalError", () => {
  test("matches Claude's malformed user-terminal diagnostic", () => {
    expect(
      isClaudeMalformedTerminalError(
        "Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null\n" +
          "Subprocess stderr: Warning: Custom betas are only available for API key users. Ignoring provided betas.",
      ),
    ).toBe(true);
    expect(
      isTransientRunError(
        "Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
      ),
    ).toBe(true);
  });

  test("does not mistake normal Claude errors or model text for the diagnostic", () => {
    expect(
      isClaudeMalformedTerminalError(
        "Claude Code returned an error result: You've hit your weekly limit",
      ),
    ).toBe(false);
    expect(
      isClaudeMalformedTerminalError("Please explain the ede_diagnostic field"),
    ).toBe(false);
    expect(isClaudeMalformedTerminalError("")).toBe(false);
  });
});

describe("isTransientRunError", () => {
  test("recovers when the Claude binary fails to launch", () => {
    expect(
      isTransientRunError(
        "Claude Code native binary at /home/ubuntu/.local/bin/claude exists but failed to launch.",
      ),
    ).toBe(true);
  });
});

describe("isProviderOverloadError", () => {
  test("matches provider-declared overloads", () => {
    expect(
      isProviderOverloadError(
        "Our servers are currently overloaded. Please try again later.",
      ),
    ).toBe(true);
    expect(isProviderOverloadError("overloaded_error")).toBe(true);
  });

  test("does not match unrelated transient failures", () => {
    expect(isProviderOverloadError("socket hang up")).toBe(false);
    expect(isProviderOverloadError("OpenAI usage limit reached")).toBe(false);
  });
});

describe("declaredRunFailure", () => {
  test("a failed declaration is returned with its reason, last line wins", () => {
    expect(
      declaredRunFailure(
        "summary…\nSCAN STATUS: failed — claude CLI auth failure",
      ),
    ).toBe("SCAN STATUS: failed — claude CLI auth failure");
    expect(declaredRunFailure("RUN STATUS: failed — dry pool")).toBe(
      "RUN STATUS: failed — dry pool",
    );
    // A closing ok clears an earlier quoted/failed line.
    expect(
      declaredRunFailure(
        "SCAN STATUS: failed — transient\nretried fine\nSCAN STATUS: ok",
      ),
    ).toBeNull();
  });

  test("ok, absent, and mid-line mentions do not declare failure", () => {
    expect(declaredRunFailure("all good\nSCAN STATUS: ok")).toBeNull();
    expect(declaredRunFailure("no status here")).toBeNull();
    // Not line-anchored ⇒ not a declaration (e.g. quoting the instruction).
    expect(
      declaredRunFailure("end with `SCAN STATUS: failed — <reason>` on errors"),
    ).toBeNull();
  });
});

describe("hasRunStatusDeclaration", () => {
  test("line-anchored status lines only", () => {
    expect(hasRunStatusDeclaration("done\nSCAN STATUS: ok")).toBe(true);
    expect(hasRunStatusDeclaration("done\nRUN STATUS: failed — x")).toBe(true);
    expect(hasRunStatusDeclaration("mentions SCAN STATUS: ok inline")).toBe(
      false,
    );
    expect(hasRunStatusDeclaration("")).toBe(false);
  });
});

describe("describeUsageLimitReset", () => {
  test("returns the account's own words, whatever the phrasing", () => {
    expect(
      describeUsageLimitReset(
        "You've hit your weekly limit · resets Aug 20, 9am (UTC)",
      ),
    ).toBe("Aug 20, 9am (UTC)");
    expect(
      describeUsageLimitReset(
        "You've hit your session limit · resets 12:50pm (UTC)",
      ),
    ).toBe("12:50pm (UTC)");
    expect(describeUsageLimitReset("5-hour limit reached ∙ resets 3am")).toBe(
      "3am",
    );
  });

  test("no reset stated means no opinion", () => {
    expect(
      describeUsageLimitReset("You're out of usage credits."),
    ).toBeUndefined();
    expect(describeUsageLimitReset("")).toBeUndefined();
  });
});

describe("usageLimitResetAt", () => {
  // A fixed "now" so these never drift: 2026-08-18T18:54:02Z, the minute the
  // weekly-limit failure this parser was written for actually happened.
  const now = Date.UTC(2026, 7, 18, 18, 54, 2);

  test("a dated weekly reset benches for days, not the one-hour default", () => {
    const at = usageLimitResetAt(
      "You've hit your weekly limit · resets Aug 20, 9am (UTC)",
      now,
    );
    expect(at).toBe(Date.UTC(2026, 7, 20, 9, 0));
    // The whole point: far beyond the hour markExhausted would have used.
    expect(at! - now).toBeGreaterThan(24 * 60 * 60 * 1000);
  });

  test("a bare time means the next occurrence of it", () => {
    // 3am has passed today ⇒ tomorrow.
    expect(usageLimitResetAt("5-hour limit reached ∙ resets 3am", now)).toBe(
      Date.UTC(2026, 7, 19, 3, 0),
    );
    // 11:30pm is still ahead today.
    expect(usageLimitResetAt("limit · resets 11:30pm (UTC)", now)).toBe(
      Date.UTC(2026, 7, 18, 23, 30),
    );
  });

  test("a date with no year picks the occurrence ahead of now", () => {
    const dec = Date.UTC(2026, 11, 30, 12, 0);
    expect(usageLimitResetAt("resets Jan 2, 9am (UTC)", dec)).toBe(
      Date.UTC(2027, 0, 2, 9, 0),
    );
  });

  test("refuses anything it cannot vouch for, so the caller keeps its default", () => {
    // No time of day.
    expect(usageLimitResetAt("resets soon", now)).toBeUndefined();
    // No reset at all.
    expect(
      usageLimitResetAt("You're out of usage credits.", now),
    ).toBeUndefined();
    // Unknown month.
    expect(usageLimitResetAt("resets Foo 20, 9am (UTC)", now)).toBeUndefined();
    // Beyond the 14-day ceiling: a mis-parse must never bench a healthy
    // account for weeks, which would be worse than the churn this replaces.
    expect(usageLimitResetAt("resets Sep 30, 9am (UTC)", now)).toBeUndefined();
  });
});

describe("askBashDenyReason", () => {
  test("allows plain reads", () => {
    expect(askBashDenyReason("cat README.md")).toBeNull();
    expect(askBashDenyReason("ls -la src")).toBeNull();
    expect(askBashDenyReason("git log --oneline -5")).toBeNull();
    expect(askBashDenyReason("jq '.runs[0]' file.json")).toBeNull();
    expect(askBashDenyReason("gh pr list --state open")).toBeNull();
    expect(askBashDenyReason("systemctl is-active opensession")).toBeNull();
    expect(askBashDenyReason("date +%s")).toBeNull();
    expect(askBashDenyReason("whoami")).toBeNull();
    expect(askBashDenyReason("id -u")).toBeNull();
    expect(askBashDenyReason("uname -a")).toBeNull();
    expect(askBashDenyReason("printenv TMPDIR")).toBeNull();
    expect(askBashDenyReason("readlink -f /home/ubuntu")).toBeNull();
    expect(askBashDenyReason("realpath /home/ubuntu")).toBeNull();
  });

  test("every pipeline segment must be allowed", () => {
    expect(askBashDenyReason("git log --oneline | head -5")).toBeNull();
    expect(askBashDenyReason("cat f.json | jq '.a' | wc -l")).toBeNull();
    // The allowed prefix must not smuggle the write.
    expect(askBashDenyReason("cat x && rm y")).toContain("rm y");
    expect(askBashDenyReason("ls; touch pwned")).toContain("touch pwned");
    expect(askBashDenyReason("cat f | tee out.txt")).toContain("tee out.txt");
  });

  test("denies writes and unlisted commands with an actionable reason", () => {
    const reason = askBashDenyReason("rm -rf /tmp/x");
    expect(reason).toContain("read-only allowlist");
    expect(askBashDenyReason("git push")).not.toBeNull();
    expect(askBashDenyReason("git add .")).not.toBeNull();
    // sed stays denied even in -n form (see the allowlist's own note).
    expect(askBashDenyReason("sed -n 1,5p file")).not.toBeNull();
    expect(askBashDenyReason("python3 -c 'print(1)'")).not.toBeNull();
    expect(askBashDenyReason("gh api repos/o/r -X POST")).not.toBeNull();
    expect(askBashDenyReason("systemctl restart opensession")).not.toBeNull();
  });

  test("refuses command and process substitution outright", () => {
    expect(askBashDenyReason("echo $(rm -rf /)")).toContain("substitution");
    expect(askBashDenyReason("echo `id`")).toContain("substitution");
    expect(askBashDenyReason('echo "$(id)"')).toContain("substitution");
    expect(askBashDenyReason("diff <(cat a) <(cat b)")).toContain(
      "substitution",
    );
  });

  test("redirection: fd dups and /dev/null pass, file writes do not", () => {
    expect(askBashDenyReason("ls missing 2>&1")).toBeNull();
    expect(askBashDenyReason("cat big > /dev/null")).toBeNull();
    expect(askBashDenyReason("ls 2>/dev/null")).toBeNull();
    expect(askBashDenyReason("echo hi > /tmp/f")).toContain("redirection");
    expect(askBashDenyReason("cat a >> b")).toContain("redirection");
    expect(askBashDenyReason("cmd &> log.txt")).toContain("redirection");
  });

  test("quoting does not hide separators or unquote them wrongly", () => {
    // A quoted semicolon is data, not a separator: still one jq segment.
    expect(askBashDenyReason("jq '.a; .b' f.json")).toBeNull();
    // Literal $( inside single quotes is data too.
    expect(askBashDenyReason("grep -n '$(x)' file")).toBeNull();
  });
});
