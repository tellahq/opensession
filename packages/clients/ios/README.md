# Open Session native app

A shared native SwiftUI client for an Open Session server on iOS 26+ and macOS
26+. The deployment default is the `OS1DefaultServerURL` Info.plist value
generated from `project.yml`; users can override it in Settings. The v0.1
client can sign in with a token, show live sessions, stream an agent's work,
send prompts, and answer blocking questions.

Pure SwiftUI with SwiftStreamingMarkdown for CommonMark/GFM rendering. See
`project.yml` for the authoritative deployment targets.

## Features (v0.1)

- **Sessions list:** polls `GET /api/sessions` every 5s (matching the web UI);
  flat single-line workspace rows with live/PR status marks and a running-time
  ticker, larger mobile type, and the web client's warm dark palette. Inbox
  keeps Active work in stable creation order with a nearby Snoozed shelf,
  sharing `/api/snoozes` with the web sidebar. Activity restores Needs action,
  Recent, Yesterday, and Earlier; Status remains the dynamic lane view. Group
  by project is an independent switch for all three modes. The
  compact toolbar search/filter finds session metadata
  and conversation text through `/api/sessions/search`. iOS long-press actions
  include details, rename, sharing, pull request, pin, hide, Snooze/Unsnooze,
  and Archive. Swipe right pins; swipe left offers Snooze and Archive.
  Pinned rows are lifted into a Pinned band at the top in the user's own order,
  sharing `/api/pins` with the web sidebar. Pinning is quick access rather than
  a status, so a pinned row also stays in its normal band below, and archiving
  a row drops its pin. Hiding is the personal counterpart to archiving (which
  is global): it drops the row from THIS user's sidebar — here and in the web
  one, sharing `/api/hides` — while the session keeps running for everyone else.
  A hidden row comes back while one of its sessions is blocked on a question,
  prompting in a session clears its hide, and search ignores hides, so a hidden
  row stays findable and its menu offers "Restore to my sidebar". An open
  teammate, automation, or spawned session can also be claimed from its native
  action surface with "Add to sidebar", sharing `/api/lanes` with the web.
  Unread rows
  read like the web sidebar's, off the same shared store (`/api/reads`): a row
  whose sessions carry activity past your last read goes semibold at full label
  strength instead of the usual dimmed medium, and reading a session here clears
  it in the browser too. Only sessions you have opened can be unread — the mark
  means "new since you read it", not "never seen".
  Teammate @-mentions use the server's durable `/api/mentions` store: they admit
  cross-owner work to My sessions, lift its workspace into Needs action in Inbox
  mode, and show the sender's face with an @ badge. Opening the session clears
  the mention across the native and web clients.
- **Feed** (iOS) — recent merged pull requests and commits in one page, with
  person and project filters.
- **Tasks** (iOS) — the shared `/api/todos` list, with actions to add, complete,
  reopen, and drop tasks.
