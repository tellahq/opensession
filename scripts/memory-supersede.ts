/**
 * One-off cleanup for the memory store: retire facts that a later entry has
 * already said are wrong.
 *
 * The store had no supersede relation until 2026-08-18, so a corrected fact
 * cost two entries forever: the model wrote "CORRECTION to memory <id>" into
 * the prose, and BOTH the correction and the thing it corrects stayed in every
 * future prompt. Measured on this instance, 36 entries were corrections, and
 * the entries they correct were all still being injected.
 *
 * This walks the store, reads those declarations, and archives the targets
 * (archivedAt + supersededBy). Nothing is deleted: archived entries stay in
 * the file and stay reachable through search_memory.
 *
 * Deliberately conservative. Only the verbs that mean "the older entry is
 * WRONG" archive anything:
 *
 *   CORRECTION / CORRECTS / SUPERSEDES / REPLACES  -> archive the target
 *   REFINES / EXTENDS / UPDATES / SHARPENS         -> report only
 *
 * The second group means the earlier entry still holds and the new one adds to
 * it, so archiving there would lose a true fact. Those are printed for a human
 * to judge.
 *
 *   bun scripts/memory-supersede.ts            # dry run, prints the plan
 *   bun scripts/memory-supersede.ts --apply    # write it
 */
import { readdirSync } from "fs";
import {
  loadScope,
  saveScope,
  type MemoryEntry,
} from "../packages/core/opensession-server/src/agents/slack/memory";
import { memoryDir } from "../packages/core/opensession-server/src/agents/slack/memory";

/** Verbs that assert the named entry is wrong. */
const ARCHIVING = /\b(CORRECTION|CORRECTS|SUPERSEDES|SUPERSEDED|REPLACES)\b/;
/** Verbs that build on the named entry rather than overturning it. */
const ADDITIVE = /\b(REFINES|EXTENDS|UPDATES|SHARPENS|RELATED)\b/;
/** Only the preamble names targets; ids deeper in the body are usually just
 *  cross-references ("see memory X for the recipe"). */
const PREAMBLE_CHARS = 240;
const ID =
  /\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/g;

interface Plan {
  scope: string;
  correction: MemoryEntry;
  targets: MemoryEntry[];
}

async function main() {
  const apply = process.argv.includes("--apply");
  const dir = memoryDir();
  const scopes = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();

  // Ids are global enough in practice, but resolve within a scope first and
  // fall back to a cross-scope lookup: a team-scope fact is often corrected
  // from a repo session and vice versa.
  const byScope = new Map<string, MemoryEntry[]>();
  const index = new Map<string, { scope: string; entry: MemoryEntry }>();
  for (const scope of scopes) {
    const entries = await loadScope(scope);
    byScope.set(scope, entries);
    for (const entry of entries) index.set(entry.id, { scope, entry });
  }

  const plans: Plan[] = [];
  const review: Array<{
    scope: string;
    entry: MemoryEntry;
    targets: string[];
  }> = [];

  for (const [scope, entries] of byScope) {
    for (const entry of entries) {
      if (entry.archivedAt) continue;
      const preamble = entry.text.slice(0, PREAMBLE_CHARS);
      const archiving = ARCHIVING.test(preamble);
      const additive = ADDITIVE.test(preamble);
      if (!archiving && !additive) continue;
      const ids = [...new Set(preamble.match(ID) || [])].filter(
        (id) => id !== entry.id,
      );
      const found = ids
        .map((id) => index.get(id))
        .filter((hit): hit is NonNullable<typeof hit> => !!hit);
      if (!found.length) continue;
      // "CORRECTS ... but EXTENDS ..." is ambiguous; treat any additive verb
      // in the same preamble as a reason for a human to look.
      if (archiving && !additive) {
        plans.push({
          scope,
          correction: entry,
          targets: found.map((f) => f.entry),
        });
      } else {
        review.push({
          scope,
          entry,
          targets: found.map((f) => `${f.entry.id} (${f.scope})`),
        });
      }
    }
  }

  let reclaimed = 0;
  console.log(`\n=== archive (${plans.length} corrections) ===`);
  for (const plan of plans) {
    console.log(`\n[${plan.correction.id}] ${plan.scope}`);
    console.log(
      `  says: ${plan.correction.text.slice(0, 120).replace(/\s+/g, " ")}…`,
    );
    for (const target of plan.targets) {
      reclaimed += target.text.length;
      console.log(
        `  archives [${target.id}] (${target.text.length} chars): ${target.text.slice(0, 90).replace(/\s+/g, " ")}…`,
      );
    }
  }

  console.log(
    `\n=== needs a human (${review.length} additive references, nothing archived) ===`,
  );
  for (const item of review) {
    console.log(
      `[${item.entry.id}] ${item.scope} -> ${item.targets.join(", ")}`,
    );
    console.log(`  ${item.entry.text.slice(0, 110).replace(/\s+/g, " ")}…`);
  }

  const total = [...byScope.values()]
    .flat()
    .reduce((n, e) => n + (e.archivedAt ? 0 : e.text.length), 0);
  console.log(
    `\n${reclaimed.toLocaleString()} chars (~${Math.round(reclaimed / 4).toLocaleString()} tokens) ` +
      `of ${total.toLocaleString()} come out of every prompt.`,
  );

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to write it.");
    return;
  }

  const at = new Date().toISOString();
  const touched = new Set<string>();
  for (const plan of plans) {
    for (const target of plan.targets) {
      if (target.archivedAt) continue;
      target.archivedAt = at;
      target.supersededBy = plan.correction.id;
      const owner = index.get(target.id)?.scope;
      if (owner) touched.add(owner);
    }
    const ids = plan.targets.map((t) => t.id);
    plan.correction.supersedes = [
      ...new Set([...(plan.correction.supersedes || []), ...ids]),
    ];
    touched.add(plan.scope);
  }
  for (const scope of touched) await saveScope(scope, byScope.get(scope)!);
  console.log(`\nWrote ${touched.size} scope file(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
