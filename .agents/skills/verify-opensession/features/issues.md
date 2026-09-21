# Issues

Issues lists open GitHub issues from registered repositories. Users search and filter the list, inspect an issue in a responsive preview, and start or reopen its linked session.

## Sub-features

- `issues-list` groups open issues by recent activity and shows linked-session state.
- `issues-search` filters by title, number, author, repository, or label.
- `issues-filter` narrows the list by repository when more than one is available.
- `issues-preview` opens the issue body and metadata without leaving Open Session.
- `issues-session` starts a session for an unassigned issue or opens an existing one.
- `issues-phone` presents the same list and preview at phone width.

## How to get to it (user POV)

- Choose `Issues` in the sidebar when the tool is enabled.
- Open `/issues` directly.
- Use the command menu and choose `Issues`.
- Choose an issue row to open its preview, then choose `Start session` or `Open session`.

## Driving it with verify-opensession

Preconditions:

- Doctor passes for the isolated demo run.
- The demo seed exposes issues including `Upload retries stall after the third attempt` and `Add keyboard shortcut for archiving a todo`.

- **Open the list.** Run `verify-opensession browser "$RUN_ID" open --route /issues --width 1440 --height 900`. Wait for searchbox `Search issues`, then take a snapshot after `Loading issues` disappears. The list contains the seeded issues.
- **Search.** Choose the button named `Search issues`, fill searchbox `Search issues` with `dark mode`, and confirm only the matching issue remains.
- **Open a preview.** Clear the search, take a snapshot for the current full row name, and choose `Add keyboard shortcut for archiving a todo`. Wait for dialog `Issue: Add keyboard shortcut for archiving a todo`. The preview shows its body, repository, issue number, and session action.
- **Check phone layout.** Repeat the list and preview at 390x844. The preview becomes a full-height sheet with `Close issue` and its session action reachable.
- **Proof.** Save the loaded list, filtered list, preview, and phone preview as accessibility snapshots and screenshots.

## Gotchas

- Issue row names include repository identity, issue number, state, and relative time. Snapshot before clicking instead of hard-coding the whole dynamic name.
- The demo issue feed is synthetic, but starting an issue session crosses the GitHub assignment boundary. Do not use `Start session` as demo proof. Prove the action is present and report external execution as unproved.
- `Open session` proves navigation to an already linked demo session, not creation of a new issue session.
- The repository picker is hidden when every visible issue belongs to one repository.