- **Catch up** (`CatchUpView`, `CatchUpDeckView`, `CatchUpCardView`,
  `CatchUpQueue`, `CatchUpViewModel`) — a card deck over everything unread,
  opened from the bottom toolbar beside the Desk; an unread queue uses the
  filled accent icon. Filter and New Session remain top-right controls. One
  card per unread
  _workspace_ (the same grouping the list shows,
  built by `CatchUpQueue` from the shared `/api/reads` marks with the web
  deck's rules: yours, not archived, not an automation, not the Desk). The card
  renders the workspace's main chat with a compact title, state and repo header,
  an expand control, and an inline reply field delivered through the `Outbox`.
  Full-width **Archive**, **Keep unread**,
  and **Mark as read** buttons sit below it; swipe left still archives and swipe
  right still marks read. The whole stack is a function of one horizontal drag value: tilt,
  stamp, tint, and how far forward the card behind has come, so a half-swipe
  reverses continuously; release uses Apple's
  momentum projection to decide, then hands the finger's velocity to the
  spring. Every decision is undoable for six seconds from the top bar. The queue is frozen
  once built, and `settle` waits for both the sessions list and the read marks
  before it is willing to say "All caught up".
- **Reports** (`ReportsView.swift`, `Report.swift`) — an optional row in the
  iOS tools band. It starts hidden when the account has no explicit tools
  preference. When enabled and at least one automation has published, it opens
  one row per automation, selecting its newest document first and keeping older
  documents in that document's own bar.
- **Tool visibility** (`SidebarTools.swift`, `SupportLocation.swift`) — Feed,
  Tasks, Catch up, and Reports use the account's `sidebar-hidden-tools` ui-pref,
  which the web sidebar writes as well. Support combines that tool preference
  with `sidebar-hidden-feeds` as one sidebar / page / off choice, with
  the sidebar winning any older state where both are visible. A missing tools
  value means the shared defaults. Ids this app has no screen for ride the
  value untouched so a change here never disturbs the browser. Long-press a
  visible row to hide it; Appearance restores it.
- **Session view:** live transcript over the `/ws` WebSocket, grouped into
  turns the way the web viewer groups them: **question → folded work → answer →
  footer**. A turn's tool calls and the narration between them collapse behind
  one header. Phones keep that header to outcome, duration and failure count;
  opening it reveals steps, tool families and changed files. Wider layouts also
  show the richer fingerprint inline. The turn's final answer escapes the fold
  and renders as a normal message. On phones, one changed-files summary
  replaces the footer chip cloud while opening the same Changes panel. Team
  notes sit in that timeline without entering the agent context. The
  yellow composer mode posts them directly to the team and offers only the
  author edit and delete actions.
  Tool rows use the server's presentation metadata for canonical names,
  humanized MCP server/tool labels, glyph families, summaries and ±lines; the
  native derivation remains as an older-server fallback. Expanding one renders
  the tool's own shape: a unified diff
  for an edit, the command for a shell call, file content for a write.
  Routine calls fold into one `N steps` run, and consecutive edits to the same
  file into one row — the path once, the summed ±lines, and a `×3` count —
  both opening to the individual calls.
  Transcript videos stream inline on both platforms. Tool-result screenshots
  and recordings marked as featured stay visible when their work fold closes,
  while incidental media remains inside the producing tool row.
  A `Task` row opens the sub-agent's own transcript in a sheet (polled while
  the worker runs, via `GET /api/sessions/:id/subagent/:agentId`), and a
  footer's file chip opens that file's diff for the turn. A published
  walkthrough (demo recording, writeup, before/after stills) renders as a card
  under the turn that published it. `bks-…` session ids in agent output become
  links labelled with the referenced session's title, and tapping one opens
  that session in the app (falling back to the web app for a session this
  client hasn't polled).
  Long answers clamp with `Show full message · 12 KB` (wire-clamped entries
  refetch on demand), system events are toned by severity, and a floating pill
  offers the way back down — reading `New messages` when output arrived while
  you were scrolled up. On wide pointer layouts, a native rail indexes the
  current person's sent messages; hover previews one and activation jumps the
  transcript to it. It stays hidden on iPhone and compact widths. A selected
  Markdown passage stays highlighted as
  composer context, then rides with the next prompt, team note, or scheduled
  message as a block quote. When the server offers `reply_suggestions`, the
  idle composer shows optional quick-reply chips; choosing one adds its full
  text to the draft for editing rather than sending it. The Personal setting
  shares the web client's `reply-suggestions` account preference. `stream_text`
  provides token-level streaming when Settings → Personal → Preferences → Live
  typing is on; it defaults off. A horizontally scrollable session tab strip
  appears when a workspace/worktree contains multiple sessions. Its history menu
  queries only that workspace's closed siblings and restores one directly into
  the strip. A workspace down to one session draws no strip, so that history
  moves to the Closed sessions submenu of the session's overflow menu, which
  reopens a row the same way. On macOS, where the sidebar is the live-session
  switcher, the same scoped history lives in the selected session's toolbar
  instead. On iOS, the PWA-style Liquid Glass action bar floats above the
  composer with Archive, session actions, New session, and Next chat. It stays
  directly above the composer when the keyboard opens. The actions menu carries
  worktree details, the pull request panel, Add to sidebar when needed, rename,
  share, hide or restore, and archive, matching the sidebar row's long-press
  menu. A bounded cache keeps
  recently visited conversations loaded while their
  off-screen sockets remain disconnected, so returning to a page does not show
  a loading screen. Fenced Markdown, expanded tool inputs and code assets use
  the PWA's GitHub light/dark syntax palette. Native-owned code surfaces show
  plain text immediately while highlighting finishes and keep large files plain.
  ```mermaid fences render as diagrams (see "Mermaid diagrams" below).

  ```
- **Workspace details** — tapping the session title opens a native worktree sheet
  with repository and branch metadata, local git status, changed files, a
  color-coded pull request card for checks, review state and conflicts,
  workspace context, a Conversation filmstrip for pictures and recordings,
  native preview frames for visual session assets while documents and data keep
  their file rows, model/reasoning controls, and live remote
  sandbox status. Sandboxed workspaces expose explicit pause, wake, and
  confirmed recreate controls without embedding the web client. Its Effective
  config section resolves the next turn's model, engine, account, MCP access,
  instructions, and permissions, with the source under every displayed value.
- **Session panels** — on iOS, Assets, individual assets, PR, Changes, Portals,
  Terminal, and Agents open ONE LEVEL DEEPER on the stack that is already there,
  not as tabs and not as sheets: the chevron and the edge swipe are the way
  back, and nothing is left open to close later. Portals opens and controls
  exposed services. Terminal creates a new shell in the session's worktree and
  closes it when the panel disconnects. A `SessionPanel` names the kind;
  `SessionPanelView` draws it, so a new kind lands in both hosts (the session's
  stack and the workspace sheet's) at once. Pushed through the `openPanel`
  environment action from the transcript and the overflow menu, and directly
  by the workspace sheet's own rows — which push within the sheet, so that page
  stays where it was.
- **Agent runs**: the Agents panel reads every workflow a session started and
  updates each run immediately from `workflow_update` socket frames. A 3-second
  poll remains while a run is live for compatibility with older servers.
- **Changes** — every file the worktree has touched, and the diff of any one of
  them, reached from the overflow menu or the workspace sheet (whose file rows
  open that file directly, and whose "Show all N files" replaces what used to
  be a note pointing at the browser). One `GET /api/sessions/:id/diff` answers
  the file list and the whole worktree's patch together, so a file's diff is a
  split of what is already in hand (`PatchSplitter`) rather than a request per
  row — the split runs once per load, off the main actor, into a path-keyed
  index. A session spanning several repos gets a repo switcher; binary files
  and a truncated patch say so rather than pushing an empty page.
- **File paths in the transcript are links** (`FileLinks`) — a path an agent
  names in its own prose opens that file's diff, so the file you are reading
  about is one tap away instead of a trip through the overflow menu. Only
  paths the session's own tools touched are linked, registered per session
  from the transcript, which keeps a link and its target in step: the link
  always lands on a diff that exists, and prose that merely looks like a path
  is never touched. Any trailing part of a path is a way to say it
  (`pr.ts` → `packages/core/opensession-server/src/server/pr.ts`) unless it names two touched files, in which
  case it names neither. Rewritten to markdown just before rendering, so
  copying a message still yields what the agent actually wrote — and a path in
  backticks loses them, because the renderer keeps a code span's own styling
  over the link's and a tappable thing has to look tappable. This reaches the
  rows that render markdown; a user bubble and a recap are plain `Text`.
- **Assets** — the session's scratch artifacts (`GET /api/sessions/:id/assets`)
  reached five ways: the "Open" chip on a `write_asset` tool row (straight to
  that file), the chips under the turn's answer, the name of the file in the
  answer's own prose (`AssetLinks`, the same rewrite as `FileLinks` on its own
  scheme), the workspace sheet's assets section, and the overflow menu.
  HTML and media render in a `WKWebView` pointed at the raw route — the
  session token rides in as a cookie scoped to that session's assets path, so
  relative references between assets resolve — while markdown and code render
  natively.
- **Prompting** — durable sends enter the on-device `Outbox` before the
  composer clears, then use the idempotent REST prompt route so delivery has an
  acknowledgement. The local message appears in the transcript immediately;
  offline retries and refusals keep their status and actions attached to that
  bubble, including across relaunches. Server-accepted busy sends move into the
  queue, exactly like the web UI. Stop sends `cancel` for the watched session.
  The floating glass composer uses a
  progressive material fade so transcript content recedes cleanly beneath it;
  its full surface focuses the field and keeps a comfortable keyboard gap.
- **Dictation** — the composer's mic (first of the trailing controls, ahead of
  stop, every session) is speech to text, not a call: `Dictation.swift` runs
  `SFSpeechRecognizer` over an `AVAudioEngine` tap and streams the utterance
  into the draft, appended to whatever was already typed. It asks for
  on-device recognition wherever the hardware supports it, since drafts carry
  customer and ticket detail that the server-side route would send to Apple.
  The recognizer object is owned by `SessionInputBar`, not the button: a long
  dictation wraps the composer to its two-row layout, which swaps the branch
  the button renders in and would otherwise destroy its state mid-sentence.
