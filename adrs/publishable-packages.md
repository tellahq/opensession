# A publishable package format, data only for now

## What is missing

Open Session has five extension points and no way to hand one to somebody
else. If I build a video-library feed today (an MCP server entry, a feed descriptor, a
weekly automation and a skill that teaches the agent our editing conventions),
the only way to give it to you is a paragraph of instructions: add this to
`mcp-config.json`, paste this into `~/.opensession/feeds.json`, drop this
directory under `.agents/skills/`, then seed this automation. Four stores, four
hand edits, no record of where any of it came from, and no way to take it back
out.

That is the whole gap. Every piece is already data, already validated, already
installable one at a time. What does not exist is a **unit**: something with a
name and a version that bundles the pieces, that a stranger can publish, that I
can install with one command and remove without archaeology.

`docs/plugins.md` describes a much larger thing and is still a design doc. This
proposal takes the small half of it, the half that needs no new architecture,
and ships it. It deliberately does not build the plugin runtime, and the last
section says why that is a decision rather than a delay.

## The shape

A package is **a git repository with a manifest at its root**. Nothing else.
No registry, no npm, no signing infrastructure, no build step.

```
opensession-video-library/
  opensession-plugin.json
  skills/
    video-library-editing/
      SKILL.md
  README.md
```

```json
{
  "name": "video-library",
  "version": "1.0.0",
  "description": "Your team's videos as a project, with a weekly digest.",
  "homepage": "https://github.com/acme/opensession-video-library",
  "mcpServers": {
    "video-library": {
      "type": "http",
      "url": "https://mcp.video-library.example/mcp",
      "headers": { "Authorization": "${VIDEO_LIBRARY_TOKEN}" }
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
      "id": "video-library-weekly",
      "label": "Weekly video digest",
      "description": "Summarises what the team recorded last week.",
      "automation": {
        "name": "Video library weekly digest",
        "prompt": "...",
        "schedule": "0 9 * * 1",
        "mode": "ask",
        "mcpServers": ["video-library"]
      }
    }
  ],
  "skills": ["skills/video-library-editing"]
}
```

Four kinds of content, all of them things the instance already knows how to
store:

| In the manifest | Installs into                                     | Existing writer                                               |
| --------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| `mcpServers`    | `mcp-config.json`                                 | `packages/core/opensession-server/src/server/connections.ts`  |
| `feeds`         | `~/.opensession/feeds.json`                       | `packages/core/opensession-server/src/server/feeds-config.ts` |
| `automations`   | `integrations.seeds.automations` in `config.json` | `scripts/lib/recipes.ts`                                      |
| `skills`        | `.agents/skills/<name>/`                          | a directory copy                                              |

These are the fresh default paths. If a corresponding new path does not yet
exist, an existing legacy `~/.opensession-feeds.json`,
`~/.opensession-plugins.json`, or `~/.opensession-plugins/` path is still used.
`OPENSESSION_STATE_DIR` instead keeps those literal legacy names under its
isolated root.

The manifest was designed as an envelope, in the sense `docs/plugins.md`
argues for: it carries what a card and an install button need (name,
description, version,
what it requires) and dispatches each piece to the mechanism that already
exists for it. Behaviour stays in the type-specific payload. A feed entry is a
`ConfigFeed` exactly as the feeds store already defines one, and it is
validated by that store's own validator at install time rather than by a second
schema that would drift from it.

The word "plugin" survives in the file name and the CLI verb because that is
what people type and search for. The noun everywhere else is **package**, and
the manifest itself is data. The installer adds no package hook or in-process
module. A stdio MCP entry can nevertheless execute its declared command on the
host when connected, as described under Trust.

## Lifecycle

```
opensession plugins add <owner/repo | git-url | path>   clone, validate, review, install
opensession plugins                                     what is installed
opensession plugins update <name>                       re-clone, re-plan, re-apply
opensession plugins remove <name>                       attempt recorded reversals
```

**Add** clones at depth 1 through staging, validates the manifest, and retains
the checkout under `~/.opensession/plugins/<name>`. It computes a plan against
what the instance already has, prints it for review, and applies artifact
changes after confirmation. Installed skills are copied from the checkout.

**Update** reclones the recorded source at depth 1 into staging, replaces the
retained checkout before planning and confirmation, then re-plans and applies
the difference. It does not fetch into the retained checkout. Artifacts the new
manifest no longer declares are removed. A changed skill is reported with
abbreviated old and new `SKILL.md` hashes rather than being swapped in silently.

**Remove** walks the recorded artifact list backwards and attempts each
reversal. This is the part that needs a ledger rather than inference:
`~/.opensession/plugins.json` records, per package, its source, commit, and the
exact names of its MCP servers, feeds, automation keys, and skill directories,
with skill hashes. The ledger makes targeting exact, not removal atomic:
reversal errors are suppressed and the CLI then drops the ledger entry. The
checkout cleanup currently recognizes only legacy `.opensession-plugins`
paths, so a fresh-default `~/.opensession/plugins/<name>` checkout remains.

