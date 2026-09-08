# GitHub authority: who may do what, and with which credential

Status: proposal, 2026-09-08. Written after the credential split (#318, #319,
#325) made the merge button unusable on split-credential deployments. It
replaces the ad-hoc rules that accumulated across `security-model.md` and
`setup/github.md` with one model. Instance-specific findings that motivated it
live in the operator's private notes, not here.

## The requirement

1. A human who explicitly triggers an action in Open Session acts with their
   full GitHub permissions. Merge, close, review, push: whatever they could do
   on github.com, they can do from the OS UI, attributed to them. That
   includes telling the agent in their own session to do it: "merge this"
   from the session owner merges as the session owner.
2. An unattended run, whether an automation, a `github-*` loop, a review, or
   a fix-round handoff into someone's session, can never update a protected
   branch, merge a pull request, or perform a destructive action, no matter
   what it finds on the host or what its prompt is told.

These are two different principals with two different ceilings. The current
system gives them one ceiling and has been moving it up and down. The line
between them is not "human versus agent"; it is "a human is present and
asking" versus "nobody is".

## How a split-credential deployment fails today

A split-credential deployment caps the App installation at `contents: read`
and hands pushes to a separate git-transport token. Each part is locally
sound and the combination fails both requirements.

### The merge button

`POST /api/sessions/:id/pr-merge` runs `gh pr merge` with the signed-in
human's App user token (`githubMutationCredential`). A GitHub App user token
can never exceed the App's own permissions, and merging needs
`contents: write` as well as `pull_requests: write`. Once the installation is
capped at `contents: read`, every human merge from the UI fails, and the
human falls back to github.com. `audited()` records each failure as
`ok: true`, because a resolved `{ error }` object counts as success.

The cap was deliberate: `setup/github.md` says the split "makes merging
something no credential on the host can do alone". That is requirement 2
applied to principal 1. The App permission set is the ceiling for humans and
bots at once, so lowering it for bots lowers it for humans.

### Agents on a human's behalf

Interactive runs (`prompt`, `goal`, `create`, `linear`, `slack`, `workflow`)
receive the session owner's App user token as `GH_TOKEN` so that PRs are
authored by the human. Whatever the human may do, the agent may do with that
token. Before the cap this included merging; the cap removed it by removing
it from the human too. GitHub has no narrower delegated form of a user token,
so the choice is binary: the interactive agent either holds the human's
authority or none of it. This design keeps it, because the session owner
wants "merge this" to work, and puts the guard on the turn instead: the
token is present only while the owner is the one prompting.

A related live bug: `agents/github/handoff.ts` delivers fix-round handoffs
with sender `"GitHub"`. `githubCredentialUser` (#322) treats only the
auto-continue sender as synthetic, so `"GitHub"` shadows the session owner and
the turn runs with an empty token. Michiel and John have already decided that
fix-round replies should post as the bot, not the human. That is the
Automation principal below: a turn that no human started gets an
installation token whatever the sender string says, so the shadowing class
of bug disappears.

### Unattended runs

Ordinary automations are credential-free by design. A run with no injected
credential also gets no `git@github.com` to HTTPS rewrite and no isolated
`gh` config, so `git push` and `gh` fall through to whatever ambient
credential the host accumulated: an SSH key, a `gh` login, a transport token
in a config file. Split-credential deployments accumulate these by nature,
because the split needs a second credential that the App cannot mint. The
result is that "credential-free" runs push branches with an identity nobody
chose for them, and an agent that hits a permission error goes looking for
the next credential on disk.

The `github-*` code workflows receive a repository-scoped installation token
with the code permission set. Ask-mode review runs receive the read set,
with the transport token explicitly excluded at both injection points
(#325). Automation descendants additionally get a `PublicationPolicy`
(`command-policy.ts`) that refuses `gh pr merge`, `gh api`, pushes to the
base branch, and pushes to any branch other than the one they own. That
policy is the right shape and applies to the wrong population: only
descendants have it.

### Rulesets

The split moved enforcement into tokens, so the rulesets on protected
branches were never asked to carry it. A repository whose default-branch
ruleset only forbids deletion and force-push lets any identity with
`contents: write` commit straight to it. In that state the transport token,
and any ambient credential with push access, can update `main`.

## Why the current direction cannot converge

Every recent change tunes a single knob, the App's permission set, and
compensates elsewhere: cap contents to read, add a transport token for
pushes, narrow mints so they do not 422, project the transport token into
Sandboxes, keep it out of read-only runs. Each step is locally correct and
the sum still fails both requirements: humans cannot merge, and the
transport token can reach `main` wherever a ruleset does not stop it.

Three facts fix the shape of any working design:

- App permissions are one ceiling for humans and bots. Do not use them to
  separate the two.
- GitHub separates identities per ref only through rulesets. That is the one
  place where "the bot may push branches but not `main`" can be enforced
  server-side, independent of which token leaked where.
- A human's token grants the human's authority to whoever holds it. Only a
  turn the human started may hold it, and the human must be able to see and
  stop what it does with it.

## Design

### Principals

| Principal  | Who                                                                    | GitHub identity   |
| ---------- | ---------------------------------------------------------------------- | ----------------- |
| Human      | A signed-in person clicking a button in any OS client                  | Their own account |
| Delegate   | The agent in a turn the session owner started, acting for the owner    | The owner         |
| Automation | Turns no human started: automations, `github-*` code loops,            | `<app-slug>[bot]` |
|            | descendants, fix-round handoffs, auto-continue of an automation        |                   |
| Reviewer   | Unattended ask runs over untrusted content: PR review, merge risk      | `<app-slug>[bot]` |
| Service    | Server-owned calls: PR cache, review posting, webhooks, worktree setup | `<app-slug>[bot]` |

Human and Delegate are the same GitHub identity. Delegate is the human's own
token in the hands of the agent, for the length of a turn the human started.
Every other principal is the App.

What makes a turn Delegate rather than Automation is who started it, not
which session it lands in. A prompt typed by the session owner, an
auto-continue of that prompt (#322), or a worker report back into that
session is Delegate. A GitHub webhook, a schedule, a fix-round handoff, or a
message from another session is Automation, even when it is delivered into
an interactive session. `githubCredentialUser` becomes the single place that
decides this, and it errs toward the bot: an unknown sender is not the owner.

### Capabilities

| Capability                          | Human | Delegate | Automation | Reviewer | Service |
| ----------------------------------- | ----- | -------- | ---------- | -------- | ------- |
| Read repo, PRs, checks, Actions     | yes   | yes      | yes        | yes      | yes     |
| Push the session's own branch       | yes   | yes      | own branch | no       | no      |
| Force-push own branch               | yes   | lease    | no         | no       | no      |
| Open a PR                           | yes   | yes      | yes        | no       | no      |
| Comment, reply in threads           | yes   | yes      | yes        | yes      | yes     |
| Resolve or unresolve a thread       | yes   | yes      | yes        | no       | yes     |
| Submit an approving review          | yes   | ask      | no         | no       | no      |
| Merge                               | yes   | ask      | no         | no       | no      |
| Update or push the default branch   | PR    | ask      | no         | no       | no      |
| Delete a branch                     | yes   | ask      | no         | no       | no      |
| Repository settings, rulesets, apps | no    | no       | no         | no       | no      |

"PR" means the human reaches `main` only by merging a PR that satisfies the
integrity ruleset. "lease" means `--force-with-lease` only. "ask" means the
agent can do it with the owner's token, and the command policy turns it into
a question card first: the owner sees the exact command and approves it in
the session. "Merge this" from the owner followed by one approval is the
intended path; a merge the owner did not ask for never gets past the card.
The Delegate column is also what the `mergers` roster bounds: an owner who
is not on the team cannot merge, and neither can their agent.

### Credentials

- **Human**: the App user token from device-flow sign-in, as today. Server
  routes use it for click-initiated actions (`pr-merge`, `pr-stack-merge`,
  `pr-close`, `pr-review`, `pr-comment`, `git-push`). Every client (web,
  phone, Electron, iOS, Chrome) already goes through these routes, so this
  needs no client change.
- **Delegate**: the same token, injected as `GH_TOKEN` into a turn the owner
  started, exactly as `githubRunEnv(user)` does today, with `githubCredentialUser`
  (#322) deciding whether the turn's sender is the owner. Nothing else in the
  run has it: not a projected auth file that outlives the turn, not a Sandbox
  volume. A turn whose sender is not the owner gets the Automation token
  instead, never an empty one.
- **Automation**: a repository-scoped installation token with the code
  permission set (`contents: write`, `pull_requests: write`, `issues: write`,
  `checks/actions/statuses: read`, `metadata: read`), minted per turn, one
  hour, never persisted. This is `githubServiceCredentialEnv`, which the
  `github-*` code loops already use. Ordinary code automations and fix-round
  handoff turns switch to it.
- **Reviewer**: the read set, exactly as #325 shipped it. The read-only
  ceiling is preserved by construction: the read set has no `contents: write`
  and there is no longer a transport token to exclude.
- **Service**: installation token selected by repository owner, as today.
- **Retired**: the git-transport credential and everything that carries it
  (`OPENSESSION_GITHUB_PUSH_TOKEN`, `GITHUB_PUSH_TOKEN_RUN_ENV`, the Sandbox
  projection in `sandbox/adapters/bootstrap.ts`, the special case in
  `gitCredentialEnvForExec`, the `githubAppMintPermissions` narrowing). Every
  ambient credential on the host that is not the App key or the human token
  store is revoked and removed. The App installation goes back to the grant
  set in code, including `contents: write`.

The App can push branches again with this. It still cannot touch `main`, and
that is enforced by GitHub, not by the token.

### Rulesets are the boundary

Two rulesets on every covered repository, both targeting the default branch.
Rulesets are additive and bypass lists are per ruleset, which is what makes
this work.

1. **Integrity** (no bypass actors): require a pull request, required status
   checks, linear history, no deletion, no force push. Everyone, humans
   included, reaches `main` through a green PR.
2. **Humans only** (bypass: the existing `mergers` team, mode "always"): the
   single rule "restrict updates". Only bypass actors may update the ref. A
   merge is an update, so only team members can merge, and the App, any
   PAT, any SSH key, and any leaked bot token cannot merge or push `main`
   whatever permissions they hold. `mergers` already exists and its roster is
   part of submitted SOC2 evidence; reuse it rather than creating a team.

Repositories whose release process pushes `main` from GitHub Actions need a
`DeployKey` bypass actor on the humans-only ruleset, because Actions cannot
be a bypass actor and those workflows push through a deploy key. The gitops
repository is the known case.

Verify the humans-only ruleset on a scratch repository before rollout:
confirm a `mergers` member can squash-merge through the API, and that an
installation token with `contents: write` gets refused on merge and on
`git push origin HEAD:main` while still pushing a feature branch.

With these two in place the question "which credential is on the box" stops
deciding whether `main` is safe. It decides only how much cleanup a leak
costs.

### The owner asks, the agent acts as the owner

A Delegate turn does the work directly: `git push`, `gh pr create`, and when
the owner asks for it, `gh pr merge`. The push is the owner's, the PR is
authored by the owner, the merge is performed by the owner, all under the
owner's login, which is what the team wants to see on GitHub.

The guard is the question card, not the token. `PublicationPolicy` runs in
Delegate turns too, and where it would refuse an Automation it asks the
owner instead: the card shows the command (`gh pr merge 327 --squash`), and
"Merge this" from the owner plus one approval is the whole flow. The
existing five-second Merge with Undo in `PrStatusBar` stays as the click
equivalent.

### Attribution

- Commit author stays the human (`gitIdentityEnv(author)`), with the model as
  `Co-Authored-By`.
- Delegate PRs are authored by the owner and carry the attribution footer
  from the session context, no assignee. Automation PRs are authored by the
  bot, carry the footer, and assign the human the automation names.
- Review threads and fix-round replies post as the bot, and the bot resolves
  the threads it has addressed. This is the decided behavior for handoffs
  and it is what the Automation credential produces. A Delegate turn replies
  and resolves as the owner, the same as the owner would on github.com.

### Host hygiene

- Every run receives the `githubGitCredentialEnv` shape: the credential
  helper, `GIT_TERMINAL_PROMPT=0`, the SSH to HTTPS `insteadOf` rewrite, and
  an isolated `GH_CONFIG_DIR` (#319). The token inside is the principal's:
  the owner's for Delegate, code set for Automation, read set for Reviewer.
  A run that is meant to have no write access gets the read token, not an
  empty helper, because an empty helper today means "use whatever the host
  has". Git must fail with a clear authentication error, never fall through.
- No PAT, SSH key, or `gh` login on the host. `~/.opensession/github-auth.json`
  and `github-app.pem` remain, readable by the gateway uid.
- Agent bash still shares that uid on host runs, and a Delegate turn holds
  the owner's token by design. So on a host run the owner's authority is
  available to the agent for the length of the turn, and the token store is
  readable between turns. The rulesets bound what the bot can do with the
  App key; a human token is the human, bounded only by the question card
  and the `mergers` roster. The threat model for Delegate turns is a
  confused agent, not a hostile one. Uid separation for run hosts, or
  Sandboxes by default, closes the between-turns half.

### Command policy as a tripwire for every agent

`PublicationPolicy` becomes a property of every delegate and automation run,
not only descendants: `{repo, baseBranch, headBranches}` where `headBranches`
is the session branch plus each attached repository's branch. It matches by
effect, not by HTTP verb: `gh pr merge`, `gh pr review --approve`, `git push`
to `baseBranch` or to a branch outside `headBranches`, `--force` without
`--force-with-lease`, `git push --delete`, any `--repo` outside the session's
repositories, and the `gh api` forms of the same outcomes (the merge
endpoints, a review with the `APPROVE` event, ref updates and deletes,
`mergePullRequest`, `enablePullRequestAutoMerge`). Commenting, replying in a
thread, and `resolveReviewThread` / `unresolveReviewThread` are not
publication and pass in every turn kind; an agent that has fixed a finding
replies and resolves the thread without a card. Automation turns get a
refusal on the matched set. Delegate turns get a question card with the
exact command, answered "once", never "always".

For Automation this is a tripwire, as `command-policy.ts` says of itself;
the boundary is the token and the rulesets. For Delegate the card is the
boundary, because the token is the owner's. That is a deliberate choice: the
owner asked for an agent that can merge on request, and a card per merge is
the cheapest way to make "on request" mean something.

### Observability

- `audited()` marks a resolved `{ error }` result as `ok: false` and records
  the error text. Failed merges must not read as successes.
- Merge and push routes translate GitHub's permission errors into a sentence
  that names the cause and the fix ("The GitHub App is capped at
  `contents: read`, so nobody can merge from here"), the way
  `device_flow_disabled` is handled.
- Boot logs the credential posture: App permissions per installation, whether
  any retired credential path is still configured, and which rulesets are
  missing on covered repositories (read via the installation token; the App
  has no admin permission and should not get one).

## Migration

Phase 0 is compliance and operator work and unblocks merging without a
deploy. Phases 1 and 2 are code. Phase 3 is infrastructure.

**Phase 0, compliance, GitHub and host (no deploy)**

0. Before any live state changes: add a dated addendum to the deviation
   record for the incident that introduced the App cap and the transport
   token split. It states that the control objective is unchanged (no
   automated identity can update a protected branch or merge a pull request)
   and that enforcement moves from a permission cap plus credential split to
   identity-based rulesets with the `mergers` team as the only human bypass.
   Auditors were told the cap and split are the corrective actions; the
   record has to say otherwise before the instance does.
1. Add the humans-only ruleset to every covered repository, with the
   `DeployKey` bypass where a release workflow pushes `main`. Add the pull
   request rule to any integrity ruleset that lacks it. Verify on a scratch
   repository first. See the first open question before applying this to
   `opensession` itself.
2. Restore `contents: write` on the installation (approve the updated
   permissions in the org).
3. Unset `OPENSESSION_GITHUB_PUSH_TOKEN`; revoke the transport token. Revoke
   and remove every other ambient credential on the host.

After this, humans merge from the UI again, the owner's agent merges on
request again, and no bot identity can touch `main`.

**Phase 1, credentials and policy**

4. `githubCredentialUser` decides Delegate versus Automation for every turn,
   defaulting to Automation for any sender that is not the session owner or
   an auto-continue of the owner. `pi-runner.ts` injects `githubRunEnv(user)`
   for Delegate and `githubCodeRunEnv(cwd)` for Automation; fix-round
   handoff turns land on the Automation path, which closes the `"GitHub"`
   sender bug. Ask-mode `github-*` runs keep the #325 read path untouched.
5. Give ordinary code automations the Automation credential plus a
   `PublicationPolicy`, so they open real PRs instead of pushing with an
   ambient identity.
6. Inject the credential-helper env shape into every run, read token for
   Reviewer, code token for Automation, owner token for Delegate.
7. Extend `PublicationPolicy` to every delegate and automation run: refusal
   for Automation, question card for Delegate.
8. Delete the transport-token plumbing and its docs section. Fix
   `audited()`.

**Phase 2, product**

9. Boot-time posture log and a Settings → Integrations panel that shows
   installation permissions and missing rulesets per repository.

**Phase 3, isolation**

10. Run hosts under a separate uid, or Sandboxes by default for interactive
    sessions, so the human token store is unreadable from agent bash between
    turns.

## What this removes

- The "Separate git-transport credential" mechanism and its four code paths.
- The contents-narrowing in `githubAppMintPermissions`.
- The rule that ordinary automations get no GitHub credential, replaced by
  "every agent gets a bot credential sized to its principal and a
  publication policy".
- The claim that "no credential on the host can merge". The claim becomes "no
  bot credential can update `main`, and a human credential is present only in
  a turn that human started, behind a card for anything that touches `main`".

## Open questions

- **The `opensession` repository's own development model.** Sessions push
  the shared checkout's `main` directly and the host self-builds from those
  pushes. A humans-only ruleset on `opensession` `main` breaks that unless
  session pushes carry a bypass identity, and under this design a session's
  own push runs as the bot. The options are: keep `opensession` on the
  integrity ruleset only and accept that the bot can update its `main`
  through a PR-less push; route the shared-checkout push through a server
  route that uses the session owner's token, which limits direct pushes to
  `mergers` members; or move `opensession` to PR-only like every other
  repository and let `deploy_self` promote merged commits. This is a
  workflow decision for Michiel and it gates Phase 0 step 1 for
  `opensession`. Under this design a Delegate turn pushes as the owner, so a
  `mergers` member's session can already update `main` through the
  humans-only ruleset; the question is only about Automation pushes and
  about owners who are not on the team.
- Should the merge card be skippable? A per-session or per-user "merge
  without asking" toggle would make "merge this" a single step. It also
  makes the token the only guard for the rest of the session.
- Should the humans-only bypass stay a team (`mergers`) or become the
  `maintain` role? The team is explicit, auditable, and already evidenced;
  a role follows repository membership.
- Simple mode (one person, personal App) has one token for every principal,
  Automation included. The rulesets still hold; the Delegate versus
  Automation split does not. Acceptable for a single-user install, worth
  stating in the docs.
- Code Storage hosts have no rulesets. Their "pushed branch is the change
  request" model already keeps agents off the mainline; document it as the
  equivalent.
