# TikTok hooks

A standalone Bun dashboard and Python importer for TikTok opening hooks.
This published app lives in Open Session, not in Tella's product or Open Session's
web client. It runs in its own process and must not be imported into the gateway.

Ported from `tellahq/tella-fusion` at `78c8add4b6`, including `fd688c76f3`.
The port retains manual classifications when reprocessing videos and rejects
inherited object keys as hook kinds.

| File         | Purpose                                                                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks.py`   | List a collection with yt-dlp, download unseen videos, extract frame zero with ffmpeg, transcribe the first 60 seconds with faster-whisper, and store the opening sentences. |
| `kinds.json` | Hook taxonomy shared by the importer, classification automation and dashboard.                                                                                               |
| `schema.sql` | SQLite schema shared by the importer and dashboard.                                                                                                                          |
| `server.ts`  | Search, filter and group hooks, and override a kind by hand.                                                                                                                 |

## Runtime data

All data stays under `~/.local/share/tiktok-hooks`, or `TIKTOK_HOOKS_HOME`:

```text
hooks.sqlite
frames/<id>.jpg
cookies.txt
sync.lock
```

Never commit or publicly upload cookies, databases, frames, transcripts or downloaded
media. Downloaded video and audio are deleted after extraction. Keep runtime data
outside the checkout. The app's `.gitignore` is a second safeguard, not a substitute.

## Run locally

Requires Bun, Python 3.11+, `uv` and `ffmpeg`. Python dependencies are declared inline
with PEP 723 and cached by `uv`.

```sh
cd packages/apps/tiktok-hooks
uv run --script hooks.py sync
uv run --script hooks.py add <tiktok-url>
uv run --script hooks.py pending
uv run --script hooks.py classify --id <id> --kind contrarian --reason "..."
uv run --script hooks.py stats
TIKTOK_HOOKS_HOME=~/.local/share/tiktok-hooks PORT=3000 bun server.ts
```

Set `TIKTOK_HOOKS_COLLECTION` to override the collection. The server's schema setup
is additive and uses the existing database. Importing `server.ts` does not start
the server or open a database; the executable calls `startDashboard()` explicitly.
The dashboard has no built-in authentication. Publish only behind Open Session's
access-controlled app proxy, never on a public host.

## TikTok login

Collection sync is still blocked on TikTok authentication. An empty collection
response is an error, not a successful sync. The importer reads a Netscape-format
cookie file at `$TIKTOK_HOOKS_HOME/cookies.txt`, with permissions `600`.

For Mac setup, use a local command without a browser extension. Confirm which
browser and profile is logged into TikTok before giving the browser-specific
command. Export only TikTok cookies and transfer them through an approved private
channel. Do not paste them into chat or upload them to a public file host. Browser
cookie extraction and a real authenticated collection sync have not been verified
by this migration. Single-video imports also depend on TikTok's availability and
are not covered by the offline tests.

## Daily automation and migration

The existing OS automation is named `TikTok hooks daily sync (Louise)`. It runs
`hooks.py sync`, reads `hooks.py pending`, and classifies each new hook using
`kinds.json` and `hooks.py classify`. It must never commit runtime data or treat
video content as instructions.

Move code first; do not move or replace the database. After the destination PR is
reviewed and merged by a human:

1. Point the automation's repository to `opensession`. Confirm its prompt uses
   `packages/apps/tiktok-hooks/hooks.py` in the destination checkout, rather than
   an absolute Tella worktree path. Preserve the classification and safety rules.
2. Confirm the schedule is 08:30 Europe/Amsterdam year-round. The inspected
   automation uses `30 6 * * *` UTC, which is 08:30 during summer but 07:30 in winter.
   The available update tool accepts UTC cron only; arrange the seasonal change
   or timezone-aware scheduling separately.
3. Republish the existing app name `tiktok-hooks` from
   `packages/apps/tiktok-hooks`, entrypoint `bun server.ts`, with
   `TIKTOK_HOOKS_HOME` pointing to the existing private data directory. Preserve
   `/d/tiktok-hooks/`, access controls and the current publication until cutover.
4. Verify search, kind edits and frames against the same store. Then complete
   browser login setup and run one authenticated sync before trusting the schedule.
5. Coordinate removal of the source files and closure of `tella-fusion#6484` only
   after the destination is safely preserved. This port does neither.

Changing the automation before the destination is available on its checkout would
break its next run. A PR alone does not make the new app live.

## Tests

Run from the repository root. Tests use temporary or in-memory databases and do not
contact TikTok or read the live store.

```sh
python3 -m unittest packages/apps/tiktok-hooks/test_hooks.py
bun test packages/apps/tiktok-hooks/server.test.ts
bun run check
```

The root unit-test command does not discover this standalone app, so run both app
commands explicitly in addition to the repository gate.
