# Memory repositories

Open Session keeps agent memory in git repositories that follow the
[Agent Memory Repo](https://github.com/AgentMemoryRepo/agentmemoryrepo) format:
Markdown files, one entry per bullet line, `[key: value]` metadata at the end of
the line, `[[path]]` links, and a `MEMORY.md` entry point in each repository.
Sessions read and write memory the way they read and write code: grep, edit,
commit, push. A daily Dreaming run per repository consolidates what sessions
saved.

The code lives in `packages/core/opensession-server/src/server/memory-repo/`.

## Repositories

There is one repository per group of people who can see the same memory:

| Repository     | Holds                                                                    |
| -------------- | ------------------------------------------------------------------------ |
| `team`         | Workspace memory at the root, and `repos/<id>/` for each code repository |
| `user-<id>`    | One person's memory                                                      |
| `channel-<id>` | One private Slack channel's memory                                       |

The existing memory scopes map onto these: `workspace` is the team root,
`repo-<id>` is `team:repos/<id>/`, `user-<id>` and `channel-<id>` are their own
repositories. Entries above `## Index` in a scope's `MEMORY.md` are what
memory-v2 called pinned.

In the memory state directory (`~/.opensession-memory` on a default install):

```text
<memory dir>/
  repos/<name>.git           canonical bare repository
  repo-work/<name>           the service's own checkout (Settings, Slack, sync)
  repo-locks/                cross-process write locks
  memory-repo-index.sqlite   derived index; delete it and it rebuilds
```

## Entries

```markdown
- `bun test` needs `OPENSESSION_STATE_DIR` set in this package [id: m-7f3a9c0d1e; kind: gotcha; source: https://os.example.test/session/abc; added: 2026-09-12]
```

Keys Open Session reads: `id`, `kind` (`preference`, `constraint`, `decision`,
`gotcha`, `reference`, `status`), `source`, `by`, `via`, `added`, `updated`,
`confirmed`, `expires` (required for `status`), `tags`, `supersedes`. Keys are
open; others are kept as written. An entry without `id` gets a stable hash id.
Longer detail goes in a file under a `notes/` folder that the entry links to;
a note's bullets are detail, not entries. Files without entries (topic pages,
saved SQL, scripts) are indexed as whole files.

## Sessions

Before each turn the gateway gives the session a checkout of every repository
it can see under `<session scratch>/memory/`: the team repository, the
prompting person's repository, and any other participant's personal repository
already cloned there. New checkouts are cloned; clean ones pull.

The system prompt carries only where memory is and the memory loop. It holds no
memory content, no list of checkouts and no word about who is prompting, so it
is the same on every turn of a session and a teammate's push, a second person
joining or someone else prompting cannot cost the session its cached prompt.
Each turn's memory context lists the `MEMORY.md` entry points that apply, most
specific first, with whose personal memory is whose, and the agent reads them
with a tool call.

Runs that cannot write a local checkout (Sandbox and Runner sessions, and every
automation, whose unattended shell may not push) get file tools on
`opensession-memory` instead: `list_memory_files`, `read_memory_file`,
`write_memory_file`, `delete_memory_file`. Each call is one commit. Every run
also gets `search_memory`, ranked search over the index.

A push goes through the receive hook (`hook-main.ts`), which refuses only what
would break the repository for everyone:

- pushes to anything but `main`, deletions and non-fast-forward updates;
- files over 256 KB (Markdown) or 1 MB (other), binary files, executables,
  symbolic links and submodules;
- text that looks like a credential;
- malformed metadata, unknown kinds and unparseable dates, with the line.

The post-receive hook records which session pushed each commit (the checkout
sends `session=<id>` as a push option), so history links commits to sessions
regardless of commit messages. Reads compare each repository's `main` ref with
the index and reindex only repositories that moved.

## Dreaming

Every team and personal repository with content gets an automation named
`Memory dreaming: <name>`, scheduled once a day between 02:00 and 05:00,
owned by the person for a personal repository (personal repositories of machine actors, which have no person, get none). A run sees exactly its
repository, the changes since its previous run, and the sessions active since
then (from the in-memory session list), and can read past transcripts with
`opensession-search`. It merges overlapping notes, removes transient and stale
entries, adds missed lessons with their `source:`, reorganizes files and keeps
each `MEMORY.md` short. It commits directly. Settings shows every change with
a diff and a Revert button.

## Settings

Settings, Memories lists the repositories. Each repository page shows the
remote, the recent changes (diff, linked session, Revert) and the files. The
existing review, pin, archive and merge actions keep working; each is a commit
authored as the signed-in person. Archive removes the entry from the
repository; the index keeps it as archived so Restore can put it back. The
`/api/memory` endpoints keep their shapes for the native app.

## Remotes

A repository can sync with one private remote. Any signed-in teammate who can
see the repository can set it on the repository's page; a public GitHub
repository is refused, and visibility is checked again before every sync. Sync
runs every fifteen minutes and on demand. It fast-forwards either side, merges
when both moved, and records a conflict for a person when the merge does not
apply. It never force-pushes. Pushing to a remote uses the server's own git
credentials.

## Modes and rollout

`OPENSESSION_MEMORY_MODE` selects where memory lives:

| Mode          | Record                                                                     |
| ------------- | -------------------------------------------------------------------------- |
| `repo`        | Default. Git repositories. memory-v2 SQLite is kept and no longer written  |
| `repo-mirror` | memory-v2 SQLite, mirrored one way into the repositories every ten minutes |
| `v2`          | memory-v2 SQLite                                                           |
| `legacy`      | JSON stores (rollback seam from the v2 migration)                          |

The first boot in `repo` mode imports every memory-v2 record once (active
records become entries, retired ones are kept in the index as archived),
checks parity (same active ids and tiers) and records the result in the audit
log as `memory_repo_migration`. Boot also reinstalls the receive hooks so they
run the current release's validator.

To roll back, bring entries written in repo mode back into memory-v2 and switch
the mode:

```bash
bun scripts/memory-repo.ts rollback   # upserts index records into memory-v2 by id
# then set OPENSESSION_MEMORY_MODE=v2 and restart
```

`bun scripts/memory-repo.ts parity` prints the parity report and
`bun scripts/memory-repo.ts reindex` rebuilds the index from git.

## Erasure

Deleting or archiving an entry is a normal commit; history keeps it. The
credential check prevents the common leak. If something that must not be kept
reaches a repository anyway, an operator removes it by hand:

1. Stop new writes: set the mode to `v2` and restart, or take the repository's
   remote off.
2. Rewrite history in a clone of `repos/<name>.git` (for example with
   `git filter-repo`), then replace the bare repository with the rewritten one
   (`git push --force` to it with `receive.denyNonFastForwards` temporarily
   off).
3. Force-push the remote, if one is configured, and ask anyone with a clone to
   clone again. Delete `repo-work/<name>` and session checkouts under
   `<session scratch>/*/memory/<name>`.
4. Delete `memory-repo-index.sqlite` so it rebuilds, and switch the mode back.

Agents never rewrite history, and the server has no button for it.