Three traps that the ledger and the plan exist to avoid, the first two already
documented in `docs/plugins.md`:

- **Seed resurrection.** An automation from a package lives in the config seed
  list, and seeding is create-if-absent on every boot. Removing the package has
  to remove the seed, not just the store row, or it comes back on the next
  restart. The removal path reuses `removeRecipe`, which does exactly this, and
  leaves an already-created automation in place for the human to delete, which
  is the same conservative behaviour `opensession automations remove` has.
- **Install state is server-side.** The ledger is a file in the state dir, not
  localStorage, so what is installed is the same fact for the web UI, the
  native app and the next boot.
- **A package may rename itself.** The manifest name is the ledger key, so an
  entry has to be found by where it came from as well: matching only the new
  name turns an update into a first install, which either collides with the
  artifacts the package itself installed or writes a second entry and strands
  the first with no name anyone can remove it by. The lookup is name, then
  origin, and a rename migrates the entry and says so in the review.

Installation is per-instance. Scoping at the point of use is the pattern three
times over already (feeds scope `mcpServers`, automations carry allowlists,
servers carry `allowedUsers`), and per-project installation would fragment the
trust decision into one review per project.

## Credential blocks require named references

Every value in an MCP server's `env` and `headers` blocks has to be a bare
`${NAME}` reference:

```json
"headers": { "Authorization": "${VIDEO_LIBRARY_TOKEN}" }
```

Anything else in those blocks fails validation, as does a server URL carrying
a query string or userinfo. This does not make the repository or manifest
secret-free: commands, arguments, and other unchecked fields can contain
literal values.

Static `env` and `headers` values reach the Pi transport without `${NAME}`
expansion. HTTP connection checks omit configured headers and
do not report missing references. The stdio check tests the configured env key,
not the variable named by its value. Do not expect the example above to resolve
from the operator's env file or reliably report `needs-env`.

## Scoping is the installer's decision, not the package's

`allowedUsers` on an MCP server is the instance's own control over who gets a
tool. A manifest that could set it would be a package deciding who inside my
company can reach the server it just mounted, which is exactly backwards, so a
manifest carrying `allowedUsers` is rejected.

The operator supplies it instead:

```
opensession plugins add acme/opensession-video-library --users michiel,kent
```

That list is applied to every server the package installs and recorded in the
ledger, so an update preserves it rather than quietly widening access back to
everyone. Automation runs pass no user at all, so a scoped server is invisible
to them, which is the existing fail-closed behaviour and the reason this
control is worth wiring here rather than leaving to a later settings pass.

Automations from a package always install **disabled**, and a manifest may not
set `enabled: true` or `selfImprove`. The automation installer can propose a
scheduled job, but it does not start it or seed a self-editing prompt.

## Trust

Installing a package mounts an MCP server, and may inject text into agent
context. Both are consequential on an instance that holds Slack, GitHub and
Stripe credentials and runs autonomous agents over untrusted ticket text. The
honest inventory of what a malicious package can do includes:

- **Execute a local stdio MCP command.** A manifest may declare an unrestricted
  command and arguments. Connecting that server spawns the command as the Open
  Session host user with inherited `HOME`, `PATH`, `SHELL`, `USER`, and related
  variables. Treat this as full host-code execution: it can invoke a shell,
  read files available to that user, and execute code from the retained
  checkout. The installer itself still runs no package hook.
- **Mount a hostile remote MCP server.** The server's tools appear to sessions
  that are in scope for it. Tool descriptions are model-facing text, so a
  hostile server can attempt to steer a run, and a tool the model calls can
  exfiltrate whatever it was handed. This risk is not new: it is identical to
  adding any MCP server by hand, which is why the review step prints the
  server's transport and target verbatim.
- **Inject a prompt through a skill.** A `SKILL.md` is loaded into context when
  the agent judges it relevant. A malicious one is a prompt injection with a
  standing invitation. Updates track its hash, but the review does not print a
  content diff.
- **Seed an automation.** The prompt is model-facing text on a trigger. It
  installs disabled, so the worst case is that somebody enables it without
  reading it, which is the same failure mode bundled recipes already have.
- **Point a feed at somebody else's data.** A feed descriptor names a server
  and a tool. It cannot reach further than that server can.

The narrower guarantee is that the installer runs no package hook and loads no
package module into the server or browser process. A configured stdio command
is a child process with the host user's file access, so there is no general
guarantee that a package cannot read host files, execute downloaded code, or
reach local services.

The gates:

1. **Manifest validation before artifacts are written.** Names are slugs,
   values in credential blocks must be reference-shaped, skill paths cannot
   contain `.` or `..`, `allowedUsers` and `selfImprove` are refused, and
   automations are forced disabled. The checkout itself is cloned before the
   review.
