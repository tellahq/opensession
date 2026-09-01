# Recipes

Optional, generic starting points that ship with Open Session. Nothing here is
installed or enabled by default.

```sh
opensession automations              # what is available, and what you have added
opensession automations add <id>     # add one
opensession automations remove <id>  # stop seeding one
opensession restart                  # create newly added recipes on the next boot
```

Adding a recipe appends it to `integrations.seeds.automations` and enables
`integrations.seeds` in `~/.opensession/config.json` (or the path in
`OPENSESSION_CONFIG`). The server creates it on the next start, **disabled**:
review the prompt, adjust it for your codebase, then enable it in Automations.
If the server runs in the foreground, stop and start it instead of using
`opensession restart`.

Seeding is create-if-absent and keyed on `eventKey`, so later starts never
overwrite the persisted automation. `remove` only removes the config seed; it
does not delete an automation already created from it. To remove both, run the
command first, then delete the automation in the UI.

## What ships here

| Recipe                   | What it does                                                                                            | Needs                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | --------------------- |
| `github-pr-review`       | Reviews eligible opened/updated PRs and posts findings                                                  | GitHub integration    |
| `instance-health`        | Hourly check that this install is alive and not out of disk                                             | —                     |
| `stale-pr-monitor`       | Weekly list of PRs that have gone quiet                                                                 | GitHub integration    |
| `code-cleanup-sweep`     | Weekly dead-code and duplication pass, as a PR                                                          | —                     |
| `docs-spell-check`       | Weekly typo and broken-link pass over docs, as a PR                                                     | —                     |
| `production-error-sweep` | Weekday triage of new production errors                                                                 | an error-tracking MCP |
| `nightly-reflection`     | Nightly retro over yesterday's audit log; may open one fix PR and refine its own prompt (`selfImprove`) | —                     |

`github-pr-review` and `instance-health` are offered during `opensession
onboard`. The PR review one is the highest-leverage thing here: it is the
automation most other workflows end up hanging off.

## What does _not_ belong here

The line is whether the recipe is about **software** or about **your company**.

Ships:

- reviewing a pull request, monitoring the instance, sweeping for dead code —
  every team that runs this wants some version of these
- prompts that name only things present in any repository: the diff, the test
  suite, open PRs, the error tracker

Does not ship, and should live in your own `config.json` instead:

- anything naming your product, your customers, your domain, or your metrics
- anything naming people, teams, personas, or internal rituals
- anything tied to one company's vocabulary, playbooks, or support flows
- anything requiring a bespoke internal MCP server

A useful test: **could a stranger run this on their own repository and get a
sensible result?** If it needs a paragraph of your company's context first, it
is instance config, not a recipe.

Recipes derived from an internal automation are genericised before landing —
the tuned methodology is worth sharing, the deployment specifics are not.

## Adding one

Drop a JSON file in `automations/`:

```json
{
  "id": "kebab-case-id",
  "label": "Human readable name",
  "description": "One line. Shown in `opensession automations`.",
  "requires": ["github"],
  "recommended": false,
  "notes": "Optional caveat shown when installing.",
  "automation": {
    "name": "Human readable name",
    "eventKey": "sweep:my-thing",
    "mode": "code",
    "schedule": "0 16 * * 1",
    "enabled": false,
    "mcpServers": [],
    "prReviewer": "your-org/your-team",
    "prompt": "..."
  }
}
```

- `eventKey` is both the internal-event subscription and the identity used for
  create-if-absent. Give every recipe one that is unique across automations.
- `mode`: `ask` is read-only on the selected repository's main checkout.
  `code` gets an isolated worktree with write access. Ordinary automations
  currently receive no GitHub credential, so they cannot push or open a GitHub
  PR. Default to `ask`. Trusted `github-*` code workflows use a separate,
  repository-scoped credential path.
- `repo` is an optional registered repository id. Omit it to use the instance's
  default repository.
- `mcpServers` is the external MCP allowlist. Use `[]` for none and name only
  what the prompt needs. Normal automation runs expose all configured servers
  when this is omitted; specialized event flows may supply narrower defaults.
- `prReviewer` adds an instruction to request review from a GitHub login, an
  `org/team` slug, or a comma-separated list, but grants no GitHub authority.
  Use it only when the run already has an authorized publication path. See
  [GitHub setup](../docs/setup/github.md#automation-pr-credentials-and-review-requests) for
  how requests reach humans and the collaborator rule for team slugs.
- `schedule` is a five-field UTC cron expression: minute, hour, day of month,
  month, and day of week. It supports `*`, steps, numbers, ranges, stepped
  ranges, and comma lists; day 0 or 7 is Sunday. Use an empty string for an
  event-triggered recipe.
- `enabled` should be `false`. An operator should read a prompt before it runs.
- `selfImprove` grants scoped task-spawning tools and permission to rewrite only
  that automation's prompt. Use it only for trusted scheduled input, never for
  untrusted events such as tickets.
- `requires` lists integration ids only for CLI warnings; it does not enable or
  validate those integrations.

### Writing the prompt

The recipes here are written to a house style, and it is worth matching:

- Say what to do, then what _not_ to do. The negative half is what keeps an
  automation from being annoying.
- Give it an explicit bar for what is worth reporting, and permission to report
  nothing. "If nothing is wrong, say so in one line" prevents the failure mode
  where an automation invents work to look useful.
- Prefer verification over recall: tell it to read the code before asserting
  something is broken.
- For `code` mode, state the constraint that keeps the PR mergeable — usually
  "behaviour must not change" plus "run the tests first".
- Treat anything the automation reads (a diff, a ticket, an error payload) as
  data, never as instructions to itself.
