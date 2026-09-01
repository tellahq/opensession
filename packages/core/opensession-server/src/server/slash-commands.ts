/**
 * Open Session-native slash commands (/pstack /poteto-mode /goal /loop /model /account /compact /help) —
 * consumed by the WS prompt path, the opensession-sessions send_to_session tool,
 * and interactive resumes. Returns a notice string when the message was handled
 * as a command, or null to send it to the engine as a normal prompt.
 */

import { productName } from "./config";
import { isPstackCommand, pstackCommandInput } from "./pstack-mode";
import { listAccountsPublic } from "./claude-accounts";
import { listCodexAccountsPublic } from "./codex-accounts";
import {
  accountProviderForModel,
  formatModelList,
  getDefaultModel,
  modelLabel,
  providerFor,
  resolveModel,
} from "./models";
import { engineFamily } from "./agent-runner";
import { userMatchesAny } from "./shared/user-mappings";
import { syncAgentSessionEngine } from "./agent-session-sync";
import { touchNativeSession } from "./session-cache";
import { broadcastToSession } from "./ws-hub";
import { resolveWorkspaceModelPreset } from "./workspace-model-presets";
import type { UnifiedSession } from "./types";

/**
 * Open Session-native slash commands. Returns a notice string when the message
 * was consumed as a command, or null to send it to Claude as a normal prompt.
 */