2. **A printed plan.** It prints artifact names, MCP transports and targets,
   configured env keys and header reference names, automation labels and
   schedules, and skill destinations. Skill updates show eight-character old
   and new `SKILL.md` hash prefixes. It does not print automation prompts, skill
   bodies, first-install skill hashes, or diffs; inspect the manifest and
   checkout before confirming.
3. **Explicit confirmation.** `--yes` exists for scripted installs and is the
   line an agent has to cross deliberately. A run that types `--yes` on a
   package a human has not looked at has made a decision, and it is legible
   afterwards because the ledger records the source and commit.
4. **Collision detection and best-effort recovery.** A name already present but
   not recorded as package-owned is refused. Fresh-install rollback is best
   effort. Updates replace owned artifacts in place and do not restore their
   previous contents if a later action fails. Remove attempts every recorded
   reversal, but is also best effort.
5. **Clone hardening.** `--depth 1`, no submodules, `protocol.ext.allow=never`,
   and a neutered hooks path. Accepted sources are `owner/repo`, HTTP or HTTPS
   URLs, `git@` or `ssh://` URLs, `git://` URLs, `file://` URLs, absolute paths,
   and `./` paths. Other relative paths are rejected. `ext::` and leading-dash
   sources are refused.

What is deliberately not built: signing, a trusted publisher list, and any
notion of a package being "verified". Those are meaningful once there is a
registry with an operator behind it, and performative before that. The printed
plan is not a complete security review; inspect the manifest and checkout,
especially any stdio command, before confirming.

## Discovery

The convention is a GitHub topic: **`opensession-plugin`**. A repository with
that topic and a valid manifest is discoverable by anyone, with no gatekeeper
and no submission process, and `https://github.com/topics/opensession-plugin`
is the catalog until there is a reason for a better one.

This is the deliberate copy of the thing that made DeepSeek Harness's ecosystem
appear in two days: the ability to publish without asking. A curated in-repo
list would be safer and would also mean every third party has to open a pull
request against us before their work is findable, which is the difference
between an ecosystem and a queue.

Installed packages appear in the existing Library catalog (`packages/core/opensession-server/src/server/library.ts`)
as installed entries showing their name and description. The current card does
not link to the source or show homepage, version, or package requirements.
`opensession plugins` and the ledger provide version and source; homepage and
package-level requirements are not persisted there, so inspect the retained
manifest.

## Historical scope boundary: no in-process package runtime

This proposal intentionally added no ESM bundle, UI surface, server hook, or
`postinstall`. The current installer still evaluates no package hook and loads
no package module into the server or browser process. That is not a no-code
execution guarantee: a stdio MCP entry can spawn its declared host command when
connected, including code from the retained checkout.

The reasons for that narrower historical decision were:

**The trust decision cannot be delegated to a catalog.** A runtime-loaded
plugin sharing the host's React is same-origin code: it can read the session
token, call every API as the signed-in person, and reach every other plugin's
data. There is no gate that makes one-click installation of that safe, so it
would need a separate, louder, non-skippable trust prompt. Building the code
tier now would mean building two trust models at once and getting the easy one
wrong in the shadow of the hard one.

**The contract is not ready to freeze.** The first external plugin freezes
whatever interfaces exist the day it ships, including the bad ones. Today's
"panel registry" is two hardcoded ternaries checking for `component ===
"slack-channel"`. Publishing a UI contract on top of that would be publishing
an accident.

**A code plugin contributes nothing to four of the five clients.** The native
app, the TUI, the Chrome extension and the widgets do not run web bundles. A
data package works everywhere by construction, because a feed, an automation
and an MCP server are server-side facts. That asymmetry is worth paying
attention to before making the web the only surface a third party can extend.

**The demand is smaller than it looks.** Of the four things people actually
want to hand each other today (a feed, some automations, a skill, an MCP
wiring), none needs code. The generic schema-derived panel described in
`docs/plugins.md` covers the write path for the fifth. If runtime code arrives
later it arrives as an additional manifest key in this same envelope, gated on
its own explicit consent, and everything above keeps working unchanged.

## What ships with this proposal

The minimal path, and nothing beyond it:

- `packages/core/opensession-server/src/server/plugins.ts`: the manifest type, its validator, and the ledger.
- `scripts/lib/plugins.ts`: fetch, plan, apply, remove, and the review summary.
- `opensession plugins add|update|remove` plus the bare listing verb.
- One Library entry per installed package.
- Tests for validation and for install/remove idempotency.

Deliberately not included: a web install button (the CLI is the install
surface), a package's own settings UI, version constraints between packages,
and dependencies between packages. Each of those is easy to add later and none
of them is needed to hand somebody a video-library feed.
