# GitHub authority: who may do what, and with which credential

Status: proposal, 2026-09-08. Written after the credential split (#318, #319,
#325) made the merge button unusable on split-credential deployments. It
replaces the ad-hoc rules that accumulated across `security-model.md` and
`setup/github.md` with one model. Instance-specific findings that motivated it
live in the operator's private notes, not here.

## The requirement

1. A human who explicitly triggers an action in Open Session acts with their
   full GitHub permissions. Merge, close, review, push: whatever they could do
   on github.com, they can do from the OS UI, attributed to them.
2. An agent, whether it is working on a human's behalf in an interactive
   session or running unattended in an automation, can never update a
   protected branch, merge a pull request, or perform a destructive action,
   no matter what it finds on the host or what its prompt is told.

These are two different principals with two different ceilings. The current
system gives them one ceiling and has been moving it up and down.

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
so requirement 2 can only be met if agent runs never carry a human token.

A related live bug: `agents/github/handoff.ts` delivers fix-round handoffs
with sender `"GitHub"`. `githubCredentialUser` (#322) treats only the
auto-continue sender as synthetic, so `"GitHub"` shadows the session owner and
the turn runs with an empty token. Michiel and John have already decided that
fix-round replies should post as the bot, not the human. The Delegate
principal below is exactly that: the turn credential is an installation token
whatever the sender string says, so the shadowing class of bug disappears.

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
- A human's token grants the human's authority to whoever holds it. Agent
  runs therefore must not hold it; attribution has to come from somewhere
  else.

## Design

### Principals

| Principal  | Who                                                                    | GitHub identity   |
| ---------- | ---------------------------------------------------------------------- | ----------------- |
| Human      | A signed-in person clicking a button in any OS client                  | Their own account |
| Delegate   | The agent in an interactive session, acting for the session owner      | `<app-slug>[bot]` |
| Automation | Unattended code runs: automations, `github-*` code loops, descendants  | `<app-slug>[bot]` |
| Reviewer   | Unattended ask runs over untrusted content: PR review, merge risk      | `<app-slug>[bot]` |
| Service    | Server-owned calls: PR cache, review posting, webhooks, worktree setup | `<app-slug>[bot]` |

Human is the only principal that ever holds a user token. Every other
principal is the App.

### Capabilities

| Capability                          | Human | Delegate | Automation | Reviewer | Service |
| ----------------------------------- | ----- | -------- | ---------- | -------- | ------- |
| Read repo, PRs, checks, Actions     | yes   | yes      | yes        | yes      | yes     |
| Push the session's own branch       | yes   | yes      | own branch | no       | no      |
| Force-push own branch               | yes   | lease    | no         | no       | no      |
| Open a PR                           | yes   | yes      | yes        | no       | no      |
| Comment, reply in threads           | yes   | yes      | yes        | yes      | yes     |
| Submit an approving review          | yes   | no       | no         | no       | no      |
| Merge                               | yes   | no       | no         | no       | no      |
| Update or push the default branch   | PR    | no       | no         | no       | no      |
| Delete a branch                     | yes   | no       | no         | no       | no      |
| Repository settings, rulesets, apps | no    | no       | no         | no       | no      |

"PR" means the human reaches `main` only by merging a PR that satisfies the
integrity ruleset. "lease" means `--force-with-lease` only.

### Credentials

- **Human**: the App user token from device-flow sign-in, as today. It is used
  by server routes for human-initiated actions only (`pr-merge`,
  `pr-stack-merge`, `pr-close`, `pr-review`, `pr-comment`, `git-push`, and the
  proposal endpoints below). It is never placed in a run environment, a
  projected auth file, or a Sandbox. Every client (web, phone, Electron, iOS,
  Chrome) already goes through these routes, so this needs no client change.
  Auto-continue keeps resolving the session owner for these routes (#322);
  the owner's identity is still needed for attribution and for the proposal
  cards, it just no longer becomes a run credential.
- **Delegate and Automation**: a repository-scoped installation token with the
  code permission set (`contents: write`, `pull_requests: write`,
  `issues: write`, `checks/actions/statuses: read`, `metadata: read`), minted
  per turn, one hour, never persisted. This is `githubServiceCredentialEnv`,
  which the `github-*` code loops already use. Interactive runs and fix-round
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

### Human actions are server-executed; agents propose

Everything in the Human column runs in a server route with the human's token,
triggered by a click. The agent never calls these itself. Where the agent
needs the outcome, it proposes and the human confirms:

- `opensession-repos` gains `propose_pull_request({repo, base, title, body,
reviewers})` and `propose_merge({repo, number, method})`. Each writes a
  proposal card into the session transcript. The card's button calls the
  existing routes with the human's credential, so a PR opened this way is
  authored by the human and a merge is performed by the human.
- A delegate may also open a PR directly as the bot when nobody is waiting on
  the card. That PR carries the attribution footer and the human as assignee,
  the pre-`userPrAuth` behavior.
- The existing five-second Merge with Undo in `PrStatusBar` stays as the
  human's merge control. A `propose_merge` card simply focuses it.

### Attribution without authority

- Commit author stays the human (`gitIdentityEnv(author)`), with the model as
  `Co-Authored-By`. GitHub shows the human as author and the bot as pusher.
- PR bodies end with the attribution footer from the session context. Bot
  authored PRs assign the human; human authored ones do not.
- Session context text changes from "PRs use @login's account; do not add an
  assignee" to whichever of the two applies.
- Review threads and fix-round replies post as the bot. This is the decided
  behavior for handoffs and it is what the Delegate credential produces.

Whether the team prefers bot-authored or human-authored PRs is a review
policy question, not a security one: a human cannot approve their own PR, so
bot-authored PRs let the session owner be the reviewer, while human-authored
PRs force a second person. The proposal card gives either.

### Host hygiene

- Every run receives the `githubGitCredentialEnv` shape: the credential
  helper, `GIT_TERMINAL_PROMPT=0`, the SSH to HTTPS `insteadOf` rewrite, and
  an isolated `GH_CONFIG_DIR` (#319). The token inside is the principal's:
  code set for Delegate and Automation, read set for Reviewer. A run that is
  meant to have no write access gets the read token, not an empty helper,
  because an empty helper today means "use whatever the host has". Git must
  fail with a clear authentication error, never fall through.
- No PAT, SSH key, or `gh` login on the host. `~/.opensession/github-auth.json`
  and `github-app.pem` remain, readable by the gateway uid.
- Agent bash still shares that uid on host runs. That is the residual risk:
  an adversarial agent can read the human token store. The rulesets bound
  what the bot can do with the App key, but a human token is the human. The
  fix is uid separation for run hosts, or Sandboxes by default; until then
  the invariant is "no human token in any run environment" and the threat
  model is a confused agent, not a hostile one.

### Command policy as a tripwire for every agent

`PublicationPolicy` becomes a property of every delegate and automation run,
not only descendants: `{repo, baseBranch, headBranches}` where `headBranches`
is the session branch plus each attached repository's branch. It refuses
`gh pr merge`, `gh pr review --approve`, `gh api` with a mutating method,
`git push` to `baseBranch` or to a branch outside `headBranches`, `--force`
without `--force-with-lease`, `git push --delete`, and any `--repo` outside the
session's repositories. Interactive runs get a question card instead of a
refusal, and the card offers the server-executed action when one exists.

This is a tripwire, as `command-policy.ts` says of itself. The boundary is
the token and the rulesets.

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

After this, humans merge from the UI again and no bot identity can touch
`main`. Interactive runs still carry the human's token until phase 1, which
is the pre-2026-09-07 state and should not be left for long.

**Phase 1, credentials and policy**

4. `pi-runner.ts`: interactive runs use `githubCodeRunEnv(cwd)` instead of
   `githubRunEnv(user)`; fix-round handoff turns take the same path, which
   also closes the `"GitHub"` sender bug. Remove `githubRunEnv`,
   `githubAuthEnv`, the token half of `projectedGithubAuthEnv`, and the
   Sandbox projection of user tokens. `githubCredentialForLogin`,
   `githubCredentialUser`, and `soleGithubAccount` remain for routes and
   attribution. Ask-mode `github-*` runs keep the #325 read path untouched.
5. Give ordinary code automations the Automation credential plus a
   `PublicationPolicy`, so they open real PRs instead of pushing with an
   ambient identity.
6. Inject the credential-helper env shape into every run, read token for
   Reviewer, code token otherwise.
7. Extend `PublicationPolicy` to every delegate and automation run.
8. Delete the transport-token plumbing and its docs section. Fix
   `audited()`.

**Phase 2, product**

9. `propose_pull_request` and `propose_merge` in `opensession-repos`, proposal
   cards in the transcript, the routes behind them, session-context wording.
10. Boot-time posture log and a Settings → Integrations panel that shows
    installation permissions and missing rulesets per repository.

**Phase 3, isolation**

11. Run hosts under a separate uid, or Sandboxes by default for interactive
    sessions, so the human token store is unreadable from agent bash.

## What this removes

- The "Separate git-transport credential" mechanism and its four code paths.
- The contents-narrowing in `githubAppMintPermissions`.
- The rule that ordinary automations get no GitHub credential, replaced by
  "every agent gets a bot credential sized to its principal and a
  publication policy".
- The claim that "no credential on the host can merge". The claim becomes "no
  bot credential can update `main`, and no run holds a human credential".

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
  `opensession`.
- Bot-authored or human-authored PRs by default? See Attribution.
- Should the humans-only bypass stay a team (`mergers`) or become the
  `maintain` role? The team is explicit, auditable, and already evidenced;
  a role follows repository membership.
- Simple mode (one person, personal App) has one token that is both the human
  and, in effect, the delegate. The rulesets still hold; the token separation
  does not. Acceptable for a single-user install, worth stating in the docs.
- Code Storage hosts have no rulesets. Their "pushed branch is the change
  request" model already keeps agents off the mainline; document it as the
  equivalent.
