import type {
  AccountRefusal,
  AccountResolution,
  RoutableAccount,
} from "./types";

export type AttemptEvent<TEvent> =
  | { readonly kind: "replay-safe"; readonly value: TEvent }
  | { readonly kind: "client-visible"; readonly value: TEvent };

export type AttemptOutcome<TResult> =
  | { readonly kind: "succeeded"; readonly value: TResult }
  | { readonly kind: "retry-account"; readonly error: unknown }
  | { readonly kind: "failed"; readonly error: unknown };

export interface AccountAttempt<TAccount, TEvent, TResult> {
  readonly account: TAccount;
  readonly signal?: AbortSignal;
  readonly emit: (event: AttemptEvent<TEvent>) => void;
}

export type AccountWalkResult<TAccount, TResult> =
  | {
      readonly kind: "succeeded";
      readonly account: TAccount;
      readonly value: TResult;
    }
  | { readonly kind: "refused"; readonly refusal: AccountRefusal }
  | {
      readonly kind: "failed";
      readonly account: TAccount;
      readonly error: unknown;
      readonly replayBlocked: boolean;
    }
  | { readonly kind: "aborted" }
  | { readonly kind: "invalid-selection"; readonly accountId: string };

export interface WalkAccountsOptions<
  TAccount extends RoutableAccount,
  TEvent,
  TResult,
> {
  readonly acquire: (
    excludedIds: ReadonlySet<string>,
  ) => AccountResolution<TAccount> | Promise<AccountResolution<TAccount>>;
  readonly attempt: (
    input: AccountAttempt<TAccount, TEvent, TResult>,
  ) => AttemptOutcome<TResult> | Promise<AttemptOutcome<TResult>>;
  readonly onEvent: (event: TEvent) => void;
  readonly onRetry?: (
    account: TAccount,
    error: unknown,
  ) => void | Promise<void>;
  readonly signal?: AbortSignal;
}

/**
 * Tries accounts until one succeeds or the router refuses another pick.
 * A retry is allowed only before an attempt emits client-visible output.
 */
export async function walkAccounts<
  TAccount extends RoutableAccount,
  TEvent,
  TResult,
>(
  options: WalkAccountsOptions<TAccount, TEvent, TResult>,
): Promise<AccountWalkResult<TAccount, TResult>> {
  const excludedIds = new Set<string>();

  while (!options.signal?.aborted) {
    const resolution = await options.acquire(excludedIds);
    if (resolution.kind === "refused") return resolution;
    const { account } = resolution;
    if (excludedIds.has(account.id)) {
      return { kind: "invalid-selection", accountId: account.id };
    }

    let replayBlocked = false;
    let outcome: AttemptOutcome<TResult>;
    try {
      outcome = await options.attempt({
        account,
        signal: options.signal,
        emit: (event) => {
          if (event.kind === "client-visible") replayBlocked = true;
          options.onEvent(event.value);
        },
      });
    } catch (error) {
      outcome = { kind: "failed", error };
    }

    if (outcome.kind === "succeeded") {
      return { kind: "succeeded", account, value: outcome.value };
    }
    if (outcome.kind === "failed" || replayBlocked) {
      return {
        kind: "failed",
        account,
        error: outcome.error,
        replayBlocked,
      };
    }

    excludedIds.add(account.id);
    await options.onRetry?.(account, outcome.error);
  }

  return { kind: "aborted" };
}
