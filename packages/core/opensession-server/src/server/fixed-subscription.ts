/**
 * Fixed-subscription policy (opt-in, off by default).
 *
 * A session created with `subscriptionPolicy: "fixed"` is funded by exactly
 * one provider account for its whole life: the account pinned at creation.
 * Every turn, whether a queued prompt, a retry, a restart recovery or a
 * continuation, runs with that account as a hard pin, no usage credits and
 * no automatic model fallback. When the account cannot serve, the turn fails
 * with a clear error instead of moving to another account, the shared pool,
 * API billing or another provider. Sessions created from a fixed session
 * (children, spawned workers, standalone creates its agent asks for, forks)
 * inherit the same account and policy and cannot choose another one.
 *
 * Who prompts is unchanged: attribution and the per-account owner gate still
 * use the real prompter, so a personal account never serves someone else.
 *
 * Unmanaged sessions (no policy) keep their soft-pin behavior.
 */
import { getAccountById } from "./claude-accounts";
import { getCodexAccountById } from "./codex-accounts";
import { accountProviderForModel } from "./models";
import { getXaiAccountById } from "./xai-accounts";

export type SubscriptionPolicy = "fixed";

type PolicySession = {
  id?: string;
  subscriptionPolicy?: SubscriptionPolicy;
  accountId?: string;
};

export function isFixedSubscription(
  session: Pick<PolicySession, "subscriptionPolicy"> | null | undefined,
): boolean {
  return session?.subscriptionPolicy === "fixed";
}

/** The provider pool that owns an account id, or undefined when no pool does. */
function accountProviderOfId(
  accountId: string,
): "claude" | "codex" | "xai" | undefined {
  if (getAccountById(accountId)) return "claude";
  if (getCodexAccountById(accountId)) return "codex";
  if (getXaiAccountById(accountId)) return "xai";
  return undefined;
}

/**
 * Why a fixed session's account cannot fund a run of `model`, or undefined
 * when it can be tried. Usage limits are not checked here: the strict pin in
 * account selection refuses an exhausted account on its own.
 */
export function fixedSubscriptionModelError(
  accountId: string | undefined,
  model: string | undefined,
): string | undefined {
  if (!accountId)
    return "This session has a fixed subscription but no funding account. Start a new session with an account.";
  const accountProvider = accountProviderOfId(accountId);
  if (!accountProvider)
    return "This session's funding account is no longer connected. Reconnect the same account, or start a new session with a different one.";
  const modelProvider = accountProviderForModel(model);
  if (modelProvider !== accountProvider)
    return `This session has a fixed subscription on a ${providerLabel(accountProvider)} account, so it cannot run ${model || "the default model"}. Pick a ${providerLabel(accountProvider)} model, or start a new session.`;
  return undefined;
}

/** Refusal for one turn of a fixed session, or undefined for every other session. */
export function fixedSubscriptionTurnError(session: {
  subscriptionPolicy?: SubscriptionPolicy;
  accountId?: string;
  model?: string;
}): string | undefined {
  if (!isFixedSubscription(session)) return undefined;
  return fixedSubscriptionModelError(session.accountId, session.model);
}

function providerLabel(provider: "claude" | "codex" | "xai"): string {
  return provider === "codex"
    ? "Codex"
    : provider === "xai"
      ? "SuperGrok"
      : "Claude";
}

/**
 * Resolve the funding fields of a new session.
 *
 * `sources` are the sessions this one is created from (fork source, parent,
 * the session whose agent asked for it). Every fixed source is checked, not
 * just the first: some sources come from tool arguments (forkFrom,
 * parentSessionId), so none may replace another's funding. When the fixed
 * sources disagree on the account the create fails; otherwise the new
 * session inherits that account and policy, and an explicit different
 * account is an error rather than a silent override. Without a fixed source,
 * `fixed: true` opts a fresh session in and needs a pin the creator may use
 * (`pinnedAccountId`, already validated by resolvePinnedAccountId). Without
 * either the existing soft pin passes through unchanged.
 */
export function resolveCreateSubscriptionPolicy(input: {
  fixed?: unknown;
  sources: ReadonlyArray<PolicySession | null | undefined>;
  model: string | undefined;
  requestedAccountId: unknown;
  pinnedAccountId: string | undefined;
}): { accountId: string | undefined; subscriptionPolicy?: SubscriptionPolicy } {
  const fixedSources = input.sources.filter(
    (s): s is PolicySession => !!s && isFixedSubscription(s),
  );
  if (fixedSources.length) {
    const accountIds = new Set(fixedSources.map((s) => s.accountId));
    if (accountIds.size > 1)
      throw new Error(
        `Sessions ${fixedSources.map((s) => s.id || "(unknown)").join(", ")} have fixed subscriptions on different accounts. A new session can only be created from sessions that share one funding account.`,
      );
    const source = fixedSources[0];
    if (
      typeof input.requestedAccountId === "string" &&
      input.requestedAccountId &&
      input.requestedAccountId !== source.accountId
    )
      throw new Error(
        `${source.id ? `Session ${source.id}` : "The source session"} has a fixed subscription. Sessions created from it use the same account and cannot choose another one.`,
      );
    const error = fixedSubscriptionModelError(source.accountId, input.model);
    if (error) throw new Error(error);
    return { accountId: source.accountId, subscriptionPolicy: "fixed" };
  }
  if (input.fixed === true) {
    if (!input.pinnedAccountId)
      throw new Error(
        "A fixed subscription needs an accountId that you can use with the selected model.",
      );
    const error = fixedSubscriptionModelError(
      input.pinnedAccountId,
      input.model,
    );
    if (error) throw new Error(error);
    return { accountId: input.pinnedAccountId, subscriptionPolicy: "fixed" };
  }
  return { accountId: input.pinnedAccountId };
}
