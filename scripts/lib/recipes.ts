/**
 * Bundled automation recipes.
 *
 * A fresh install boots healthy and does nothing, because automations are
 * per-instance data rather than source. That is the right default — nobody
 * wants someone else's cron jobs — but it leaves new operators with a blank
 * page and no sense of what the thing is for.
 *
 * So the repository ships a small library of *generic* recipes under
 * `recipes/automations/`, off by default, that an operator opts into. Anything
 * specific to one company's product, people or vocabulary stays out of the
 * repository and lives in that instance's config.
 *
 * Installing a recipe writes it into `integrations.seeds.automations` in
 * config.json rather than into the automation store directly. That reuses the
 * existing, tested seeding path (`ensureConfiguredAutomations`, which is
 * create-if-absent and keyed on eventKey), so this code never has to know how
 * automations are persisted, validated or migrated.
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { CONFIG_PATH, REPO_ROOT } from "./paths";

export type Recipe = {
  id: string;
  label: string;
  description: string;
  /** Integration ids that must be enabled for this to do anything. */
  requires?: string[];
  /** Offered during onboarding. */
  recommended?: boolean;
  /** Extra caveat shown when installing. */
  notes?: string;
  automation: {
    name: string;
    prompt: string;
    eventKey?: string;
    schedule?: string;
    mode?: "ask" | "code";
    enabled?: boolean;
    mcpServers?: string[];
    /** Reviewer requested on PRs a `code` recipe opens — a GitHub login, an
     *  `org/team` slug, or a comma-separated list. Set it on every code
     *  recipe; a PR nobody is asked to review is one nobody sees. */
    prReviewer?: string;
    [key: string]: unknown;
  };
};

export const RECIPES_DIR = join(REPO_ROOT, "recipes", "automations");

export function listRecipes(): Recipe[] {
  if (!existsSync(RECIPES_DIR)) return [];
  const recipes: Recipe[] = [];
  for (const file of readdirSync(RECIPES_DIR).sort()) {
    if (!file.endsWith(".json")) continue;
    try {
      const recipe = JSON.parse(
        readFileSync(join(RECIPES_DIR, file), "utf8"),
      ) as Recipe;
      if (recipe?.id && recipe?.automation?.prompt) recipes.push(recipe);
    } catch {
      // A malformed recipe should not break `opensession automations`.
    }
  }
  return recipes;
}

export function findRecipe(id: string): Recipe | undefined {
  return listRecipes().find((r) => r.id === id);
}

type Config = Record<string, any>;

async function readConfig(): Promise<Config> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(await Bun.file(CONFIG_PATH).text());
  } catch {
    return {};
  }
}

/** Seeded automations, by the key `ensureConfiguredAutomations` matches on. */
export async function installedKeys(): Promise<Set<string>> {
  const config = await readConfig();
  const seeded = config.integrations?.seeds?.automations;
  const keys = new Set<string>();
  if (Array.isArray(seeded)) {
    for (const entry of seeded) {
      if (entry?.eventKey) keys.add(String(entry.eventKey));
      else if (entry?.name) keys.add(String(entry.name));
    }
  }
  return keys;
}

function keyOf(recipe: Recipe): string {
  return recipe.automation.eventKey || recipe.automation.name;
}

export async function isInstalled(recipe: Recipe): Promise<boolean> {
  return (await installedKeys()).has(keyOf(recipe));
}

/**
 * Append a recipe to the config seed list. Idempotent: seeding itself is
 * create-if-absent, and this refuses to add a duplicate entry.
 */
export async function installRecipe(
  recipe: Recipe,
  /** Provenance stamped on the seed. An installable package passes its own
   *  name here, so an automation stays traceable to what put it there
   *  (scripts/lib/plugins.ts). */
  createdBy = `opensession recipe: ${recipe.id}`,
): Promise<"added" | "already-present"> {
  const config = await readConfig();
  config.integrations ??= {};
  config.integrations.seeds ??= {};
  // The seed pass is gated on this; installing a recipe implies wanting it.
  config.integrations.seeds.enabled = true;
  config.integrations.seeds.automations ??= [];

  const list = config.integrations.seeds.automations as any[];
  const key = keyOf(recipe);
  if (list.some((e) => (e?.eventKey || e?.name) === key))
    return "already-present";

  list.push({ ...recipe.automation, createdBy });
  await Bun.write(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  return "added";
}

export async function removeRecipe(recipe: Recipe): Promise<boolean> {
  const config = await readConfig();
  const list = config.integrations?.seeds?.automations;
  if (!Array.isArray(list)) return false;

  const key = keyOf(recipe);
  const next = list.filter((e: any) => (e?.eventKey || e?.name) !== key);
  if (next.length === list.length) return false;

  config.integrations.seeds.automations = next;
  await Bun.write(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  return true;
}
