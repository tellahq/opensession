/**
 * Repository-defined Changes-tab buttons (`shipActions` in config.json). Kept
 * free of imports so config.ts can parse them without a cycle; the rest of
 * the ship flow lives in ship-mode.ts.
 */

/** A repository-defined button beside Ship (`shipActions` in config.json). */
export interface ShipAction {
  label: string;
  prompt: string;
}

export const MAX_SHIP_ACTIONS = 6;
const MAX_SHIP_ACTION_LABEL = 40;
const MAX_SHIP_ACTION_PROMPT = 4000;

/** Keep the well-formed `shipActions` entries; drop the rest. */
export function parseShipActions(value: unknown): ShipAction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions: ShipAction[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { label, prompt } = entry as Record<string, unknown>;
    if (typeof label !== "string" || typeof prompt !== "string") continue;
    const cleanLabel = label.trim().slice(0, MAX_SHIP_ACTION_LABEL);
    const cleanPrompt = prompt.trim().slice(0, MAX_SHIP_ACTION_PROMPT);
    if (!cleanLabel || !cleanPrompt) continue;
    actions.push({ label: cleanLabel, prompt: cleanPrompt });
    if (actions.length >= MAX_SHIP_ACTIONS) break;
  }
  return actions.length ? actions : undefined;
}
