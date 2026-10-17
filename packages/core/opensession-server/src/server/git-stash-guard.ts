/**
 * A `git` wrapper on the agent shell's PATH that refuses `git stash` commands
 * that change or apply the stash stack.
 *
 * Every worktree of a repository shares one git dir, and `refs/stash` is not
 * per-worktree: sibling sessions in sibling worktrees (or in one shared
 * checkout) push and pop the same stack. Two sessions that each run
 * `git stash && <check> && git stash pop` at about the same time can pop each
 * other's entries, which silently swaps their uncommitted work and leaves no
 * stash behind. Git has no setting to give a worktree its own stash ref, and
 * a prompt line alone did not stop agents, so the wrapper refuses the command
 * with the alternatives instead.
 *
 * A wrapper on PATH, rather than a command-text rule in command-policy.ts,
 * also catches `git stash` run from package scripts, Makefiles, and shell
 * scripts. It is a tripwire, not a boundary: an absolute path to the real git
 * bypasses it. Read-only `list` and `show`, and `create` (which writes an
 * object but no ref), pass through. People's own terminals never see this
 * PATH, so a person can still stash on purpose there.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "fs/promises";
import { join } from "path";
import { stateDir } from "./paths";

export const GIT_STASH_REFUSAL = [
  "git stash is disabled in Open Session sessions.",
  "Every worktree of a repository shares one stash stack, so a stash pushed or popped here can swap uncommitted work with another session.",
  "Instead:",
  "  - commit your work first (a WIP commit on your branch), or",
  '  - compare against a clean copy: git worktree add "$TMPDIR/base" HEAD (remove it with git worktree remove), or',
  '  - save a patch: git diff HEAD > "$TMPDIR/wip.patch", and restore it later with git apply "$TMPDIR/wip.patch".',
  "Read-only git stash list and git stash show still work.",
].join("\n");

function bashSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The wrapper script. `binDir` is the directory it is installed in, removed
 * from PATH only to find the real git; children of git keep the guarded PATH. */
export function gitStashGuardScript(binDir: string): string {
  return `#!/usr/bin/env bash
# Open Session git wrapper: refuses git stash commands that change the shared
# stash stack. See git-stash-guard.ts in the Open Session server.
guard_dir=${bashSingleQuote(binDir)}
search_path=
set -f
IFS=: read -r -a path_parts <<< "$PATH"
for part in "\${path_parts[@]}"; do
  [ "$part" = "$guard_dir" ] && continue
  search_path="\${search_path:+$search_path:}$part"
done
set +f
real_git=$(PATH="$search_path" command -v git)
if [ -z "$real_git" ]; then
  echo "git: command not found" >&2
  exit 127
fi

globals=()
sub=
index=1
while [ "$index" -le "$#" ]; do
  arg="\${!index}"
  case "$arg" in
    -C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--config-env)
      next=$((index + 1))
      globals+=("$arg" "\${!next}")
      index=$((index + 2))
      ;;
    -*)
      globals+=("$arg")
      index=$((index + 1))
      ;;
    *)
      sub="$arg"
      break
      ;;
  esac
done

is_stash=0
action_index=$((index + 1))
if [ "$sub" = stash ]; then
  is_stash=1
elif [ -n "$sub" ]; then
  alias_value=$("$real_git" "\${globals[@]}" config --get "alias.$sub" 2>/dev/null)
  read -r -a alias_words <<< "$alias_value"
  if [ "\${alias_words[0]:-}" = stash ]; then
    is_stash=1
    if [ -n "\${alias_words[1]:-}" ]; then
      action="\${alias_words[1]}"
      action_index=0
    fi
  fi
fi

if [ "$is_stash" = 1 ]; then
  if [ "$action_index" -gt 0 ]; then
    action="\${!action_index:-}"
  fi
  case "$action" in
    list|show|create) ;;
    *)
      cat >&2 <<'OPENSESSION_GIT_STASH_REFUSAL'
${GIT_STASH_REFUSAL}
OPENSESSION_GIT_STASH_REFUSAL
      exit 1
      ;;
  esac
fi

exec "$real_git" "$@"
`;
}

let installed: Promise<string> | undefined;

/**
 * Installs the wrapper as `<dir>/git` and returns `<dir>` for the front of an
 * agent shell's PATH. Idempotent: the file is rewritten only when its content
 * changed, through a rename so a concurrent shell never runs a partial file.
 */
export async function installGitStashGuard(
  dir = join(stateDir("git-stash-guard"), "bin"),
): Promise<string> {
  const target = join(dir, "git");
  const script = gitStashGuardScript(dir);
  const current = await readFile(target, "utf8").catch(() => undefined);
  if (current !== script) {
    await mkdir(dir, { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, script, { mode: 0o755 });
    await chmod(temporary, 0o755);
    await rename(temporary, target);
  }
  return dir;
}

/** The process-wide wrapper directory, installed once per process. */
export function ensureGitStashGuard(): Promise<string> {
  installed ??= installGitStashGuard().catch((error) => {
    installed = undefined;
    throw error;
  });
  return installed;
}

/** PATH with the wrapper directory first. */
export function guardedPath(binDir: string, path: string | undefined): string {
  return path ? `${binDir}:${path}` : binDir;
}