- **Session creation** — a full-height prompt editor with attachments and a
  compact single-row iOS toolbar for repository, mode, and model settings. The
  same controls move into the keyboard accessory while the prompt is focused,
  with an 8pt gap above the keys so attachments, options, model, and dictation
  remain reachable and visually separate while typing.
  Opening a file with OS from Files or another app starts a fresh composer with
  that file attached. Images use the vision channel; other files upload to the
  session's staged file channel before Start becomes available.
- **AskUserQuestion:** blocking questions render as an inline card with option
  buttons + free-text answer, wired to `answer_question`. After you submit, the
  card becomes a read-only receipt showing the question and your answer.
- **PR panel** — sessions with a pull request expose a row in the title-opened
  workspace sheet and the overflow menu; it opens a panel with state, review
  decision, conflicts, every check with its status, and reviewers, via
  `GET /api/sessions/:id/pr`. While the PR is open it also carries the web
  panel's actions, on the same routes: **Review** (approve / request changes /
  comment with a summary, plus the "squash and merge after approving"
  shortcut, `POST …/pr-review`), **Merge** (squash, merge commit or rebase,
  behind a confirmation that names what it would land on top of — conflicts,
  failing checks, a draft, requested changes — `POST …/pr-merge`), and
  **Close pull request** (`POST …/pr-close`). The session overflow menu also
  exposes squash, merge-commit and rebase merge actions directly, with the same
  warnings and confirmation. PR surfaces can copy the GitHub link or open an
  editable Slack post that appends the link and defaults to the server-selected
  channel (`#os`, then `#engineering`, then the first configured channel), and
  sends through the signed-in person's Slack account. After merge, that sheet
  becomes the shipped-change composer: it suggests copy from the walkthrough,
  preloads its after image, accepts up to 10 images, and reconnects Slack when
  the person's existing grant lacks image access. Agent-requested Slack
  composers settle into a sent or cancelled receipt; sent receipts keep the
  channel and an **Open in Slack** link. A workspace row's
  long-press menu also rolls the
  cached PR state into one next action: merge when ready, fix failed checks,
  resolve conflicts, address feedback, view running checks, or archive after it
  lands. `git_pushed` and matching `pr_updated` socket frames re-fetch these
  PR surfaces immediately, including attached, linked, and discovered branches.
  Each action needs a GitHub credential server-side,
  which with web sign-in on is the signed-in person's own token,
  so an unconnected account gets the server's "connect your GitHub account"
  sentence in the panel rather than a status code. It is
  pushed as a panel (`PrPanelView(chrome: .pushed)` drops its own navigation
  stack and Done button); the sheet form is what the Mac still uses.