export function handleSlashCommand(
  session: UnifiedSession,
  text: string,
  user?: string,
): string | null {
  const accountCommand =
    text === "/account" ||
    text.startsWith("/account ") ||
    text === "/sub" ||
    text.startsWith("/sub ");
  if (
    !isPstackCommand(text) &&
    !text.startsWith("/goal") &&
    !text.startsWith("/loop") &&
    !text.startsWith("/model") &&
    !accountCommand &&
    text !== "/compact" &&
    !text.startsWith("/compact ") &&
    text !== "/help"
  ) {
    return null;
  }
  if (session.source !== "opensession") {
    // /model works on slack-source sessions too: persistence goes through
    // syncAgentSessionEngine — the one sanctioned writer into
    // ~/.slack-sessions (patches the file AND the loop's in-memory copy) —
    // so the UI picker/composer can switch a Slack thread's model without
    // racing the owning loop. Everything else stays agent-owned.
    if (!(session.source === "slack" && text.startsWith("/model"))) {
      return "Slash commands only work on backstage-created sessions (Slack/Linear session files are agent-owned).";
    }
  }

  if (text === "/help") {
    return [
      `${productName()} commands:`,
      "/pstack <task> — enable rigorous pstack mode and start the task",
      "/poteto-mode <task> — alias for /pstack",
      "/pstack off or /poteto-mode off — disable the mode",
      "/goal <text> — pin a goal, appended to every prompt until cleared",
      "/goal clear — remove the goal",
      "/loop <interval> <prompt> — re-run a prompt on an interval (e.g. /loop 30m check CI and fix failures)",
      "/loop stop — stop the loop",
      "/model — show the session's model and what's available",
      "/model <name> — switch model (e.g. /model opus, /model sol)",
      "/account — show the session's provider account and what's available",
      "/account <name> — prefer one Claude or Codex account for this conversation",
      "/account auto — back to automatic (personal-first, shared-pool fallback)",
      "/compact — summarize the conversation so far to shrink context and cost (Claude sessions only)",
    ].join("\n");
  }

  if (isPstackCommand(text)) {
    const input = pstackCommandInput(text);
    if (!input || ["show", "status"].includes(input.toLowerCase())) {
      return session.pstackMode
        ? "Pstack mode is on. Use /pstack off or /poteto-mode off to disable it."
        : "Pstack mode is off. Use /pstack <task> or /poteto-mode <task> to enable it.";
    }
    if (["off", "disable", "stop"].includes(input.toLowerCase())) {
      touchNativeSession(session.id, { pstackMode: undefined });
      return "Pstack mode disabled.";
    }
    if (["on", "enable", "start"].includes(input.toLowerCase())) {
      touchNativeSession(session.id, { pstackMode: true });
      return "Pstack mode enabled. It will apply to future turns until /pstack off.";
    }
    // A task-bearing invocation is both the sticky mode switch and a regular
    // skill prompt. Returning null lets Pi expand the bundled pstack skill for
    // this first turn; later turns receive the compact standing mode note.
    touchNativeSession(session.id, { pstackMode: true });
    return null;
  }

  if (text === "/model" || text === "/model show" || text === "/model list") {
    return [
      `Current model: ${session.model || getDefaultModel()}${session.model ? "" : " (default)"}`,
      "",
      "Available models (set with /model <name or alias>):",
      formatModelList(session.model),
    ].join("\n");
  }
  if (text.startsWith("/model ")) {
    // Deliberately NOT gated on a running turn. The switch applies from the
    // next prompt either way (the model is read at dispatch), so a live turn
    // is undisturbed, and refusing here blocked the one moment people most
    // want to switch: right after a run died on a usage limit, while
    // isAgentSessionBusy still reports the interrupted run as busy. Every
    // surface came through here — the web model picker sends "/model <id>"
    // as a prompt — so the refusal was universal, not a pi quirk.
    // The one real hazard is handled where it happens: the end-of-turn
    // fallback write in run-session.ts now only lands while the stored model
    // is still what the run started on, so it cannot revert this choice.
    const input = text.slice("/model ".length).trim();
    const workspacePreset = resolveWorkspaceModelPreset(
      input,
      session.workspaceId,
    );
    const resolved = workspacePreset
      ? { id: workspacePreset.id }
      : resolveModel(input);
    if (!resolved) {
      return [
        `Unknown model "${input}". Available:`,
        formatModelList(session.model),
      ].join("\n");
    }
    const prevModel = session.model || getDefaultModel();
    const prevEffectiveModel =
      resolveWorkspaceModelPreset(prevModel)?.model || prevModel;
    const effectiveResolvedModel = workspacePreset?.model || resolved.id;
    if (session.source === "slack") {
      if (prevModel === resolved.id) {
        return `Already on ${workspacePreset?.label || resolved.id}.`;
      }
      // Slack session files don't carry modelHistory; the sync writer
      // patches the model field only (existing files, atomic).
      if (!syncAgentSessionEngine(session, { model: resolved.id })) {
        return "Couldn't update the Slack session file — send /model <name> in the Slack thread instead.";
      }
    } else {
      const switchedProvider =
        accountProviderForModel(prevEffectiveModel) !==
        accountProviderForModel(effectiveResolvedModel);
      touchNativeSession(session.id, {
        model: resolved.id,
        autoFallbackModel: undefined,
        presetNote: workspacePreset?.note,
        ...(workspacePreset?.effort ? { effort: workspacePreset.effort } : {}),
        ...(switchedProvider ? { accountId: undefined } : {}),
        modelHistory: [
          ...(session.modelHistory || []),
          {
            model: resolved.id,
            from: prevModel,
            at: new Date().toISOString(),
            by: user,
          },
        ],
      });
      if (switchedProvider && session.accountId) {
        broadcastToSession(session.id, {
          type: "subscription_changed",
          sessionId: session.id,
          accountId: null,
          name: null,
          by: user,
        });
      }
    }
    // Everyone watching sees the switch (pill + inline divider) immediately
    broadcastToSession(session.id, {
      type: "model_changed",
      sessionId: session.id,
      model: resolved.id,
      from: prevModel,
      by: user,
    });
    // Compare underlying engine families, not resolveModel providers: a
    // stored pi/<provider>/<model> id reports provider "pi",
    // which would false-positive against a native id's "claude"/"codex".
    const switchedProvider =
      engineFamily(prevEffectiveModel) !== engineFamily(effectiveResolvedModel);
    return (
      `Model set to ${workspacePreset?.label || modelLabel(resolved.id)}. Applies from the next prompt.` +
      (switchedProvider
        ? engineFamily(effectiveResolvedModel) === "openai"
          ? " Heads up: this hands the wheel to Codex on the next prompt. The Codex engine can't share Claude's internal thread, so it gets a transcript handoff of the conversation so far and continues from there (switching back to a Claude model resumes its own history)."
          : " Heads up: this hands the wheel back to Claude on the next prompt. Claude resumes its own earlier history (if any) and gets a transcript handoff of the turns Codex ran in between."
        : "")
    );
  }

  // Pin (or clear) the current model provider's account. `/sub` remains an
  // alias for existing links and muscle memory.
  const accountInput = accountCommand
    ? text.replace(/^\/(?:account|sub)\s*/, "").trim()
    : "";
  const accountProvider = accountProviderForModel(
    resolveWorkspaceModelPreset(session.model)?.model || session.model,
  );
  if (accountCommand && !accountProvider) {
    return `${modelLabel(session.model)} does not use a managed Claude or Codex account pool.`;
  }
  const providerLabel = accountProvider === "codex" ? "Codex" : "Claude";
  const accounts = (
    accountProvider === "codex"
      ? listCodexAccountsPublic()
      : listAccountsPublic()
  ).filter(
    (account) =>
      !account.owner || (!!user && userMatchesAny(user, [account.owner])),
  );
  const accountLabel = (account: (typeof accounts)[number]) =>
    account.email?.trim() || account.name;
  if (
    accountCommand &&
    (!accountInput || accountInput === "show" || accountInput === "list")
  ) {
    const current = session.accountId
      ? accounts.find((a) => a.id === session.accountId)
      : null;
    const line = (a: (typeof accounts)[number]) =>
      `${a.id === session.accountId ? "• " : "  "}${accountLabel(a)}` +
      `${a.owner ? ` (personal — ${a.owner})` : " (pool)"}` +
      `${a.usable ? "" : " — exhausted"}`;
    return [
      `${providerLabel} account: ${current ? accountLabel(current) : "auto (personal-first, pool fallback)"}`,
      "",
      "Available (set with /account <email>, or /account auto to unpin):",
      ...accounts.map(line),
    ].join("\n");
  }
  if (
    accountCommand &&
    ["auto", "clear", "none", "default"].includes(accountInput.toLowerCase())
  ) {
    touchNativeSession(session.id, { accountId: undefined });
    broadcastToSession(session.id, {
      type: "subscription_changed",
      sessionId: session.id,
      accountId: null,
      name: null,
      by: user,
    });
    return `${providerLabel} account set to auto (personal-first, shared-pool fallback). Applies from the next prompt.`;
  }
  if (accountCommand) {
    const input = accountInput;
    const match =
      accounts.find((a) => a.id === input) ||
      accounts.find(
        (a) => accountLabel(a).toLowerCase() === input.toLowerCase(),
      ) ||
      accounts.find((a) => a.name.toLowerCase() === input.toLowerCase());
    if (!match) {
      return [
        `Unknown ${providerLabel} account "${input}". Available:`,
        ...accounts.map(
          (a) =>
            `  ${accountLabel(a)}${a.owner ? ` (personal — ${a.owner})` : " (pool)"}`,
        ),
      ].join("\n");
    }
    touchNativeSession(session.id, { accountId: match.id });
    broadcastToSession(session.id, {
      type: "subscription_changed",
      sessionId: session.id,
      accountId: match.id,
      name: accountLabel(match),
      by: user,
    });
    const exhaustedNote = match.usable
      ? ""
      : " Heads up: this account is currently exhausted, so runs fall back to the pool until it resets.";
    return `${providerLabel} account pinned to ${accountLabel(match)}. Applies from the next prompt.${exhaustedNote}`;
  }

  // /compact is a built-in command of the Claude Agent SDK, not a opensession
  // config change: we return null so the "/compact" text flows through to the
  // runner, where the SDK summarizes the live context and continues from that
  // summary (emitting a compact_boundary). We intercept only to (a) block it on
  // Codex sessions, which have no such command and would otherwise get the
  // literal text as a prompt, and (b) give the room immediate feedback, since
  // the SDK's own output for the command is terse. Unlike the marathon-session
  // problem this exists to fight, it's a manual lever — auto-compact still only
  // fires near the context-window ceiling.
  if (text === "/compact" || text.startsWith("/compact ")) {
    if (providerFor(session.model) === "codex") {
      return "/compact only applies to Claude sessions — Codex manages its own context window. Switch to a Claude model with /model first, or start a fresh session to shed context.";
    }
    broadcastToSession(session.id, {
      type: "notice",
      sessionId: session.id,
      message:
        "Compacting context — the next reply continues from a summary of the conversation so far.",
    });
    return null; // fall through: the SDK runs its built-in /compact on this turn
  }

  if (text === "/goal" || text === "/goal show") {
    return session.goal
      ? `Current goal: ${session.goal}`
      : "No goal set. Use /goal <text>.";
  }
  if (text === "/goal clear") {
    touchNativeSession(session.id, { goal: undefined });
    return "Goal cleared.";
  }
  if (text.startsWith("/goal ")) {
    const goal = text.slice("/goal ".length).trim();
    if (!goal) return "Usage: /goal <text>";
    touchNativeSession(session.id, { goal });
    return `Goal pinned: ${goal} — it will ride along with every prompt until /goal clear.`;
  }

  if (text === "/loop" || text === "/loop status") {
    return session.loop
      ? `Loop active: every ${session.loop.intervalMinutes}m — "${session.loop.prompt}"`
      : "No loop set. Use /loop <interval> <prompt> (e.g. /loop 30m check CI).";
  }
  if (text === "/loop stop" || text === "/loop off" || text === "/loop clear") {
    touchNativeSession(session.id, { loop: undefined });
    return "Loop stopped.";
  }
  if (text.startsWith("/loop ")) {
    const rest = text.slice("/loop ".length).trim();
    const match = rest.match(/^(\d+)\s*(m|min|h|hr)?\s+([\s\S]+)$/);
    if (!match)
      return "Usage: /loop <interval> <prompt> — e.g. /loop 30m check CI and fix failures";
    let minutes = parseInt(match[1]);
    if (match[2] === "h" || match[2] === "hr") minutes *= 60;
    minutes = Math.max(5, minutes);
    const prompt = match[3].trim();
    touchNativeSession(session.id, {
      loop: {
        prompt,
        intervalMinutes: minutes,
        lastRunAt: new Date().toISOString(),
        setBy: user,
      },
    });
    return `Loop set: every ${minutes}m — "${prompt}". First run in ${minutes}m; /loop stop to end it.`;
  }

  return null;
}
