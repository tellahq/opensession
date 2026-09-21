# GitHub

The GitHub integration has three parts: one GitHub App for bot and teammate
credentials, webhook intake on [Public ingress](install.md#public-ingress),
and the `gh` CLI used inside trusted runs. Installation and App user tokens are
the only GitHub credentials Open Session accepts.

## GitHub App

For a team install, create one organization-owned GitHub App. A single-user
simple-mode install may instead use a personal App. The same App provides:

- short-lived, repository-scoped installation tokens for reviews, clones,
  previews, trusted GitHub automations, and runs without a connected person;
- device-flow user tokens so the UI buttons and a connected person's code
  turns act as that person. Agents use `gh` and HTTPS git directly;
- the bot identity `<app-slug>[bot]` for self-trigger protection and
  attribution: agent commits are authored by it, with the person as
  `Co-authored-by`.

Configure it from Settings → Integrations, or under
`integrations.github` in `~/.opensession/config.json`:

```jsonc
{
  "integrations": {
    "github": {
      "enabled": true,
      "oauthClientId": "Iv…",
      "oauthClientSecret": "…",
      "appSlug": "open-session-example",
      "installationOwner": "your-org",
      "userPrAuth": true,
    },
  },
}
```

The private key is not stored in JSON. Upload the PEM in Settings →
Integrations; Open Session writes it atomically with mode 0600 to `~/.opensession/github-app.pem`. Operators
may instead set `OPENSESSION_GITHUB_APP_KEY` to an externally managed PEM path.
The UI will not overwrite or delete an operator-managed key.

Environment overrides for the App identity are
`OPENSESSION_GITHUB_CLIENT_ID`, `OPENSESSION_GITHUB_CLIENT_SECRET`,
`OPENSESSION_GITHUB_APP_SLUG`, and `OPENSESSION_GITHUB_APP_KEY` (a path, not PEM
contents). Environment values win over config. Install the same App on every
account whose repositories this instance should use. Open Session resolves each
repository through the installation for its owner and caches tokens per
installation. `installationOwner` is an optional default for calls that do not
name a repository; `installationId` may pin that default by numeric id.

### Required permissions

The create-App link in Settings → Integrations is generated from the same
canonical permission set used when tokens are minted:

| Scope                  | Access         | Why                                     |
| ---------------------- | -------------- | --------------------------------------- |
| Actions                | Read           | failing workflow logs for trusted fixes |
| Checks                 | Read           | check runs                              |
| Commit statuses        | Read           | status rollups                          |
| Contents               | Read and write | clone and push                          |
| Deployments            | Read           | preview deployment state                |
| Issues                 | Read and write | issue and PR comments                   |
| Metadata               | Read           | GitHub baseline                         |
| Pull requests          | Read and write | reviews, PRs, merges                    |
| Members (organization) | Read           | roster and attribution                  |

**Repository creation does not need Administration.** From Settings →
Repositories → Add repository → New, or the New session palette's "New
repository", Open Session opens `https://github.com/new` with the owner, name,
private visibility and README option prefilled. Review those choices and
confirm on GitHub, then return and choose **Connect repository**. If you
changed the owner or name on GitHub, update them in Open Session too. The
server uses ordinary remote registration to clone it and save its GitHub
identity. Personal accounts and organizations are both supported. If the
App is installed on selected repositories only, grant it access to the new
repository before connecting.

The App grant and all installation-token permission sets exclude
Administration. Connected-user tokens inherit the App grant intersected with
the person's access and are handed to interactive code runs, so adding
Administration to the App would also broaden agent authority.

**Existing Apps:** if Administration was enabled for the earlier automatic
creation flow, remove it in the App's GitHub permission settings. Updating
Open Session does not change the permissions of an existing App on GitHub.

Enable **Device Flow**, generate a client secret and private key, then install
the App only on the accounts and repositories Open Session should reach. One
instance can use every installation of that App at the same time. When
permissions change, approve the updated installation permissions too.

GitHub service authority is fail-closed. A missing key, missing installation
for a repository owner, unapproved permission, or failed token mint never falls
back to ambient `gh`, a host SSH key, or a connected human. Installation tokens
remain process-local and short-lived. Each server call mints against one owner,
and repository code runs receive a token narrowed to that one verified
repository.

### Bot identity and mention handles

Set `appSlug` even though token minting itself only needs the client id and key.
App-authored activity appears as `<app-slug>[bot]`; Open Session adds that login
to its own-author set so comments and pushes cannot trigger loops. The App slug
itself is the preferred PR mention handle. Keep old names in
`integrations.github.mentionHandles` only as compatibility aliases.

`policy.githubBotLogins` may retain aliases for historical App names.
`GITHUB_MENTION_HANDLES` adds compatibility mention handles. Server-owned `gh`
calls receive a short-lived App token in their process environment. HTTPS Git
operations use a process-local credential helper, and SSH GitHub remotes are
rewritten to HTTPS for that process so host keys cannot bypass the App.

## Who holds which credential

A code turn a connected person started acts as that person: their token is
the run's `GH_TOKEN` / `GITHUB_TOKEN` and, through a process-local
credential helper, its HTTPS git credential, so the branch push and any PR
the shell opens carry their identity. "Started by a person" means the
turn's sender is a human (or the auto-continue of their own prompt), the run
kind is interactive, and the mode is code. When that person is unknown,
unmapped, or disconnected, the run falls back to the App token below rather
than running credential-free. In a sandbox the launcher resolves the same
choice on the host and projects only the chosen token into a private,
run-scoped file, together with the login of the credential it selected as a
non-secret marker (the mapped person in operator mode, the sole connected
account in simple mode) so the guest lifts the merge guard exactly when a
host run would. An App-token projection carries no login and stays guarded.

Every other run holds a short-lived installation token scoped to its
repository and never a person's: the code permission set for unattended
code runs and for machine senders into an interactive session (a review
handoff, a worker report, an automation), the read set for every ask run,
whoever started it, because the review workflows process untrusted PR
content and can print their environment. Ask runs also ignore any
launcher-supplied token. The gateway still uses a person's token for the UI
buttons (merge, close, review, comment). Agents use `gh` directly, without
dedicated PR MCP tools. A run never inherits the host operator's `gh` login:
its `GH_CONFIG_DIR` is run-scoped, so a missing token fails with "not logged in".
See [github-authority.md](../github-authority.md) for the credential and
publication boundaries.

An automation that must read sibling repositories (`readRepos` in its
config: `owner/repo` names under the same owner as its own repo) additionally
holds `GH_READ_TOKEN`: a second installation token minted for its own
repository plus every listed one, with the read permission set only. It is a
separate token on purpose. One mint carries one permission set for every
repository it lists, so folding the read repos into the primary mint would
give the run `contents:write` and `pull_requests:write` on repositories it
should only read. `GH_TOKEN` stays the one-repository code set, and `gh`
honors only `GH_TOKEN`, so a script opts in per command:
`GH_TOKEN=$GH_READ_TOKEN gh pr list --repo owner/name`. The run's
instructions name the token and the repositories it covers.

The App must be installed on every repository in `readRepos` (organization
settings, the Open Session App, repository access). GitHub refuses the whole
mint when the installation cannot see one of them; the server then logs a
warning naming the repositories and the run gets no `GH_READ_TOKEN` at all.
It never falls back to a token minted without a repository list. In a
sandbox the launcher mints the read token on the host and projects it in the
same private run-scoped file as the primary one. Like the primary token it is
process-local: never written into git config, remote URLs, session files, or
the run journal, which stores only the repository names.

A push from a person-started code turn therefore reaches GitHub as that
person; pushes from every other run reach it as the bot account, and the PR
webhook sees the bot as the `synchronize` sender. The review automation
treats those pushes like human pushes; it only skips a bot-sender push while
one of its own code loops (auto-fix, simplify, adversarial, or an @mention
reply) is in flight on that PR.

Keep the App's **Contents** permission at **read and write**: that is what
lets runs push their branches. What the bot may do to the default branch is
decided by rulesets, not by the token. On every protected repository add a
ruleset on the default branch with the single rule **restrict updates**, and
list only the people who may merge as its bypass actors. A merge is an update
of the branch, so with that rule in place no installation token, and no
leaked one, can merge or push `main`, whatever permissions it holds. A
ruleset that requires pull requests and status checks should already exist;
leave it as it is.

Interactive code runs follow the repository's publication instructions,
including direct pushes where a shared-main workflow permits them. GitHub
permissions and rulesets remain the credential boundary. Ask-mode read-only
checks, unattended command policy, and automation-descendant publication
restrictions still apply; this does not grant automations human authority.

A public repository adds one more layer. Runs there receive the
`## Public repository` instruction, and publishing commands are refused when
they contain a term from `policy.privateTerms`. Pin visibility with
`repos.<id>.public` when the instance credential cannot read it; unconfirmed
visibility counts as public. See
[../security-model.md](../security-model.md#private-information-and-public-repositories).

Threat model: agent bash shares the server's uid, so every credential present
on an Open Session host should be scoped as if the agent will read and use it
directly. Do not give runs ambient PATs, SSH keys, or host `gh` logins. The
selected App or user token is the run's GitHub authority, and GitHub permissions
and rulesets bound it. `OPENSESSION_GITHUB_PUSH_TOKEN`, the earlier git-only
credential, is no longer read; revoke it and remove the variable.

## Webhook intake

The fail-closed public ingress gateway listens on `127.0.0.1:3860`. Choose
Cloudflare Tunnel or Direct HTTPS with Caddy under **Settings → Domains and
ingress → Public callbacks**. Never route the private app port through that
public origin.

- Route: `POST /github/webhook` (registered by the GitHub agent,
  `packages/core/opensession-server/src/agents/github/index.ts`). For an existing Slack-only deployment with
  GitHub disabled, Slack registers the same GitHub-owned handler as a
  compatibility fallback. When both are enabled, only GitHub registers it.
- Verification: `GITHUB_WEBHOOK_SECRET`, HMAC-SHA256 over the raw body,
  header `x-hub-signature-256` (`sha256=<hex>`), timing-safe compare; invalid
  signature → 401. The body limit is 1 MiB. Deliveries are deduped by
  `x-github-delivery` for 24 hours, with at most 500 ids retained.

Use the App-level webhook, not one repository webhook per repo. In the GitHub
App's **General → Webhook** settings, set the public URL to
`https://<public-origin>/github/webhook`, make it active, and paste the same
strong secret stored as `GITHUB_WEBHOOK_SECRET` in Settings → Integrations or
`~/.opensession.env` (for example, generate one with `openssl rand -hex 32`).
Then under **Permissions & events → Subscribe to events**, select **Issues**,
**Issue comments**, **Pull request review comments**, **Pull request reviews**,
**Pull requests**, and **Workflow runs**. The generated Create GitHub App link
pre-fills the URL and active state, but it cannot fill the secret or event
subscriptions. Restart Open Session after setting or changing the secret; the
GitHub-side subscription checkboxes take effect without an Open Session restart.

These are the subscribed events the code consumes
(`packages/core/opensession-server/src/agents/github/webhook.ts`):

| Event                                                               | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issue_comment`, `pull_request_review_comment` (action `created`)   | if the body matches a configured mention handle: on a PR, intent-classified → whole-PR action (review / autofix / simplify / adversarial) or a conversational reply run in a PR-branch worktree; on a plain issue, resumes that issue's session (below)                                                                                                                                                                                                                                                                                  |
| `issues` action `labeled`                                           | the `os` label starts one code session per issue on branch `issue-<n>` off the default branch; create the label on your repo first. The session comments a link to itself on the issue, answers or implements, opens its own PR (`Closes #<n>`), and reports back. Later @mentions on the issue resume the same session. The sidebar's **Issues** tool (off by default; switch it on in Settings → Preferences) lists the same open issues and its **Start session** button does what the label does, attributed to the signed-in person |
| `pull_request` action `labeled`                                     | labels `os-review` / `os-auto-fix` / `os-simplify` / `os-adversarial` trigger the corresponding behavior; create the labels on your repo first. Auto-fix also merges the current base into conflicting PR branches and resolves the conflicts without force-pushing.                                                                                                                                                                                                                                                                     |
| `pull_request` `opened`/`reopened`/`synchronize`/`ready_for_review` | auto-review, if the PR is non-draft and either carries `os-review` or the review automation is enabled                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pull_request` action `closed` + merged                             | notifies linked sessions; fires the docs-sync automation on `github:pr_merged`                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pull_request_review`                                               | refreshes PR state; when the Slack agent is enabled, review → Slack notification                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `workflow_run`                                                      | notifies sessions waiting on a merged PR's deploy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

An automatic review that ends unsatisfied (blocking findings, or open findings
below quality 4/5) hands its findings straight into the live session that owns
the PR branch as a fix round, at most `OPENSESSION_REVIEW_HANDOFF_ROUNDS`
(default 6) per PR; the session's push re-triggers the review. When a later
review passes, or the round cap hands the rest to humans, that same session
gets one closing message asking for a short wrap-up: where the PR stands, what
changed across the rounds, and where to look. The transcript folds the whole
loop into one "Review loop" row with the wrap-up beneath it.
`OPENSESSION_REVIEW_HANDOFF=0` disables the handoff.

### Public-repository actor gate

The webhook secret authenticates GitHub, not the person who caused an event.
Before an event can command the agent, the actor's exact login must appear in
`identity.team[].github`; the configured `policy.githubBotLogins` are trusted
separately for machine-originated events. This gate covers PR comments and
inline comments, labels, same-repository automatic reviews, merge automations,
workflow notifications, Slack review notifications, and restart recovery.
GitHub's `author_association` field is not a trust source.

An external fork is the narrow exception. When review automation is enabled,
its open and update events may start an automatic isolated review. Open Session
verifies the immutable PR refs in a fresh disposable Daytona Executor, confirms
provider deletion, and gives a tool-less model only the bounded patch. No contributor
code runs on the host, and no model or GitHub credential enters the guest.
External PRs cannot trigger mentions, autofix, simplify, adversarial review,
conversational work, pushes or handoffs. Public review comments do not contain
the private Open Session URL. See [Security model](../security-model.md#isolated-public-pr-reviews).

GitHub Actions policy is independent. A repository may keep outside-contributor
workflows disabled or approval-gated while still receiving Open Session's
isolated semantic review. The shipped PR workflows also gate every job to
same-repository branches, so fork jobs remain skipped if the platform setting
is loosened accidentally. Keep the team GitHub roster current; an empty roster
still fails closed for every write-capable behavior.

### Enabling public contributions

Keep public PR creation restricted until every item below is complete:

1. Configure and qualify the Daytona provider. Confirm it reports **Ready** in
   Workspace → Sandboxes. Public review fails closed when it is
   unavailable, but opening submissions before readiness leaves contributors
   without the promised automatic review.
2. Enable the `github-pr-review` automation. This is the budget switch for
   automatic review events; it does not grant external contributors any
   write-capable command.
3. In GitHub repository settings, have a human repository administrator change
   the pull-request creation policy from **Collaborators only** to **All**. The
   ordinary App installation tokens exclude Administration. This one-time
   setting stays a human's job on github.com.
4. In **Settings → Actions → General**, keep workflows from fork PRs disabled or
   require maintainer approval before they run. This is separate from Open
   Session review and complements the same-repository job gates in the shipped
   workflows. With the least-privilege App permission set above, GitHub's
   Actions-policy API returns 403 by design, so a repository administrator must
   verify this setting in GitHub.
5. Open a disposable fork PR and confirm the review uses the isolated public
   path, contains no private session URL, and leaves autofix, commands, pushes,
   handoffs and GitHub Actions unavailable.

Changing the PR creation policy is the only step above that requires a human
with repository Administration authority. Runtime checkout, review and result
posting continue to use the narrower token sets documented in this guide.

**Multi-repo**: the App webhook covers every repository on which the App is
installed. A repo joins the PR agent when it is also in the config registry
(`repos` in `~/.opensession/config.json`, matched by `ghRepo`). Events for
unconfigured repos are dropped. Per-PR state, locks, worktrees, and session ids
are repo-qualified for non-default repos (the default repo keeps its historical
bare-number keys). Merge side effects (docs-sync and linked-session deploy
notifications) run for the **default repo only**.

## Webhook reachability

PR comments, labels, and other event-driven behavior need GitHub to reach the
public webhook URL. Configure Public ingress before creating the App so the
pre-filled webhook URL is public; if the App already exists, update its webhook
URL manually. A private-only instance can reconcile some recent, trusted
opted-in PR reviews by polling, but it cannot discover conversational comments
or new label commands without webhook delivery.

## Behavior toggles

- Auto-review on every PR push is **off by default**: the github agent seeds
  a "review" automation disabled (label-only mode). Enable it in the
  Automations UI. Not an env var.
- The docs-sync automation is seeded enabled and fires on merge **only when
  you set a prompt** in `integrations.github.docsSyncPrompt`. It is an ordinary
  code automation, so under the current credential policy it can edit its
  worktree but receives no GitHub token and cannot push or open a PR.
  `integrations.github.docsSyncChannel` only lets the merge handler find and
  check off a recent Slack message that already links a docs-sync PR; it does
  not post that announcement itself.
- `integrations.github.shippedChangesChannel` sets the default Slack channel in
  the post-merge **Share to Slack** composer. It is not an enable switch. A
  teammate with a personal Slack connection deliberately posts either prose or
  selected screenshots. The channel picker lists
  `integrations.slack.channelNames` first as suggestions, then every channel
  the sender is a member of (read with their own Slack grant), and it can be
  searched.
- Mention replies are always on while the agent is loaded.
- The agent itself is off unless enabled: `integrations.github.enabled: true`
  in config, or the `ENABLE_GITHUB_AGENT` env flag (which wins when set; see
  [integrations-misc.md](integrations-misc.md#boot-guards)). Agent enablement,
  the webhook secret, and mention handles are read at load time, so restart
  after changing them.

Prompts and `pr-info.ts` defaults are config-driven (they interpolate the
default repo's `ghRepo`, or the PR's own repo when threaded) — no code edits
needed to point the PR agent at your repos.

## Review options and rules

A repository tunes its own reviews with `.os-review.json` at its root, so the
knobs are versioned with the code they score. Every field is optional:

```jsonc
{
  "ignoreGlobs": ["**/*.lock", "generated/**"], // never post findings here
  "minInlineSeverity": "P3", // post inline comments at or above this
  "summaryOnlyOverFiles": 80, // giant PRs get a summary, no inline noise
  "skipKeywords": ["[skip-review]"], // in the PR title: no automatic review
  "testOnBase": true, // new tests must fail on the merge base
  "secretScan": true, // TruffleHog scan of the PR's added lines
  "mergeRisk": true, // separate diff-only merge-risk score
  "rules": [
    {
      "name": "marketing-only",
      "when": { "allFilesMatch": ["apps/marketing/**", "**/*.mdx"] },
      "then": {
        "result": { "verdict": "approve", "score": 5 },
        "note": "Marketing-only change",
      },
    },
    {
      "name": "migration-needs-human",
      "when": { "anyFileMatches": ["**/migrations/**"] },
      "then": { "maxConfidence": 3, "minRisk": "medium" },
    },
    {
      "name": "lockfile-only",
      "when": { "allFilesMatch": ["**/bun.lock"] },
      "then": { "skipReview": true },
    },
  ],
  "groups": [
    {
      "name": "Design",
      "rules": [
        {
          "name": "CSS only",
          "when": { "allFilesMatch": ["**/*.css"] },
          "then": { "result": { "verdict": "approve" } },
        },
        {
          "name": "Tone",
          "when": { "anyFileMatches": ["apps/marketing/**"] },
          "prompt": "Does copy added in this PR sound like us: short, direct, no jargon?",
        },
      ],
    },
  ],
}
```

`rules` is the deterministic layer alongside the model's verdict. Each rule
has a unique `name`, a `when` clause whose conditions are all required, and a
`then` clause with the outcomes. Up to 50 rules are supported.

`groups` collect rules that report together: each group has a `name` and its
own `rules` list (names unique within the group), and its matching rules
render under one heading in the summary comment, one line per rule, for
example `Design` with `CSS only: approved` and `Tone: approved · 4/5 · ...`.
Grouped rules support the same `when`, `then`, and `prompt` fields as
top-level ones and apply after them, in file order. Up to 20 groups.

A rule with a `prompt` instead of `then` is a **prompt rule**: the question is
put to a separate tool-less model call over the PR's diff, with a clean
context, and the answer is published as an independent result for that rule:
a verdict, a 1-5 score, and a one-line reason. `when` is optional on a prompt
rule (omit it to evaluate every PR) and it may not carry `then`. Prompt rules
never change the AI's scores, findings, or gates, and cannot skip a review; a
model or parse failure shows as `not evaluated` for that rule and never blocks
the review. Each costs one model call per review, so a config keeps at most
10 prompt rules (extras are dropped with a warning). Every prompt rule's
outcome is recorded in the audit log (`review_rule_prompt`).

Use `then.result` for an **independent custom result**: an optional `verdict`
(`approve`, `comment`, `request_changes`) and/or a `score` (1-5). Matching rules
appear by name in a separate "Custom rule results" section, for example
`marketing-only: approved · 5/5`. Multiple results coexist; they do not
replace one another or change the AI's quality, risk, verdict, findings, or
merge/fix-round gates. A custom approval is a policy result, not a GitHub
approval or permission to merge. Nonmatching rules show no result.

The existing top-level `then.confidence`, `then.verdict`, and `then.risk`
outcomes still explicitly override the shared model scores. Omit them when
only an independent result is wanted.

Available conditions and outcomes:

- `when`: `allFilesMatch`, `anyFileMatches`, `noFileMatches` (globs over the
  changed paths), `minChangedLines` / `maxChangedLines`, `minFiles` /
  `maxFiles`, `labels` (any of, case-insensitive), `baseBranch` (globs),
  and the model's result: `verdict` (`approve`, `comment`,
  `request_changes`), `minConfidence` / `maxConfidence` (1-5), `risk`
  (`low`, `medium`, `high`). A rule needs at least one condition.
- `then`: `result` publishes an independent verdict and/or score;
  `confidence` sets the 1-5 quality score, `confidenceDelta` adjusts
  it, `minConfidence` floors it, `maxConfidence` caps it; `verdict` replaces
  the verdict; `risk` sets the merge-risk level, `minRisk` raises it,
  `maxRisk` lowers it; `note` is shown on the PR; `skipReview: true` stops
  the automatic review before it starts.

Rules apply in file order after the model's verdict is parsed, and the
summary comment shows the model's original score next to the rule-adjusted
one (`quality 5/5 (model 3/5)`) with a "Rules applied" section naming each
rule. Rules never remove findings, so a P0 the model found still counts as
blocking for the fix-round gates, and the secret scan's cap wins over any
rule. Skip rules read the repo's main checkout and only gate the automatic
path; label-forced and manual reviews still run. Rules that read the model's
result cannot skip. Public-fork PRs use the base checkout's file, so a
contributor cannot score their own PR. Every applied or skipping rule is
recorded in the audit log (`review_rules_applied`, `review_skipped_by_rule`).

## Automation PR credentials and review requests

Ordinary `code` automations can edit an isolated worktree, but currently receive
neither `GH_TOKEN` nor `GITHUB_TOKEN`. Only interactive trusted runs and the
dedicated `github-*` code workflows receive a user or repository-scoped App
credential. An ordinary automation therefore cannot push or open a GitHub PR.
Its optional `prReviewer` value is validated, preserved across resume, and
added to unattended run instructions, but it grants no GitHub authority. The
reviewer is not added to existing PRs or PRs created from human-steered turns.
Do not rely on this setting to publish or surface automation work. The
optional `readRepos` list is validated the same way (same owner, valid names,
deduped) and preserved across resume; it widens only what the run can read,
through the separate `GH_READ_TOKEN` described under
[Who holds which credential](#who-holds-which-credential).

For a PR created by an authorized path, request a GitHub login or `org/team`
reviewer directly. The reviewer must be a repository collaborator; a requested
team needs access to that repository. GitHub excludes the PR author. Team
requests expand to member logins, then through `identity.team` to Open Session
people.

`pr-review-notifications.ts` refreshes the PR cache every 60 seconds. After its
first poll establishes a baseline, it sends web push for newly observed review
requests. Recipients need a web-push subscription, which requires the UI over
HTTPS. A failed or missed push is not retried; removing and later re-requesting
a reviewer creates a new edge. A team request fans out to its members unless
GitHub's own team code-review assignment resolves it to selected people.

## Per-user GitHub auth (PRs as the session owner)

Opt-in: interactive sessions open PRs as the actual human who owns the
session instead of the bot, and the web UI's name picker becomes a real
GitHub sign-in. It is off by default. Without it, team-mode server actions use
the App installation identity; single-user mode can use the sole-account flow
below without enabling the sign-in gate.

1. Use the same organization-owned **GitHub App** configured above: tick
   **"Enable Device Flow"** and generate a client secret. If the organization
   restricts GitHub Apps, approve its installation and updated permissions.

   Device Flow is not an option here. It is the only sign-in there is, so an
   app without it refuses every attempt (`device_flow_disabled`) and nobody
   can get in. The callback URL, by contrast, is unused, because sign-in never
   redirects; put your instance's URL in if GitHub insists on the field.

2. Configure `~/.opensession/config.json`:

   ```json
   {
     "integrations": {
       "github": {
         "userPrAuth": true,
         "oauthClientId": "<client id>",
         "oauthClientSecret": "<client secret>",
         "appSlug": "<app slug>",
         "installationOwner": "<organization>"
       }
     }
   }
   ```

   Before setting `userPrAuth` directly, put at least your own exact GitHub
   login in `identity.team[].github` (and make it an admin when the roster uses
   explicit admin roles), or every sign-in will be rejected. The Settings UI
   prevents this lockout when it enables the gate. The private key is stored
   separately as described above. Environment `OPENSESSION_GITHUB_*` values
   win over config. Signing in needs the client id; the secret renews user
   tokens; the key mints bot installation tokens.

3. App and authentication config is read live; no restart is required. Restart
   only after load-time agent settings change, or once if you want the boot-only
   `createdByLogin` migration to backfill existing sessions immediately.

What turns on (`packages/core/opensession-server/src/server/github-auth.ts`, `web-auth.ts`, `routes/auth.ts`):

- **Sign-in required**: the UI shows "Continue with GitHub", which starts the
  device flow, the one sign-in every client uses; only logins on
  `identity.team[].github` may sign in. Ordinary `/api/*` calls and the UI
  WebSocket are 401-gated on the HttpOnly session cookie; non-browser callers
  use `Authorization: Bearer <token>` with a token from
  `~/.opensession/web-sessions.json`. Auth routes, `/api/health`, `/live`,
  `/ready`, client update feeds, and machine routes protected by their own
  credentials are exceptions. The verified identity overrides client-claimed
  user names (WS and HTTP), stamps `createdByLogin` on new sessions, and a
  one-time boot migration backfills it onto existing ones.
- **Organization members imported**: after a repository identifies the GitHub
  organization, opening the onboarding People step imports up to 10,000
  organization members into `identity.team`. Existing profile details are
  preserved, and the import is recorded so removing someone later is not
  undone on the next page load.
- **PRs as the owner**: signing in also stores the person's GitHub App
  user-to-server token (`~/.opensession/github-auth.json`, 0600). The App's
  Members permission lets initial setup list organization members. The runner
  injects it as `GH_TOKEN`/`GITHUB_TOKEN` into interactive,
  non-least-privilege runs only — automations, unattended kinds, and any
  run carrying a deny-set stay credential-free. Trusted GitHub code workflows
  receive the repository-scoped App credential instead. Teammates manage their
  own connection under Settings → Account.

## Connecting GitHub in simple mode

A **simple-mode install** is one person on their own box: no operator config, no
separate bot account, no `gh auth login`, and no sign-in gate. Such a user still
needs their **private** repos available, to list them in the repo picker, clone
them, and open PRs as themselves. Simple mode connects with a **GitHub App you
create**, configured entirely in the UI: no file editing, no restart.

1. **Create the app.** The GitHub step in `/welcome` submits a GitHub App
   manifest for either a personal account or an organization. The manifest
   carries the private App name, complete permission set, event subscriptions,
   and the current public webhook URL when one exists. Confirm **Device Flow**
   because its URL parameter is undocumented, then create the App.
2. **Return automatically.** GitHub redirects the browser to the private Open
   Session address with a one-time conversion code. The server exchanges it for
   the App slug, Client ID, client secret, webhook secret, and private key. It
   stores the key with mode 0600 and never sends any of those secrets back to
   the browser. The **Use an existing GitHub App** disclosure keeps the manual
   path for an App that was created elsewhere.
3. **Install on your repositories.** Follow the install link and pick the repos
   to expose. An App credential reaches only repositories included in that
   installation.
4. **Connect.** Enter the one-time code at `github.com/login/device`. The token
   is stored under the login GitHub reports (`~/.opensession/github-auth.json`,
   0600, never shown again). Interactive HTTPS clones and pushes receive it
   through a process-local credential helper. No static GitHub token is involved.

A public callback origin is not required for App creation, repository access,
or sign-in. When no public ingress exists, the manifest omits its webhook.
Configuring Public callbacks later under **Settings → Domains and ingress**
updates the App webhook URL and shared secret with App JWT authentication. This
keeps networking out of first-run onboarding while allowing comments, labels,
and other webhook events to be enabled later.

The single connected account is _the_ account for this install (there is no
roster in simple mode; the one connected account is the acting identity).
**Disconnect** removes it. For a UI-managed App, **Remove app** then clears the
configured client id, slug, secret, private key, and installation intent; the
GitHub integration must be disabled first. An App set through environment
variables can only be changed by updating those variables and restarting.
There is no personal-access-token path: the App is the only simple-mode
connect.

### Graduating to per-user sign-in

Connecting the app does **not** by itself turn on the sign-in gate (governed
solely by `integrations.github.userPrAuth`). Because the App's client id is the
_same_ key sign-in reads, graduating a team to
[per-user GitHub auth](#per-user-github-auth-prs-as-the-session-owner) is a
one-flag change, or automatic for an org-owned app: `install.sh --org <name>`
(or choosing the Organization owner in the wizard) records the org, and at the
connect step rosters the connecting account as the first admin and enables
sign-in in one locked write. A personal app stays single-user with no gate.

## Deploy script

`deploy/deploy.sh` updates a source checkout installed as the system-scope
service. Run it as root on the box, directly or through a root-capable remote
runner such as AWS SSM Run Command:

```sh
sudo deploy/deploy.sh             # deploy origin/main
sudo deploy/deploy.sh <git-sha>   # deploy a specific fetched revision
```

There is no deployment workflow in this repository. The script:

1. fetches origin and resolves the target without checking out, merging,
   resetting, or installing dependencies in the shared WIP checkout,
2. refuses a target that does not descend from the pinned runtime unless the
   operator deliberately sets `OPENSESSION_DEPLOY_ALLOW_DIVERGED=1`,
3. creates or reuses a detached worktree for the exact commit under the deploy
   state directory, runs `bun install --frozen-lockfile` there, and verifies its
   tracked files,
4. installs the executor and session-kernel credentials and fixed run-host
   helper, synchronizes all three units and the gateway release environment,
   and validates the installed helper policy,
5. installs the gateway resource override and per-user `opensession.slice`, and
   when Caddy is installed, synchronizes its Tailscale boot-order drop-in,
6. waits up to `MAX_DRAIN_WAIT` (480 seconds by default) for
   `activeRuns == 0`, records the previous release as last-known-good, and
   atomically switches the `current` release pointer,
7. stops the gateway before replacing its protocol peer, runs the offline
   session migration, restarts and readiness-checks the executor and session
   kernel, then restarts the gateway and requires `/ready` to recover, and
8. switches the pointer back and restarts the previous release when a
   post-switch readiness or health check fails, subject to the kernel schema
   compatibility floor.

Every source release is one gateway + kernel + executor version, so the root
script rolls out all three even for a frontend-only commit. Detached run-host
units keep executing their original release until their turns finish. For
ordinary source changes that do not update privileged installed artifacts, an
interactive admin can use the lighter `deploy_self` path described in
[self-development.md](../self-development.md); it still restarts all three
runtime services.
