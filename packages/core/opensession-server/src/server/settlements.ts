/**
 * Per-user workspace settlement overrides. Settled is personal sidebar triage,
 * not a global workspace state: one teammate can file work away while another
 * keeps it active. Entries are keyed by the sidebar row key and record the
 * person's latest explicit Settle or Unsettle action.
 */

import { userStore } from "./shared/user-store";

export type SettlementOverride = "settled" | "active";

export interface SettlementRecord {
  state: SettlementOverride;
  at: string;
  /** PR lifecycle seen when the person acted. Suppresses the same terminal
	    PR from immediately undoing Unsettle or a later return to active work. */
  terminalSignature?: string;
}

export type Settlements = Record<string, SettlementRecord>;

function clean(raw: unknown): Settlements {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Settlements = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key || !value || typeof value !== "object" || Array.isArray(value))
      continue;
    const record = value as Record<string, unknown>;
    if (record.state !== "settled" && record.state !== "active") continue;
    if (typeof record.at !== "string" || Number.isNaN(Date.parse(record.at)))
      continue;
    out[key] = {
      state: record.state,
      at: record.at,
      ...(typeof record.terminalSignature === "string"
        ? { terminalSignature: record.terminalSignature.slice(0, 2_000) }
        : {}),
    };
  }
  return out;
}

const store = userStore<Settlements>({
  name: "settlements",
  field: "settlements",
  clean,
});

export function getSettlements(user: string): Settlements {
  return store.get(user);
}

export function setSettlements(
  user: string,
  settlements: unknown,
): Settlements {
  return store.set(user, settlements);
}
