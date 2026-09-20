---
name: auto-capture
description: Record a short production demo of this session's shipped PR using Tella's remote auto capture. Use when the user says "run auto capture", "auto capture", "record the PR on prod", or invokes /auto-capture. Infer the demo from session context, verify it is live, start the recording, and return the video link.
---

# Auto capture

Turn the work in this session into a short screen demo on production. The user
should not need to write a script or repeat the PR context. This is an explicit,
on-demand action, not something to run automatically after every merge.

## 1. Recover the context and check production

- Read the session's goal, implementation summary, linked PR, and verification
  notes. Inspect the PR description and changed files if necessary. In a
  multi-repo session, use the repo that owns the change, not whichever checkout
  happens to be primary. Qualify PR references outside the primary repo as
  `<repo>#<number>`.
- Infer the production origin, exact feature route, intended audience, and one
  user-visible benefit. Use known deployment configuration or session evidence;
  never invent the URL, fixture IDs, or navigation. If multiple PRs or targets
  remain plausible, ask one focused question.
- Verify the PR is merged **and its change is deployed to production**, using
  deployment/release evidence for the merged revision and, where accessible,
  the live feature. A merged PR or green CI alone is not deployment proof. For
  direct-to-main work, use the published commit instead of requiring a PR.
  A user's explicit confirmation that this change is live is usable evidence;
  record that basis rather than claiming you independently verified it.
- If it is not live or production cannot be identified, stop with the specific
  blocker. Do not merge, deploy, flip feature flags, or substitute a preview,
  localhost, Portal, or staging URL just to make a recording possible.
- Pick an existing safe demo account/resource on production, if needed. The
  remote browser does not inherit this session's cookies or local browser
  login. An internet-reachable URL is not proof of authenticated access. If
  access is missing, ask for an approved demo access route; do not copy cookies,
  tokens, passwords, or customer data into URLs or capture instructions.
- If the change has no meaningful visible demo (for example, an internal
  refactor), explain that rather than inventing a product benefit or filming
  an unrelated page.

## 2. Write the demo brief yourself

Aim for **30–60 seconds**, one user journey, and 3–5 deliberate actions. This is
a pacing request, not a guaranteed tool duration. Briefly tell the user what
you will record, then proceed without requiring script approval unless a
blocking access or safety decision remains.

The remote author does **not** have this conversation. Supply a self-contained
`instructions` brief, distilled from the PR rather than a raw diff or transcript:

```text
Make a concise 30–60 second screen demo of [feature] on production.
Audience: [who benefits]. Main point: [observable improvement].
Start at [exact production URL], using [approved non-sensitive demo resource].
1. Establish [starting state] so the viewer can understand the feature.
2. [Action using the actual visible control label].
3. [Action that demonstrates the new behavior].
4. Pause on [observable result] long enough to read it.
Keep the cursor deliberate, text readable, and navigation minimal. End on the
result, not a tour of unrelated settings. Do not claim behavior you cannot see.
Stay on this journey and use only the approved demo resource. Do not send,
publish, purchase, invite, delete, or change access or account settings. Do not
show secrets, customer records, inboxes, or unrelated private information.
If login, missing data, a feature flag, or an unexpected state blocks the demo,
stop and ask for guidance rather than guessing or working around access controls.
```

Adapt the beats to the actual feature. Default to read-only interactions;
production mutations require explicit authorization for the exact demo action
and resource. Include those limits in the remote brief too. Do not promise
voiceover, captions, or editing controls the tool does not offer.

## 3. Start Tella auto capture

Discover the **production Tella MCP** tools with `mcp_search` before calling
`mcp_call`. Search for `start_auto_capture` and `get_auto_capture_status`; use
the returned names and live schemas exactly. Do not use `tella-stage` or the
internal support recording-recovery tools as substitutes.

The expected contract is:

- `start_auto_capture`: `targetUrl`, optional `instructions`, `storyId`,
  `guidance`, and `guidanceKind` (`answer` or `correction`). Returns `workflowId`.
- `get_auto_capture_status`: `workflowId`. Returns `status`, optional `storyId`,
  `progress.phase`, and an `outcome` with `result`, `sceneId`, or `question`.

The live schema is authoritative. If discovery does not expose these tools,
stop and explain that the session needs the production Tella connection and
an account entitled to auto capture (the `autoCapture` feature). Do not bypass
MCP access controls with direct HTTP calls or change account entitlements.

Start **one** capture with the production `targetUrl` and the brief in
`instructions`. Omit `storyId` to create a new video unless the user explicitly
asked to append to an existing one. Creating a recording does not authorize
making it public: use only organization-controlled storage and keep access
restricted. If the tool's destination/sharing policy is unknown, establish that
it is private or organization-only before starting; never upload to public hosts.

Save the returned `workflowId`, target URL, brief, PR/commit reference, and any
returned story ID in the conversation for continuation. Start is **not
idempotent**: a timeout or lost response is not permission to create a duplicate.
Recover the existing run if possible; otherwise report the uncertainty.

## 4. Follow through without blocking the session

Check `get_auto_capture_status` once. If still `running`, use
`opensession-schedule` to schedule a later status check in this same session,
including the workflow ID and instruction to check the existing run, not start
a new one. End the turn with an honest “recording in progress” update. Do not
sleep, busy-poll, or leave a shell loop running. If scheduling is unavailable,
report the workflow ID and that another status check is needed; do not promise
an automatic follow-up you did not arrange.

Handle the result explicitly:

- `completed` with `outcome.result = delivered`: the clip was appended. Record
  the returned `storyId` and `outcome.sceneId`. Use Tella's discovered video
  lookup tool to get the existing viewer/editor URL and confirm sharing is
  restricted; do not fabricate a URL or enable public sharing. Review the clip
  if available and say whether you actually watched it. Delivery alone is not
  proof that every requested action was shown.
- `completed` with `outcome.result = needs_guidance`: this is **not a finished
  demo**. Read `outcome.question`. Answer from established session facts if
  possible; otherwise ask the user that question. For a follow-up, reuse the
  returned `storyId`, original target and instructions, and send the answer in
  `guidance` with `guidanceKind: "answer"`. If no story ID was returned, resolve
  the existing video before retrying rather than accidentally creating another.
- `failed`, `cancelled`, or completed without a delivered outcome: report the
  available reason and identifiers honestly. Do not retry automatically.
- If the user requests a correction to a delivered clip, reuse its story and
  send `guidanceKind: "correction"` with their feedback. This appends a clip;
  do not delete or replace existing footage without permission.

Finish concisely with the Tella video link, what it demonstrates, and the PR or
commit reference. Mention any missing beat, access limitation, or unreviewed
playback. Do not post to Slack, comment on the PR, or export/upload elsewhere
unless separately requested.
