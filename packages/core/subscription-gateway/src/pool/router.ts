import type {
  AccountAvailability,
  AccountRequest,
  AccountResolution,
  AccountSelector,
  RoutableAccount,
  SelectionCandidate,
} from "./types";

export interface AccountRouterOptions<
  TAccount extends RoutableAccount,
  TModel,
> {
  readonly accounts: () => readonly TAccount[];
  readonly availability: (
    account: TAccount,
    request: Pick<AccountRequest<TModel>, "model" | "allowPaidUsage">,
  ) => AccountAvailability;
  readonly select: AccountSelector<TAccount>;
  readonly ownerMatches?: (principalId: string, owner: string) => boolean;
  readonly clock?: () => number;
}

export class AccountRouter<TAccount extends RoutableAccount, TModel = string> {
  readonly #options: AccountRouterOptions<TAccount, TModel>;
  readonly #lastPickedAt = new Map<string, number>();

  constructor(options: AccountRouterOptions<TAccount, TModel>) {
    this.#options = options;
  }

  resolve(request: AccountRequest<TModel>): AccountResolution<TAccount> {
    const accounts = this.#options.accounts();
    const byId = new Map(accounts.map((account) => [account.id, account]));
    const designatedIds = request.designatedIds?.length
      ? request.designatedIds
      : undefined;
    const isDesignated = (id: string): boolean =>
      !designatedIds || designatedIds.includes(id);
    const nameOf = (id: string): string => byId.get(id)?.name ?? id;
    const usable = (id: string): SelectionCandidate<TAccount> | undefined => {
      if (request.excludeIds?.has(id)) return undefined;
      const account = byId.get(id);
      if (!account || !this.#canUse(account, request.principalId)) {
        return undefined;
      }
      const availability = this.#options.availability(account, request);
      return availability.kind === "available"
        ? { account, priority: availability.priority }
        : undefined;
    };

    if (request.pinnedId) {
      if (!isDesignated(request.pinnedId)) {
        if (request.strictPin) {
          return {
            kind: "refused",
            refusal: {
              kind: "pin-not-designated",
              pinnedId: request.pinnedId,
              pinName: nameOf(request.pinnedId),
            },
          };
        }
      } else {
        const pinned = usable(request.pinnedId);
        if (pinned) {
          return {
            kind: "selected",
            account: pinned.account,
            reason: "pinned",
          };
        }
        if (request.strictPin) {
          return {
            kind: "refused",
            refusal: {
              kind: "pin-unusable",
              pinnedId: request.pinnedId,
              pinName: nameOf(request.pinnedId),
            },
          };
        }
      }
    }

    if (request.stickyId && isDesignated(request.stickyId)) {
      const sticky = usable(request.stickyId);
      if (sticky) {
        return {
          kind: "selected",
          account: sticky.account,
          reason: "sticky",
        };
      }
    }

    if (designatedIds) {
      for (const id of designatedIds) {
        const designated = usable(id);
        if (designated) {
          return {
            kind: "selected",
            account: designated.account,
            reason: "designated",
          };
        }
      }
      return {
        kind: "refused",
        refusal: {
          kind: "designated-dry",
          tried: designatedIds.map(nameOf).join(", "),
        },
      };
    }

    const candidates = accounts.flatMap((account) => {
      const candidate = usable(account.id);
      return candidate ? [candidate] : [];
    });
    const personal = candidates.filter(
      ({ account }) => account.access.kind === "personal",
    );
    const pool = personal.length
      ? personal
      : candidates.filter(({ account }) => account.access.kind === "shared");
    if (!pool.length) {
      return {
        kind: "refused",
        refusal: accounts.length
          ? { kind: "pool-dry" }
          : { kind: "none-configured" },
      };
    }

    const account = this.#options.select(pool, {
      affinityKey: request.affinityKey,
      lastPickedAt: (accountId) => this.#lastPickedAt.get(accountId) ?? 0,
    });
    if (request.recordPick ?? true) {
      this.#lastPickedAt.set(account.id, this.#options.clock?.() ?? Date.now());
    }
    return {
      kind: "selected",
      account,
      reason: account.access.kind === "personal" ? "personal" : "pool",
    };
  }

  forget(accountId: string): void {
    this.#lastPickedAt.delete(accountId);
  }

  #canUse(account: TAccount, principalId: string | undefined): boolean {
    if (account.access.kind === "shared") return true;
    if (!principalId) return false;
    return (
      this.#options.ownerMatches?.(principalId, account.access.owner) ??
      principalId === account.access.owner
    );
  }
}
