/**
 * The sidebar's view of the automations themselves — audience, filing and the
 * latest published report — keyed by name, because a session only carries the
 * name of the automation that ran it.
 *
 * Refreshed off automation activity rather than a timer: a report is published
 * by a run, so the run's own arrival in the session list is the signal that
 * there may be a new one. Callers pass that as `refreshKey`.
 */

import { useEffect, useState } from "react";
import {
  fetchAutomationOverview,
  type AutomationOverview,
} from "./api/automations";

export type AutomationOverviewByName = Map<string, AutomationOverview>;

const EMPTY: AutomationOverviewByName = new Map();

export function useAutomationOverview(
  refreshKey: string,
): AutomationOverviewByName {
  const [byName, setByName] = useState<AutomationOverviewByName>(EMPTY);
  useEffect(() => {
    let live = true;
    fetchAutomationOverview()
      .then((list) => {
        if (!live) return;
        setByName(new Map(list.map((a) => [a.name, a])));
      })
      // A sidebar that can't reach this endpoint keeps the band it had
      // before the audience existed: every automation, no gist.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [refreshKey]);
  return byName;
}
