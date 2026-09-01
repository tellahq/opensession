import { useEffect, useState } from "react";
import { fetchEngines, type EngineCatalog } from "../lib/api/engines";

const EMPTY: EngineCatalog = { engines: [], modelEngines: {} };

/**
 * The engines a session may run on, for the model pickers.
 *
 * The pickers read this themselves rather than taking it as a prop: an engine
 * is a property of the instance, not of the surface showing the picker, and
 * every caller would otherwise thread the same global down its own tree. The
 * fetch is the cached /api/models read, so mounting a second picker costs
 * nothing.
 *
 * Returns an empty list on an older server or a failed fetch, which is what
 * hides the Engine row — the same state as a single-engine instance.
 */
export function useEngines(): EngineCatalog {
  const [catalog, setCatalog] = useState<EngineCatalog>(EMPTY);
  useEffect(() => {
    let live = true;
    fetchEngines()
      .then((value) => {
        if (live) setCatalog(value);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return catalog;
}

/** Just the engines a model can actually be routed to right now. */
export function useAvailableEngines(): EngineCatalog["engines"] {
  return useEngines().engines.filter((e) => e.available);
}