- **New session** (`NewSessionView.swift`): the repo sits across the top, the
  prompt fills the middle, and run controls sit in the footer. On iOS, Code is
  the quiet default, so there is no default New branch chip. Ask and Sandbox
  choices from `GET /api/sandbox/status` sit under More options, while dictation
  stays at the trailing edge. Sandbox names match the web palette, and the host
  is sent as an explicit `local` so the menu and session always agree. The Mac
  keeps its mode and Sandbox chips where the wider footer has room. Choosing a
  Runner is not offered because the web palette also dropped runner-at-create.
  On macOS, when the prompt is empty, **Start from a recipe** loads
  `/api/library` and prefills the editable prompt, mode, and any still-available
  model.
- **Action Button / Siri / Spotlight — "Start an Agent"** — one App Intent
  (`Intents/StartAgentIntent.swift`), and it deliberately OPENS the app
  (`openAppWhenRun = true`) rather than collecting the idea in the system's
  text dialog and firing a session off in the background: dictation mishears,
  and an idea usually wants a glance at which repo and model it is about to
  run on. The press brings the app forward with the new-session sheet already
  open and the mic already listening — speak, watch the words land, fix what
  the recogniser got wrong, and still have the repo/mode/model chips and
  attachments before you send. The intent parks its request on `QuickCapture`
  (it can run before any view exists on a cold launch) and the sessions list
  consumes it once. The mic itself is a `ComposerDictationButton` in the
  sheet's footer — it only auto-starts when speech + mic permission already
  exist, so a first press isn't two system prompts stacked over the composer.
  `AgentShortcuts` registers it with no setup: Siri phrases ("Start an agent
  in OS"), Spotlight, and the Action Button's shortcut picker
  (iPhone Settings > Action Button > Shortcut > OS > Start an
  Agent) — those all read the app's label, which is OS. Settings >
  Shortcuts inside the app signposts all of it.
- **Widgets** (`OS1Widgets/`, its own iOS app-extension target) — the same
  press from three more places: a Home Screen widget (systemSmall), a Lock
  Screen one (accessoryCircular/accessoryRectangular), and a Control Center
  control, which is also what the Action Button's picker lists under Controls
  — so binding it needs no shortcut at all. Every one of them runs
  `StartAgentIntent`, the file the extension shares with the app. The
  extension holds no token and shares no container with the app: it is a door,
  not a dashboard, so a widget can never show stale sessions or fail offline.
  A second bundle id means a second App Store profile ("OS1 Widgets App
  Store"), which CI fetches from App Store Connect at build time
  (`ci/fetch-provisioning-profile.mjs`) rather than carrying as a secret.
- **Live Activities** — an optional, device-local switch under Settings →
  Notifications shows one aggregate of the signed-in person's running and
  unread sessions on the Lock Screen and Dynamic Island. It renders at most
  three privacy-sensitive active titles plus the active and unread counts,
  opens an individual session through `OpenSessionIntent`, and stays visible
  after the last run finishes while work remains unread. Foreground state is
  reconciled from the existing sessions poll and shared `/api/reads` marks;
  background starts and updates use ActivityKit push tokens registered with
  `/api/live-activities/*`. A separate device-local switch can put that same
  unread session count on the iPhone Home Screen and Dock icon without enabling
  alert banners or sounds.
- **Connection care** — client-initiated pings every 10s and reconnects when
  no inbound frame arrives for 30s. The server never initiates pings. An
  announced server restart uses a 250ms retry cadence until the replacement
  handshake arrives; ordinary outages retain the calmer 2s backoff. The UI
  shows a reconnect banner and keeps an optimistic local echo of prompts until
  the server's copy arrives.
- **Settings** — native SwiftUI Tools, Personal, and Workspace administration,
  plus multi-organization server/GitHub/token configuration and a connection
  test. The top-bar logo on iOS and the row above Feed on macOS switch servers
  and show the active connection; each account keeps its own keychain token, and
  passive WebSockets remain connected for inactive accounts
  while the app is active so mentions can badge the picker. Cross-device
  composer and session preferences refresh at launch and when the app foregrounds.
  On macOS, custom account keyboard bindings drive the supported app commands and
  their command-menu hints; iOS keeps its system shortcut and widget guide.
  Infrastructure → **Runners** lists the machines this instance trusts, read
  only: each one's status, hardware, workspace roots, toolchains and what it is
  working on. Connecting, revoking and permissions stay in the web settings —
  a Runner is paired by a command typed on the machine itself. The status word
  comes from the same `RunnerStatus` vocabulary the Runner card in Workspace
  details uses, so a machine reads the same way in both places.
- **Desk** — a standing per-user concierge session (`POST /api/desk/ensure`
  get-or-creates it), summoned as a sheet from a toolbar button next to the
  sessions list (iOS: `lamp.desk` toolbar item; macOS: the same button in the
  sidebar header). It's an ordinary `SessionView` under a compact header, so
  everything the session view already does — streaming, tool folds, questions
  — works there too. Voice mode is opt-in under Settings → Personal →
  Preferences and syncs through the account's `desk-voice` ui-pref.
  `DeskVoiceEngine` asks the server for a short-lived Realtime client secret,
  then connects directly to OpenAI over a raw WebSocket. The long-lived OpenAI
  key never reaches the app, and the call is torn down whenever the app leaves
  the foreground.
- **Support** (`SupportView.swift`, `SupportViewModel.swift`) — the Plain
  queue lives in exactly one chosen location. `In the sidebar` draws a `Plain`
  source row on iOS and macOS; `Its own page` draws the iOS `Support` tool row
  and the macOS header/palette entry; `Off` draws neither and stops polling.
  Appearance writes both `sidebar-hidden-tools` and `sidebar-hidden-feeds` in
  one update so the web and native clients stay on the same choice. Two
  screens: the Todo queue in Plain's four
  priority lanes (`GET /api/plain/threads`), and one ticket's timeline
  (`GET /api/plain/threads/:id`) with the customer on the left, us on the
  right, and notes full-width in between. The composer's Reply / Internal note
  control posts to `…/reply`; the ⋯ menu covers done, snooze (1h/4h/1d/3d/1w)
  and reopen. Attachments come through the server's proxy — Plain's own signed
  URLs expire in ~3 minutes, and the proxy needs our bearer token, so images
  are fetched as data rather than handed to `AsyncImage`.
  Send the raw text: the reply's sign-off and the `**Name (via …):**` prefix on
  a note are added server-side (`routes/plain.ts`), and the app unpicks that
  prefix again when rendering (`SupportNote.unpick`). The reply response's
  `sentAs` is surfaced, because `"system"` means it went out as the workspace
  bot rather than as you. A reply emails a real person and the route has no
  idempotency key, so sends are one at a time and never retried automatically.
  Polling only (20s on an open thread, stopped when it closes) — Plain has no
  push, and `/ws` carries session events. Not ported: assign, labels,
  priority, rename, mark-spam, and the triage hand-off.
- **Voice call** — the call itself is a full-screen surface
  (`DeskVoiceCallView`): one orb that scales with real metered loudness — the
  mic while you talk, the model's own output while it answers — the spoken
  line as live captions under it, and mute / captions / hang-up controls.
  Barge-in is server-side VAD, so talking over the model just interrupts it.
  Minimizing (the chevron) leaves the call running and returns you to the Desk
  transcript, which fills in as turns finalize; either lit mic — composer or
  header — comes back to the call, and hanging up is the only thing that ends
  it. A call is always the DESK's — `desk-voice.ts` resolves one with
  `ensureDeskSession(user)` whichever session is on screen — so it is offered
  only there, and never from a composer.
  Mute is local — capture and metering continue, frames stop leaving the
  device. The orb's level is sampled off the realtime audio threads at ~15Hz
  rather than pushed per buffer, and honors Reduce Motion.

## Mermaid diagrams

A ```mermaid fence in an assistant message renders as a drawn diagram, the same
way the web client does it — and with the same fallback: source mermaid cannot
parse keeps its code fence, which is also what an in-flight message looks like
while it streams.

There is no native mermaid. The layout engines (dagre for flowcharts, one per
diagram type besides) are most of the library, so fidelity means running the
same JavaScript the web runs: `MermaidRenderer` keeps ONE offscreen `WKWebView`,
renders diagrams through it one at a time, and snapshots each result to a PNG
that it caches by (source, theme). The transcript itself never holds a web
view — a row shows a plain `Image`, so lazy scrolling stays SwiftUI-fast and a
diagram seen once costs nothing to see again. On iOS the picture is tappable
into the full-screen viewer and pinch-zooms in place, like any other image.

mermaid ships in the app (`Resources/mermaid/`, ~3.5MB) rather than being
fetched, so diagrams draw offline and against any server; refresh that copy
when the repo's mermaid dependency moves (see the README next to it).

Three things about the offscreen page are load-bearing, each learned by
looking at a wrong picture: it must be hidden by being COVERED rather than
faded (a snapshot captures the view's alpha, so a 1%-opacity page yields a
1%-opacity diagram); the PNG must carry the scale it was captured at (PNG has
no scale, so a 3x snapshot otherwise claims to be three times its true size and
the row clips it); and the web view's scroll view needs
`contentInsetAdjustmentBehavior = .never`, or the safe-area inset pushes the
page down and the snapshot loses the bottom of the diagram.

## Signing in

Settings has in-app GitHub device-flow sign-in (`GitHubAuth.swift` —
`POST /api/auth/device`, then `/api/auth/device/poll` with `native: true`;
the server mints a web-session token and returns it in the poll body). Each
organization's token is kept in a separately keyed keychain item and rides as
`Authorization: Bearer <token>` everywhere, including its WebSocket upgrade.
Pasting a token manually still
works as a fallback: tokens are the `opensession_auth` cookie values minted
at web sign-in, stored server-side in `~/.opensession/web-sessions.json`.

## Build

On a Mac:

```sh
brew install xcodegen
cd packages/clients/ios
xcodegen generate
open OS1.xcodeproj
```

Run the `OS1` scheme on iOS 26+ or `OS1Mac` on macOS 26+. Validate changes
against both schemes.

## Architecture

````
OS1/
  OS1App.swift               App entry; forces Settings on first run
  NativePreferences.swift    Cross-device preference hydration/cache
  NativeNotifications.swift  Local notifications and the iOS unread icon badge
  PlatformCompat.swift       iOS/macOS API bridging shims
  Models/
    Session.swift            Tolerant subset of the server's UnifiedSession
    TranscriptEntry.swift    Transcript entry (REST + WS frames)
    AskQuestion.swift        Pending AskUserQuestion
    AttachedImage.swift      Composer image attachments
    AttachedFile.swift       Open-in and staged file attachments
    ModelCatalog.swift       Workspace model catalog + engine routing
    ToolPresentation.swift   Canonical tool names, families, summaries, ±lines
    SubagentTranscript.swift A Task call's sub-agent conversation payload
    SessionWalkthrough.swift The published demo carried on the session row
    SessionLinks.swift       `bks-…` ids in output -> in-app links + titles
    PathLinks.swift          Path -> markdown link rewrite, shared machinery
    FileLinks.swift          Touched paths in prose -> that file's diff
    AssetLinks.swift         Written scratch files in prose -> AssetOpen
    PrDetails.swift          PR panel payload
    SettingsModels.swift     Settings payloads (tools/personal/workspace)
    WorkspaceRunner.swift    Instance Runner list + the shared status words
    SandboxOffering.swift    What run environments a new session may choose
    AccentTheme.swift        The app's primary colour: one table of light/dark
                             fills, a derived glyph colour, and the store the
                             Appearance picker writes
  Networking/
    ServerConfig.swift       URL/name (UserDefaults) + token (keychain)
    Keychain.swift           Minimal Security wrapper
    GitHubAuth.swift         GitHub device-flow sign-in
    OS1API.swift             REST reads (sessions, transcript, health)
    SettingsAPI.swift        Settings reads/writes
    ServerEvent.swift        WS frame parsing (unknown types -> .ignored)
    OS1Socket.swift          WebSocket: bearer auth, ping loop, typed events
  ViewModels/
    SessionsListViewModel.swift  5s polling + memoized sidebar grouping
    SessionViewModel.swift       watch/stream/prompt/ask state machine
    TranscriptBlocks.swift       Turn grouping (fold/answer/footer) + fold state
    SessionViewModelCache.swift  Bounded recently visited conversation cache
  Views/
    OS1VisualStyle.swift      Shared web palette, session width, and repo tile
                              (`accent`/`onAccent` come from `AccentTheme`)
    SessionsListView.swift   List + status rows + settings sheet
    FeedView.swift           Recent merged pull requests and commits
    TasksView.swift          Shared task list
    ReportsView.swift        Automation reports and document history
    SessionView.swift        Transcript, streaming bubble, ask card, input bar
    NewSessionView.swift     Full-height create-session editor
    LibraryView.swift        Startable recipes and templates
    TranscriptRow.swift      Per-block rendering: bubbles, notices, clamping
    TurnBlockView.swift      Work fold header + turn footer + file chips
    ToolCallRow.swift        Tool rows, bespoke bodies, unified-diff rendering
    SubagentView.swift       A Task call's sub-agent transcript, in a sheet
    SessionPanel.swift       Pushed session details + the openPanel action
    AssetsView.swift         Assets list + one asset, per-kind preview
    ChangesView.swift        Changed files and diffs
    PortalsView.swift        Exposed services and controls
    TerminalView.swift       Session-scoped shell
    WalkthroughCard.swift    Published walkthrough: demo video, writeup, stills
    MarkdownBody.swift       Streaming/durable markdown rendering
    AskQuestionCard.swift    Options + free text answer
    PrPanel.swift            Pull-request overview, actions, and review entry
    PrReviewCanvas.swift     Committed diff, inline pending comments, viewed files
    WorktreeInfoView.swift   Workspace details sheet
    DeskSheet.swift          Desk sheet: header + voice controls over SessionView
    DeskVoiceCallView.swift  Full-screen voice call: orb, captions, call controls
    SettingsView.swift       Native settings index + connection controls
    RunnersSettingsView.swift  Read-only list of the instance's Runners
    Native*SettingsViews.swift  Native Tools, Personal, Workspace panels
    MacSettings.swift        macOS settings window
    Glass · ImageAttachments · UserAvatar · WebIcon  smaller shared views
  Mermaid/
    MermaidSegmenter.swift   Splits ```mermaid fences out of message markdown
    MermaidHostPage.swift    Locates the bundled renderer page
    MermaidRenderer.swift    Offscreen WebKit render + snapshot + cache
    MermaidDiagramView.swift The diagram row: code fence, then the picture
````

## Protocol notes (from the server source)

- Public paths are prefix-less: REST at `/api/...`, WebSocket at `/ws`.
- WS handshake: server sends `{"type":"hello","bootId":...}` first; the client
  sends `watch` only after that, so it can't race the upgrade.
- `transcript_init` replaces the tail, `transcript_history` prepends,
  `transcript_append` upserts by entry id (overlap expected, ~1s cadence).
  The app advertises seq and change-seq support, retains each frame's resume
  watermark, and includes it on every re-watch. Reconnects therefore replay
  only the missed gap instead of replacing history pages already on screen.
- When Settings → Personal → Preferences → Live typing is on, `stream_text`
  deltas render immediately. It defaults off; otherwise each durable part
  appears through `transcript_append`.
- `reply_suggestions` carries a session id and optional `{label,text}` choices.
  A JSON `null` suggestion payload clears the current row; a new stream or send
  clears it locally so stale replies cannot follow the next turn.
- Entries can arrive clamped (`contentClamped`); full content is at
  `GET /api/sessions/:id/entry/:entryId`. The assistant's **Show full message**
  action and expanded clamped tool results fetch it on demand.
- `presence` lists everyone watching the session, one name per socket. The
  header facepile drops our own name and dedupes devices; names resolve to
  GitHub pictures through `GET /api/people` (`TeamDirectory`).
- `{"type":"away","away":true}` is presence, not subscription: the app sends it
  whenever the scene is no longer active, so leaving the app removes its owner's
  face while the watch stays put and the transcript keeps streaming for unread
  counts and notifications. Returning to the active scene sends `away: false`.
- Presence is held while the app is active on the selected session. Reading
  without touching the screen does not make the face expire; changing sessions
  moves it, and leaving the app removes it.

## Next milestones

- Image attachments in assistant markdown
- Push-style updates for the sessions list (it polls today)
