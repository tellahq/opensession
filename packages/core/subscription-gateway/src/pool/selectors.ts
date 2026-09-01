import type {
  AccountSelector,
  RoutableAccount,
  SelectionCandidate,
} from "./types";

function compareByPriorityAndLastPick<TAccount extends RoutableAccount>(
  left: SelectionCandidate<TAccount>,
  right: SelectionCandidate<TAccount>,
  lastPickedAt: (accountId: string) => number,
): number {
  return (
    left.priority - right.priority ||
    lastPickedAt(left.account.id) - lastPickedAt(right.account.id)
  );
}

export function leastRecentlyPicked<
  TAccount extends RoutableAccount,
>(): AccountSelector<TAccount> {
  return (candidates, context) => {
    const picked = candidates.toSorted((left, right) =>
      compareByPriorityAndLastPick(left, right, context.lastPickedAt),
    )[0];
    if (!picked) throw new Error("Account selector received no candidates");
    return picked.account;
  };
}

/**
 * FNV-1a rendezvous score shared with Open Session's current Codex picker.
 * Changing it moves existing affinity keys to different accounts.
 */
export function hrwScore(affinityKey: string, accountId: string): number {
  let hash = 0x811c9dc5;
  const value = `${affinityKey}\0${accountId}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function rendezvousAffinity<
  TAccount extends RoutableAccount,
>(): AccountSelector<TAccount> {
  const lru = leastRecentlyPicked<TAccount>();
  return (candidates, context) => {
    if (!context.affinityKey) return lru(candidates, context);
    const picked = candidates.toSorted(
      (left, right) =>
        left.priority - right.priority ||
        hrwScore(context.affinityKey ?? "", right.account.id) -
          hrwScore(context.affinityKey ?? "", left.account.id) ||
        left.account.id.localeCompare(right.account.id),
    )[0];
    if (!picked) throw new Error("Account selector received no candidates");
    return picked.account;
  };
}
