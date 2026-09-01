# Packages

A package is how you hand somebody an extension instead of a paragraph of
instructions. It is **a git repository with `opensession-plugin.json` at its
root**, bundling any of four things this instance already knows how to store:

| In the manifest | Installs into                  |
| --------------- | ------------------------------ |
| `mcpServers`    | `mcp-config.json`              |
| `feeds`         | `~/.opensession/feeds.json`    |
| `automations`   | the config seed list, disabled |
| `skills`        | `.agents/skills/<name>/`       |

These are fresh-install defaults. If the corresponding new path does not exist,
an existing `~/.opensession-feeds.json`, `~/.opensession-plugins.json`, or
`~/.opensession-plugins/` remains active. `OPENSESSION_STATE_DIR` instead roots
those entries in another directory under their legacy-style names.
`OPENSESSION_SKILLS_DIR` changes the skill destination, while
`OPENSESSION_MCP_CONFIG` or `paths.mcpConfig` changes the MCP config path.

No registry, no npm, and no build or postinstall step. Packages do not load
JavaScript or browser code from their checkouts. An MCP entry can still define
a stdio `command` and `args`; Open Session executes that command when it
connects, so review it as runtime code. The reasoning is in
[adrs/publishable-packages.md](../adrs/publishable-packages.md).

```sh
opensession plugins                        # what is installed
opensession plugins add acme/my-package    # review, then install
opensession plugins add acme/my-package --users michiel,kent
opensession plugins update my-package
opensession plugins remove my-package
```

`add` clones the repository, validates the manifest and declared skill paths,
prints a summary of each planned artifact, and asks for confirmation. The
summary omits automation prompts, full feed descriptors, and skill contents,
so inspect the cloned manifest and declared skill directories before accepting.
Installing mounts an MCP server whose tools your sessions can call and adds
text your agents read. `--yes` skips confirmation.

## The manifest

```json
{
  "name": "video-library",
  "version": "1.0.0",
  "description": "Your team's videos as a project, with a weekly digest.",
  "homepage": "https://github.com/acme/opensession-video-library",
  "requires": [],
  "mcpServers": {
    "video-library": {
      "type": "http",
      "url": "https://mcp.video-library.example/mcp"
    }
  },
  "feeds": [
    {
      "id": "video-library",
      "title": "Video library",
      "refKind": "video-library",
      "mcpServers": ["video-library"],
      "items": {
        "server": "video-library",
        "tool": "list_videos",
        "path": "videos",
        "map": { "id": "id", "title": "name", "ts": "updatedAt" }
      }
    }
  ],
  "automations": [
    {
      "id": "weekly",
      "label": "Weekly video digest",
      "description": "Summarises what the team recorded last week.",
      "automation": {
        "name": "Video library weekly digest",
        "prompt": "List the videos recorded in the last seven days...",
        "schedule": "0 9 * * 1",
        "mode": "ask",
        "mcpServers": ["video-library"]
      }
    }
  ],
  "skills": ["skills/video-library-editing"]
}
```

A feed entry is a `ConfigFeed` exactly as the feeds store defines one
(`packages/core/opensession-server/src/server/feeds-config.ts`); an automation entry is a recipe as
`recipes/README.md` describes one. The manifest is an envelope around them
rather than a second schema.

## Rules the format enforces

The manifest validator and install plan enforce these rules:

- **Credential checks have limits.** Every value in a server's `env` and
  `headers` must be a bare `${NAME}` reference, and a server URL may carry
  neither a query string nor userinfo. Commands, arguments, and URL paths are
  not inspected for secrets, so publishers and installers must review them.
  The MCP runtime currently passes `${NAME}` references literally instead of
  expanding them, and HTTP status does not detect missing header references.
  Do not rely on package placeholders for working credential setup.
- **No self-scoping.** A manifest may not set `allowedUsers`. Who inside your
  company reaches a tool is your call, so it comes from `--users` at install
  time and is remembered across updates.
- **No self-starting.** Automations install disabled. A manifest cannot set
  `enabled: true` or a truthy `selfImprove`. A package proposes a job; you
  start it.
- **No unowned overwrites.** Name collisions are detected before artifact
  apply, which then does not start. New artifacts are removed if a later apply
  step fails, but updates are not fully transactional: a late failure can leave
  an already-owned artifact changed.
- **No escaping the package.** Skill paths are relative and cannot contain
  `..`.

## What installing records

`~/.opensession/plugins.json` holds, per package, the source, the commit it was
installed from, and the exact name of every artifact it created, with a sha256
of each skill's `SKILL.md`. Other files in a skill directory are copied but are
not included in that hash or the change summary. The ledger lets `remove`
reverse recorded names instead of guessing from a prefix, avoiding unrelated
automations with similar names. The fetched checkout stays under
`~/.opensession/plugins/<name>/`; `update` replaces it from the recorded source.

Two things `remove` deliberately does not do: it leaves an automation the
server has already created from the seed in place (delete it in the UI, as with
`opensession automations remove`), and it does not touch data a package's
server holds elsewhere.

## Publishing one

Push the repository and give it the GitHub topic **`opensession-plugin`**.
That is the whole distribution story:
[github.com/topics/opensession-plugin](https://github.com/topics/opensession-plugin)
is the catalog, there is no submission process, and nobody has to approve you.

A good package README says what the MCP server is, which credentials it needs,
how to configure them after installation, and what the automations would do on
a schedule. Someone is going to read that before typing `y`.

Installed packages show up in Settings → Library beside the rest of the
catalog, one card each.
