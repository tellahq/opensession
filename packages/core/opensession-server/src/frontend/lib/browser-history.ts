/**
 * Back and forward for a framed page. The frame is cross-origin, so its own
 * link clicks are invisible to us; this history holds the addresses the pane
 * loaded (the starting URL and each one typed in the address bar).
 */
export interface BrowserHistory {
  readonly entries: readonly string[];
  readonly index: number;
}

export function startHistory(address: string): BrowserHistory {
  return { entries: [address], index: 0 };
}

export function currentAddress(history: BrowserHistory): string {
  return history.entries[history.index]!;
}

/** Loading the address already shown is a reload and adds no entry. */
export function visitAddress(
  history: BrowserHistory,
  address: string,
): BrowserHistory {
  if (currentAddress(history) === address) return history;
  const entries = [...history.entries.slice(0, history.index + 1), address];
  return { entries, index: entries.length - 1 };
}

export function canStep(history: BrowserHistory, delta: -1 | 1): boolean {
  const index = history.index + delta;
  return index >= 0 && index < history.entries.length;
}

export function stepHistory(
  history: BrowserHistory,
  delta: -1 | 1,
): BrowserHistory {
  return canStep(history, delta)
    ? { entries: history.entries, index: history.index + delta }
    : history;
}
