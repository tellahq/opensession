// Skill/command index for "/"-skill autocomplete in the composer.
//
// Mirrors what a run actually loads, and does it by reading the same list the
// runner passes to pi (skill-paths.ts): the skills Open Session ships plus the
// session checkout's own `.claude/skills` and `.agents/skills`. Skills are
// matched the way the engine globs them (`skills/**\/SKILL.md`), so nested
// ones count. Cached briefly per directory so keystrokes only re-filter in
// memory.
//
// Nothing else belongs here. A pi run loads no prompt templates and no
// engine-embedded skills (noPromptTemplates, noSkills), so listing
// `~/.claude/commands` or pi's own bundled set would offer people commands
// that silently do nothing when they press enter.

import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join, resolve } from "path";
import { SHIPPED_SKILLS_DIR, skillSearchPaths } from "./skill-paths";

export interface SkillEntry {
  /** Slash-command name, without the leading "/". */
  name: string;
  /** One-line description from frontmatter (or first content line). */
  description: string;
  /** Where it came from: opensession's own set, the session's checkout, or a builtin command. */
  source: "user" | "project" | "builtin";
}

/**
 * Open Session's own slash commands (handled by handleSlashCommand in opensession.ts
 * before anything reaches the runner). Listed here so they show up in the
 * composer's "/" autocomplete alongside file-based skills. Keep in sync with
 * the handler and its /help text.
 */
const BUILTIN_COMMANDS: SkillEntry[] = [
  {
    name: "pstack",
    description:
      "Enable rigorous pstack mode for this session (/pstack <task>, /pstack off)",
    source: "builtin",
  },
  {
    name: "poteto-mode",
    description:
      "Enable Poteto mode for this session (/poteto-mode <task>, /poteto-mode off)",
    source: "builtin",
  },
  {
    name: "compact",
    description:
      "Summarize the conversation so far to shrink context and cost (Claude sessions only)",
    source: "builtin",
  },
  {
    name: "goal",
    description:
      "Pin a goal appended to every prompt until cleared (/goal <text>, /goal clear)",
    source: "builtin",
  },
  {
    name: "loop",
    description:
      "Re-run a prompt on an interval while idle (/loop 30m <prompt>, /loop stop)",
    source: "builtin",
  },
  {
    name: "model",
    description: "Show or switch this session's model (/model, /model <name>)",
    source: "builtin",
  },
  {
    name: "account",
    description:
      "Show or pin the current model provider account (/account, /account <name>, /account auto)",
    source: "builtin",
  },
  {
    name: "help",
    description: "List opensession slash commands",
    source: "builtin",
  },
];

const CACHE_TTL_MS = 15_000;
const cache = new Map<string, { entries: SkillEntry[]; at: number }>();

/** Frontmatter `key: value` (quoted or bare), from the first --- block only. */
function frontmatterField(text: string, key: string): string {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return "";
  const m = fm[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!m) return "";
  return m[1].trim().replace(/^["']|["']$/g, "");
}

/** First non-frontmatter, non-heading content line — fallback description. */
function firstContentLine(text: string): string {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
  for (const line of body.split("\n")) {
    const t = line.replace(/^#+\s*/, "").trim();
    if (t) return t;
  }
  return "";
}

/**
 * Skills under `dir`, matching the engine's `skills/**\/SKILL.md` glob — so a
 * SKILL.md nested below its skills root (grouped in a subfolder) is found too,
 * not just `<dir>/<name>/SKILL.md`. Depth-bounded; skips dot-dirs.
 */
function readSkillsDir(
  dir: string,
  source: SkillEntry["source"],
  depth = 4,
  out: SkillEntry[] = [],
): SkillEntry[] {
  try {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.name.startsWith(".")) continue;
      const sub = join(dir, name.name);
      if (!name.isDirectory()) {
        try {
          if (!statSync(sub).isDirectory()) continue;
        } catch {
          continue;
        }
      }
      const md = join(sub, "SKILL.md");
      if (existsSync(md)) {
        try {
          const text = readFileSync(md, "utf8");
          out.push({
            name: frontmatterField(text, "name") || name.name,
            description:
              frontmatterField(text, "description") || firstContentLine(text),
            source,
          });
        } catch {}
        continue; // a skill's own files never hold another skill
      }
      if (depth > 1) readSkillsDir(sub, source, depth - 1, out);
    }
  } catch {}
  return out;
}

/** All skills a run in `worktreeDir` would see (deduped by name; the directory the run would load it from wins). */
function loadSkills(
  worktreeDir?: string,
  includeBuiltins = false,
): SkillEntry[] {
  const key = `${includeBuiltins ? "b|" : ""}${worktreeDir || ""}`;
  const hit = cache.get(key);
  if (hit && performance.now() - hit.at < CACHE_TTL_MS) return hit.entries;

  const shipped = resolve(SHIPPED_SKILLS_DIR);
  const byName = new Map<string, SkillEntry>();
  // skillSearchPaths is precedence order, most specific first, and pi keeps
  // the first skill it sees for a name. Later entries win the dedupe below,
  // so walk it backwards: the menu then describes the file that would run.
  const all = [
    ...skillSearchPaths(worktreeDir)
      .slice()
      .reverse()
      .flatMap((dir) =>
        readSkillsDir(dir, resolve(dir) === shipped ? "user" : "project"),
      ),
    // Last so they win dedupe: opensession intercepts these names before any
    // same-named file skill could run, so the menu should describe the builtin.
    // Only for existing-session composers (includeBuiltins) — an opening prompt
    // in the new-session palette never passes through handleSlashCommand.
    ...(includeBuiltins ? BUILTIN_COMMANDS : []),
  ];
  for (const e of all) byName.set(e.name, e); // later entries override earlier ones
  const entries = [...byName.values()];
  cache.set(key, { entries, at: performance.now() });
  return entries;
}

/** Filter + rank skills for a typed query (prefix beats substring beats description hit). */
export function searchSkills(
  worktreeDir: string | undefined,
  query: string,
  limit = 24,
  includeBuiltins = false,
): SkillEntry[] {
  const q = query.toLowerCase();
  const scored: Array<{ e: SkillEntry; score: number }> = [];
  for (const e of loadSkills(worktreeDir, includeBuiltins)) {
    const name = e.name.toLowerCase();
    let score: number;
    if (!q) score = 1;
    else if (name.startsWith(q)) score = 3000 - name.length;
    else if (name.includes(q)) score = 2000 - name.length;
    else if (e.description.toLowerCase().includes(q)) score = 1000;
    else continue;
    scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
  return scored.slice(0, limit).map((s) => s.e);
}
