/**
 * Where a run's skills come from, and how a "/name" prompt becomes one.
 *
 * Pi's own skill resolution is switched off in the runner (`noSkills`), the
 * same way extensions, prompt templates and themes are: a turn should load
 * what this server ships and what the session's checkout carries, never
 * whatever the host account happens to have enabled. This module is that
 * allowlist, and both the runner and the composer's "/" menu read it, so the
 * menu cannot drift from what a turn actually loads.
 *
 * Order is precedence: pi keeps the FIRST skill it sees for a name, so a
 * checkout that ships its own `simplify` beats Open Session's.
 */

import { existsSync, readFileSync, realpathSync } from "fs";
import { join, resolve } from "path";

/**
 * Skills Open Session ships for every session, whatever repo it is on. They
 * are tracked in this repository, so they version with the server instead of
 * with a directory somebody linked into their home once.
 *
 * `OPENSESSION_SKILLS_DIR` is the package installer's override
 * (scripts/lib/plugins.ts writes installed skills there), which keeps an
 * installed package's skill and a shipped one in the same place.
 */
export const SHIPPED_SKILLS_DIR =
  process.env.OPENSESSION_SKILLS_DIR ||
  join(resolve(import.meta.dir, "../../../../.."), ".agents", "skills");

/**
 * Every skills directory a run in `worktreeDir` loads, most specific first.
 * Missing directories are dropped: pi reports a diagnostic for a skill path
 * that does not exist, and most checkouts carry neither directory.
 */
export function skillSearchPaths(worktreeDir?: string): string[] {
  const candidates = [
    ...(worktreeDir
      ? [
          join(worktreeDir, ".claude", "skills"),
          join(worktreeDir, ".agents", "skills"),
        ]
      : []),
    SHIPPED_SKILLS_DIR,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    // A session on this repo has the shipped directory as its own project
    // directory; loading it twice would report every skill as a collision.
    let key = resolve(dir);
    try {
      key = realpathSync(key);
    } catch {}
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/**
 * The pstack family: the `pstack` and `poteto-mode` entry skills plus every
 * skill under `pstack-suite`. Matched by directory name rather than by the
 * shipped root, because a session on this repository loads the same files
 * through its checkout's `.claude/skills` symlink.
 */
const PSTACK_SKILL_DIR_RE =
  /(?:^|[\\/])(?:pstack|poteto-mode|pstack-suite)[\\/]/;

export function isPstackSkillPath(filePath: string): boolean {
  return PSTACK_SKILL_DIR_RE.test(filePath);
}

/**
 * Hide the pstack family from the model unless the session opted in.
 *
 * Only the `name` and `description` of a visible skill reach the system
 * prompt, and several pstack descriptions read as standing orders ("Must
 * always apply"), so every session used to pick them up on its own. Marking
 * them `disableModelInvocation` keeps them loaded, so `/pstack <task>` and an
 * explicit `/unslop` still expand, while the model no longer sees them until
 * pstack mode is on.
 */
export function gatePstackSkills<T extends { filePath: string }>(
  skills: T[],
  pstackMode: boolean | undefined,
): T[] {
  if (pstackMode) return skills;
  return skills.map((skill) =>
    isPstackSkillPath(skill.filePath)
      ? { ...skill, disableModelInvocation: true }
      : skill,
  );
}

/** The fields of pi's `Skill` this module needs. */
export interface LoadedSkill {
  name: string;
  filePath: string;
  baseDir: string;
  /** Local copy of a skill whose filePath is in a Sandbox. */
  mirrorPath?: string;
}

/**
 * Expand a prompt that invokes a skill into the block pi would have built.
 *
 * Two reasons this is done here rather than by pi's own expansion:
 *
 * - Pi only recognises `/skill:<name>`, and people type `/bro`. A bare
 *   `/<name>` is rewritten only when a loaded skill has exactly that name, so
 *   it can never swallow an ordinary message that starts with a slash.
 * - The runner passes `expandPromptTemplates: false` and compares the user
 *   message pi echoes back against the text it sent, to tell a steer delivery
 *   from the turn's own prompt. Expanding here keeps those two identical.
 *
 * Byte-for-byte the same block as pi's `_expandSkillCommand`, so a session
 * that later resumes through pi sees one consistent shape.
 */
export function expandSkillCommand(
  text: string,
  skills: LoadedSkill[],
): string {
  if (!text.startsWith("/")) return text;
  const match = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return text;
  const requested = match[1].startsWith("skill:")
    ? match[1].slice(6)
    : match[1];
  const args = (match[2] || "").trim();
  const skill = skills.find((s) => s.name === requested);
  if (!skill) return text;
  try {
    // A Sandbox skill is presented at its Sandbox path and read from its
    // local mirror (pi-runner, remote-workspace.ts).
    const body = readFileSync(skill.mirrorPath ?? skill.filePath, "utf8")
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
      .trim();
    const block =
      `<skill name="${skill.name}" location="${skill.filePath}">\n` +
      `References are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
    return args ? `${block}\n\n${args}` : block;
  } catch {
    return text;
  }
}
