export type AccountAccess =
  | { readonly kind: "shared" }
  | { readonly kind: "personal"; readonly owner: string };

export interface RoutableAccount {
  readonly id: string;
  readonly name: string;
  readonly access: AccountAccess;
}

export type AccountAvailability =
  | { readonly kind: "available"; readonly priority: number }
  | { readonly kind: "unavailable" };

export type PickReason =
  | "pinned"
  | "sticky"
  | "designated"
  | "personal"
  | "pool";

export type AccountRefusal =
  | { readonly kind: "none-configured" }
  | { readonly kind: "pool-dry" }
  | {
      readonly kind: "pin-unusable";
      readonly pinnedId: string;
      readonly pinName: string;
    }
  | {
      readonly kind: "pin-not-designated";
      readonly pinnedId: string;
      readonly pinName: string;
    }
  | { readonly kind: "designated-dry"; readonly tried: string };

export type AccountResolution<TAccount extends RoutableAccount> =
  | {
      readonly kind: "selected";
      readonly account: TAccount;
      readonly reason: PickReason;
    }
  | { readonly kind: "refused"; readonly refusal: AccountRefusal };

export interface AccountRequest<TModel> {
  readonly principalId?: string;
  readonly model?: TModel;
  readonly pinnedId?: string;
  readonly strictPin?: boolean;
  readonly stickyId?: string;
  readonly designatedIds?: readonly string[];
  readonly affinityKey?: string;
  readonly excludeIds?: ReadonlySet<string>;
  readonly allowPaidUsage?: boolean;
  readonly recordPick?: boolean;
}

export interface SelectionCandidate<TAccount extends RoutableAccount> {
  readonly account: TAccount;
  readonly priority: number;
}

export interface SelectionContext {
  readonly affinityKey?: string;
  readonly lastPickedAt: (accountId: string) => number;
}

export type AccountSelector<TAccount extends RoutableAccount> = (
  candidates: readonly SelectionCandidate<TAccount>[],
  context: SelectionContext,
) => TAccount;
