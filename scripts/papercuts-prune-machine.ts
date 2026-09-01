/**
 * Remove machine-emitted verdicts from the papercut store.
 *
 * A papercut is meant to be friction a run NOTICED and wrote down in the
 * moment. `silentDropMessage` (src/server/turn-outcome.ts) is not that: it is
 * a verdict the server computes when an unattended turn ends without reaching
 * anyone, and it was being appended as a papercut on every occurrence.
 *
 * Measured 2026-08-18 over the whole store: 583 of 2,616 entries (22%) were
 * that one boilerplate, 529 of them from `automation` runs, still landing
 * 30-50 times a day. The remaining 2,033 entries have 2,011 distinct openings,
 * so the human-written half barely repeats at all — the duplication is
 * entirely machine-generated.
 *
 * That matters because the store's only consumer is the nightly digest. A
 * fifth of what it reads being one repeated line crowds out the entries logged
 * once, which are the whole point. And a line logged 583 times is not a
 * papercut at all: it is an unfixed bug that the log kept restating instead of
 * escalating.
 *
 * This prunes those rows from the daily files. It does NOT prune by age:
 * the oldest entries include friction nobody has fixed yet, which is exactly
 * what is worth keeping.
 *
 *   bun scripts/papercuts-prune-machine.ts          # dry run
 *   bun scripts/papercuts-prune-machine.ts --apply  # rewrite the day files
 */
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs";
import { stateDir } from "../packages/core/opensession-server/src/server/paths";

/** The stable opening of silentDropMessage(). Matching the whole string would
 *  miss the per-kind word in the middle ("automation", "github-review"). */
const MACHINE_OPENINGS = [
  /^An unattended .+ run ended without reaching anyone/,
];

const dir = stateDir("papercuts");
if (!existsSync(dir)) {
  console.log(`No papercut store at ${dir}.`);
  process.exit(0);
}

const apply = process.argv.includes("--apply");
let kept = 0;
let dropped = 0;
let droppedChars = 0;
const perDay: Array<{ file: string; keep: string[]; drop: number }> = [];

for (const file of readdirSync(dir).sort()) {
  if (!file.startsWith("papercuts-") || !file.endsWith(".jsonl")) continue;
  const path = `${dir}/${file}`;
  const keep: string[] = [];
  let drop = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let message = "";
    try {
      message = String(JSON.parse(line)?.message ?? "");
    } catch {
      keep.push(line); // unparseable: never discard what we cannot read
      continue;
    }
    if (MACHINE_OPENINGS.some((re) => re.test(message))) {
      drop += 1;
      droppedChars += message.length;
    } else {
      keep.push(line);
    }
  }
  kept += keep.length;
  dropped += drop;
  if (drop) perDay.push({ file, keep, drop });
}

for (const day of perDay) console.log(`${day.file}  -${day.drop}`);
console.log(
  `\n${dropped} machine verdicts (${droppedChars.toLocaleString()} chars) out of ` +
    `${(kept + dropped).toLocaleString()} entries; ${kept.toLocaleString()} human papercuts stay.`,
);

if (!apply) {
  console.log("\nDry run. Re-run with --apply to rewrite the day files.");
  process.exit(0);
}

for (const day of perDay) {
  const path = `${dir}/${day.file}`;
  copyFileSync(path, `${path}.bak`);
  writeFileSync(path, day.keep.length ? `${day.keep.join("\n")}\n` : "");
}
console.log(
  `\nRewrote ${perDay.length} day file(s); each original is beside it as .bak.`,
);
