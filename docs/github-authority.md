# GitHub authority: who may do what, and with which credential

## Current policy

A connected person's code turn holds their GitHub user token and uses `gh`
and HTTPS git directly. Repository instructions determine the publication
workflow, including shared-main pushes; GitHub permissions and rulesets bound
the credential. The dedicated PR MCP tools and the interactive blanket
merge/default-branch prohibition have been removed.

Ask runs, unattended runs, and machine-authored turns keep their App-token
limits and publication guards. Run-scoped `GH_CONFIG_DIR`, bot commit authorship,
`Co-authored-by` attribution, and audit error handling remain unchanged.

The credential rollback shipped in `773380904`; this change completes the
interactive tooling/policy rollback of `a8ee01aeee`. See
[GitHub setup](setup/github.md) and [the security model](security-model.md)
for current behavior.

## Historical design

The remaining sections record the superseded design and its rationale, not
current instructions for agents.

Status: Phase 1 (credentials, tools, policy) implemented 2026-09-08; Phase 0
(rulesets, App permission, credential revocation) is operator work per
deployment, and Phases 2 and 3 are open. Written after the credential split
(#318, #319, #325) made the merge button unusable on split-credential
deployments. It replaces the ad-hoc rules that accumulated across
`security-model.md` and `setup/github.md` with one model. Instance-specific
findings that motivated it live in the operator's private notes, not here.
The owner-identity tools shipped as the `opensession-pull-requests` server
(`open_pull_request`, `edit_pull_request`, `propose_merge`); `propose_merge`
posts a notice and the person merges from the PR panel, which is the one-tap
card until a dedicated card lands in the clients.

## The requirement

1. A human who explicitly triggers an action in Open Session acts with their
   full GitHub permissions. Merge, close, review, push: whatever they could do
   on github.com, they can do from the OS UI, attributed to them. A pull
   request the agent opens at the owner's request shows up under the owner's
   name, and "merge this" from the owner is one tap away.
2. No agent process, in any kind of turn, ever holds a credential that can
   merge a pull request, update a protected branch, or approve a review. An
   unattended run, whether an automation, a `github-*` loop, a review, or a
   fix-round handoff into someone's session, can never do those things no
   matter what it finds on the host or what its prompt is told, and neither
   can an agent in the owner's own session.

These are two different principals with two different ceilings. The current
system gives them one ceiling and has been moving it up and down. The line
that matters is not "human versus agent"; it is "a human clicked" versus "a
model decided". Only the first ever reaches `main`.

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
so as long as the token is in the agent's shell the choice is binary: the
agent either holds the human's whole authority or none of it. Where the
human is a ruleset bypass actor, "whole authority" means merging without a
review or a green check. A command policy in front of the shell can ask
before `gh pr merge`, but a policy is a check in our code, not in GitHub;
anything it does not recognise goes through as the human. This design takes
the token out of the shell instead. The agent gets the owner's identity only
through tools the gateway executes on the server, and those tools do not
include merge.

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
- A human's token grants the human's authority to whoever holds it. No agent
  process may hold it. Where the agent needs to act under the human's name,
  the gateway does the request for it, with a fixed list of things it will
  do.

## Design

### Principals

| Principal  | Who                                                                    | GitHub identity                 |
| ---------- | ---------------------------------------------------------------------- | ------------------------------- |
| Human      | A signed-in person clicking a button in any OS client                  | Their own account               |
| Delegate   | The agent in a turn the session owner started                          | Bot in the shell, owner by tool |
| Automation | Turns no human started: automations, `github-*` code loops,            | `<app-slug>[bot]`               |
|            | descendants, fix-round handoffs, auto-continue of an automation        |                                 |
| Reviewer   | Unattended ask runs over untrusted content: PR review, merge risk      | `<app-slug>[bot]`               |
| Service    | Server-owned calls: PR cache, review posting, webhooks, worktree setup | `<app-slug>[bot]`               |

Every agent process runs as the App. The owner's token exists in exactly two
places: the routes behind the UI buttons, and a short list of gateway tools
a Delegate turn can call, each of which does one request as the owner on the
server and returns the result. The agent's shell never sees it.

What makes a turn Delegate rather than Automation is who started it, not
which session it lands in. A prompt typed by the session owner, an
auto-continue of that prompt (#322), or a worker report back into that
session is Delegate. A GitHub webhook, a schedule, a fix-round handoff, or a
message from another session is Automation, even when it is delivered into
an interactive session. `githubCredentialUser` becomes the single place that
decides this, and it errs toward the bot: an unknown sender is not the owner.
The only thing the decision changes is whether the owner-identity tools are
mounted; the shell credential is the bot either way.

### Capabilities

| Capability                          | Human | Delegate      | Automation | Reviewer | Service |
| ----------------------------------- | ----- | ------------- | ---------- | -------- | ------- |
| Read repo, PRs, checks, Actions     | yes   | yes           | yes        | yes      | yes     |
| Push the session's own branch       | yes   | own, as bot   | own branch | no       | no      |
| Force-push own branch               | yes   | lease, as bot | no         | no       | no      |
| Open or edit a PR                   | yes   | as owner      | as bot     | no       | no      |
| Comment, reply in threads           | yes   | as bot        | as bot     | as bot   | as bot  |
| Label a PR, any registered repo     | yes   | as bot        | own repo   | no       | no      |
| Resolve or unresolve a thread       | yes   | as bot        | as bot     | no       | as bot  |
| Submit an approving review          | yes   | no            | no         | no       | no      |
| Merge                               | yes   | card          | no         | no       | no      |
| Update or push the default branch   | yes   | no            | no         | no       | no      |
| Delete a branch                     | yes   | no            | no         | no       | no      |
| Repository settings, rulesets, apps | no    | no            | no         | no       | no      |

"as bot" means the agent's shell does it with the installation token, in
every turn kind: a reply in a review thread or a resolved thread is the
bot's on GitHub, whoever started the turn. "as owner" means the agent calls
a gateway tool and the gateway does the request with the owner's token, on
the server, without a tap: the PR is the owner's on GitHub, and the agent
never held the credential. "lease" means `--force-with-lease` only. "card" means the
agent cannot do it at all; it writes a merge card into the session and the
owner's tap calls the same `pr-merge` route the Merge button calls, with the
owner's token. "Merge this" from the owner is therefore one tap, and a merge
nobody tapped cannot happen, because nothing in the agent's reach can
perform one. Whether the tap succeeds is GitHub's decision about the human:
the rulesets, and the human's own bypass status, apply unchanged.

### Credentials

- **Human**: the App user token from device-flow sign-in, as today. Server
  routes use it for click-initiated actions (`pr-merge`, `pr-stack-merge`,
  `pr-close`, `pr-review`, `pr-comment`, `git-push`). Every client (web,
  phone, Electron, iOS, Chrome) already goes through these routes, so this
  needs no client change.
- **Delegate**: the Automation token below in the shell, plus three
  owner-identity tools: `open_pull_request`, `edit_pull_request`, and
  `propose_merge`, which only writes the card. The first two run one request
  on the server with the owner's token, scoped to the session's
  repositories, and are mounted only when `githubCredentialUser` (#322) says
  the turn's sender is the owner. Comments, thread replies, and resolves are
  not owner-identity actions; the shell does them with the bot token like
  any other turn. The owner's token is never in `GH_TOKEN`, an auth file, a
  Sandbox volume, or anything else the run can read. `githubRunEnv(user)`
  and the user-token projection into runs are deleted.
- **Automation**: a repository-scoped installation token with the code
  permission set (`contents: write`, `pull_requests: write`, `issues: write`,
  `checks/actions/statuses: read`, `metadata: read`), minted per turn, one
  hour, never persisted. This is `githubServiceCredentialEnv`, which the
  `github-*` code loops already use. Every other agent run switches to it:
  owner-started turns, ordinary code automations, and fix-round handoff
  turns.
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
that is enforced by GitHub, not by the token. There is now exactly one kind
of credential in any agent's reach, and it is one the rulesets bind.

### Rulesets are the boundary

Two rulesets on every covered repository, both targeting the default branch.
Rulesets are additive and bypass lists are per ruleset, which is what makes
this work.

1. **Integrity**: the repository's existing default-branch ruleset, left
   exactly as it is. Require a pull request, required status checks, linear
   history, no deletion, no force push, with whatever human bypass actors
   the repository already grants. This design does not change who among the
   humans may skip review; that is a separate question for the people who
   own the compliance record, and it stays separate.
2. **Humans only** (bypass: the same human actors the integrity ruleset
   already lists, teams and organization owners, mode "always"): the single
   rule "restrict updates". Only bypass actors may update the ref. A merge is
   an update, so only those humans can merge, and the App, any PAT, any SSH
   key, and any leaked bot token cannot merge or push `main` whatever
   permissions they hold. Humans notice nothing. Reuse the existing teams
   rather than creating one; their rosters are already evidenced.

Repositories whose release process pushes `main` from GitHub Actions need a
`DeployKey` bypass actor on the humans-only ruleset, because Actions cannot
be a bypass actor and those workflows push through a deploy key. The gitops
repository is the known case.

Verify the humans-only ruleset on a scratch repository before rollout:
confirm a bypass-team member can squash-merge through the API, and that an
installation token with `contents: write` gets refused on merge and on
`git push origin HEAD:main` while still pushing a feature branch.

With these two in place the question "which credential is on the box" stops
deciding whether `main` is safe. It decides only how much cleanup a leak
costs.

### The owner asks, the gateway acts as the owner

A Delegate turn commits as the bot, with the owner as `Co-authored-by`, and
pushes its branch with the bot token. Then it calls `open_pull_request`, and
the gateway creates the PR as the owner, with the attribution footer from
the session context. On GitHub the PR reads exactly as if the owner had
opened it, which is what the team wants to see, and the agent's process held
nothing but a bot identity throughout. Review-thread replies and resolves
later in the PR's life are the bot's, in this turn kind as in every other:
the human's name is on the PR and on every commit as co-author, the bot's on
the commits it wrote and the back-and-forth it did.

When the owner says "merge this", the agent calls `propose_merge`. That
writes a merge card into the transcript: the PR, the method, the check and
review state. The owner's tap calls `pr-merge` with the owner's token, the
same route the Merge button uses, with the existing five-second Undo. The
agent has no path to the merge itself: not through a tool, not through the
shell, not through the API, because nothing in its environment carries a
token that GitHub would accept for an update to `main`.

The gateway tools are the whole Delegate surface. There are two that touch
GitHub, they are named after their effect, and each does one request.
Adding one is a security review, not a convenience.

### Attribution

- Commits are authored by the bot in every turn kind, with the human as
  `Co-authored-by`: for Delegate, whoever sent the prompt, and for a turn
  nobody sent (a review handoff, an auto-continue, a queue drain) the person
  the session acts for, which is the last person who prompted it and the
  creator until someone else does (`sessionPrincipal`, recorded on the
  session as `lastPromptedBy`); for Automation, the human the automation
  names. `gitIdentityEnv` sets the bot identity and the
  trailer; no run carries a human `GIT_AUTHOR_*` or `GIT_COMMITTER_*`
  identity, so nothing an agent commits can be mistaken for something the
  human typed. Where a repository requires signed commits, the bot's signing
  key is the only key on the host.
- Delegate PRs are authored by the owner through the gateway tool and carry
  the attribution footer from the session context, no assignee. Automation
  PRs are authored by the bot, carry the footer, and assign the human the
  automation names.
- Review threads, replies, and resolves post as the bot in every turn kind,
  Delegate included. This is the decided behavior for handoffs and it is
  what the shell credential produces without any tool; a human who wants
  their own name on a reply writes it on github.com.

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
- Agent bash still shares that uid on host runs, so the human token store
  and the App key are readable from the shell. The rulesets bound what the
  App key can do; a human token read from that file is the human. That is
  the one remaining way an agent could reach `main`, it requires the agent
  to go looking for a file it was never handed, and uid separation for run
  hosts, or Sandboxes by default, closes it.

### Command policy as a tripwire for every agent

`PublicationPolicy` becomes a property of every agent run, not only
descendants: `{repo, baseBranch, headBranches}` where `headBranches`
is the session branch plus each attached repository's branch. It matches by
effect, not by HTTP verb: `gh pr merge`, `gh pr review --approve`, `git push`
to `baseBranch` or to a branch outside `headBranches`, `--force` without
`--force-with-lease`, `git push --delete`, any `--repo` outside the session's
repositories, and the `gh api` forms of the same outcomes (the merge
endpoints, a review with the `APPROVE` event, ref updates and deletes,
`mergePullRequest`, `enablePullRequestAutoMerge`). Commenting, replying in a
thread, and `resolveReviewThread` / `unresolveReviewThread` are not
publication and pass in every turn kind; an agent that has fixed a finding
replies and resolves the thread without a card. Every turn kind gets a
refusal on the matched set. In a Delegate turn the refusal names the tool to
use instead (`propose_merge`), so "merge this" still ends in a card rather
than an error.

This is a tripwire, as `command-policy.ts` says of itself. The boundary is
the token and the rulesets; the policy exists so that a confused agent gets
a clear message instead of a 403, and so that the attempt is logged.

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
   an identity-based ruleset that no automated identity can bypass, with no
   agent process holding a human credential. Auditors were told the cap and
   split are the corrective actions; the record has to say otherwise before
   the instance does.
1. Deploy Phase 1. Every later step waits on this: with the old code live,
   restoring `contents: write` hands agent runs a human token that can merge
   again, and the humans-only ruleset denies the merge button because the
   old code merges with a non-bypass identity. The new code fails closed
   while the permission is still read-only (bot token cannot push; loud
   warning), so deploying first opens nothing.
2. Restore `contents: write` on the installation (approve the updated
   permissions in the org).
3. Add the humans-only ruleset to every covered repository, bypass list
   and bypass mode copied from the existing integrity ruleset, plus the
   `DeployKey` bypass where a release workflow pushes `main`. Leave the
   integrity ruleset untouched. Verify on a scratch repository first, and
   verify the merge, not only a push: a bypass human merges a pull request
   through the deployed merge button, and an installation token is refused
   on merge and on a push to `main` but pushes a feature branch. Push bypass
   and merge bypass are evaluated separately. See the first open question
   before applying this to `opensession` itself.
4. Unset `OPENSESSION_GITHUB_PUSH_TOKEN`; revoke the transport token. Revoke
   and remove every other ambient credential on the host.

After this, humans merge from the UI again and no bot identity can touch
`main`. Until step 1 lands, agents in owner-started turns hold the owner's
token, and the humans-only ruleset does not bound that token; Phase 1 is
what closes requirement 2.

**Phase 1, credentials and policy**

4. Every agent run gets `githubCodeRunEnv(cwd)`; `githubRunEnv(user)` and the
   user-token projection into runs are deleted. Fix-round handoff turns and
   owner-started turns land on the same path, which closes the `"GitHub"`
   sender bug as a side effect. Ask-mode `github-*` runs keep the #325 read
   path untouched.
5. `githubCredentialUser` decides Delegate versus Automation for every turn,
   defaulting to Automation for any sender that is not the session owner or
   an auto-continue of the owner. Delegate turns get `open_pull_request`
   and `edit_pull_request`; the tools run the request server-side with the
   owner's token and refuse repositories outside the session.
6. Give ordinary code automations the Automation credential plus a
   `PublicationPolicy`, so they open real PRs instead of pushing with an
   ambient identity.
7. Inject the credential-helper env shape into every run, read token for
   Reviewer, code token for everything else.
8. Extend `PublicationPolicy` to every agent run as a refusal, with the
   Delegate hint toward `propose_merge`. Render the merge card in every
   client from the same `pr-merge` route the Merge button uses.
9. Delete the transport-token plumbing and its docs section. Fix
   `audited()`.

**Phase 2, product**

10. Boot-time posture log and a Settings → Integrations panel that shows
    installation permissions and missing rulesets per repository.

**Phase 3, isolation**

11. Run hosts under a separate uid, or Sandboxes by default for interactive
    sessions, so the human token store and the App key are unreadable from
    agent bash.

## What this removes

- The "Separate git-transport credential" mechanism and its four code paths.
- The contents-narrowing in `githubAppMintPermissions`.
- The rule that ordinary automations get no GitHub credential, replaced by
  "every agent gets a bot credential sized to its principal and a
  publication policy".
- The owner's token in the run environment (`githubRunEnv`, `githubAuthEnv`
  for runs, the Sandbox auth-file projection).
- The claim that "no credential on the host can merge". The claim becomes "no
  agent process holds a credential that can update `main`, and the only
  credential agents hold is one the rulesets refuse on `main`".

## Open questions

- **The `opensession` repository's own development model.** Sessions push
  the shared checkout's `main` directly and the host self-builds from those
  pushes. A humans-only ruleset on `opensession` `main` breaks that unless
  session pushes carry a bypass identity, and under this design a session's
  own push runs as the bot. The options are: keep `opensession` on the
  integrity ruleset only and accept that the bot can update its `main`
  through a PR-less push; route the shared-checkout push through a server
  route that uses the session owner's token, which limits direct pushes to
  bypass members; or move `opensession` to PR-only like every other
  repository and let `deploy_self` promote merged commits. This is a
  workflow decision for Michiel and it gates Phase 0 step 1 for
  `opensession`. Under this design every session push runs as the bot, so
  the humans-only ruleset would stop the shared-checkout push outright; the
  gateway-route option (a `push_main` tool behind a card, owner's token) is
  the one that keeps the current model.
- Should the humans-only bypass list be copied from the integrity ruleset,
  as proposed, or narrowed to one team? Copying changes nothing for humans
  and keeps this change about agents. Narrowing is a people decision that
  belongs with the compliance record, not here.
- Simple mode (one person, personal App) has one token for every principal,
  Automation included. The rulesets still hold; the Delegate versus
  Automation split does not. Acceptable for a single-user install, worth
  stating in the docs.
- Code Storage hosts have no rulesets. Their "pushed branch is the change
  request" model already keeps agents off the mainline; document it as the
  equivalent.
