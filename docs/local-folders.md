# Local folders

A session can work in a folder on your own computer while the agent keeps
running on the Open Session server. The pattern is sometimes called "local
hands": the session reaches for the folder only when a task needs it, and reads
and edits the files where they are.

## Connecting a folder

In a session, open the composer's **+** menu and choose **Connect a folder…**,
then pick the folder. It appears as a chip above the composer. From the chip
you can turn **Allow edits** off to make the folder read-only, or
**Disconnect** it. You can connect several folders to a session and the same
folder to several sessions.

When starting a session, choose **Connect a folder…** from the new-session
box's **⋯** menu. Picked folders show as chips above the prompt and are
connected the moment the session is created, so its first turn can already
use them.

Where it works:

| Client         | How                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Mac app        | Native bridge. Grants survive restarts. Deleting moves files to the Trash.                                             |
| Chrome or Edge | File System Access API. After a browser restart, click the folder chip to allow access again. Deleting is not offered. |
| Safari, phone  | Cannot hold a folder. You can still steer a session whose folder another device holds.                                 |

The folder is reachable only while the app or tab that connected it is open
and online. If the computer sleeps or the app closes, the session keeps
running but its folder tools fail with a clear message, and the chip shows the
device as offline.

## What the agent gets

The `opensession-local-folders` tools: `list_local_folders`, `local_list`,
`local_read`, `local_search`, `local_write`, `local_edit`, `local_move`,
`local_trash`, `copy_from_local_folder`, and `copy_to_local_folder`. There is
no shell on your computer. To process a PDF or a spreadsheet, the agent copies
the file into the session's scratch directory, works on it there, and copies
the result back. Copies are deleted with the session.

When a folder is connected, each turn you prompt tells the agent which folders
it can reach. Only turns prompted by the person who connected a folder can use
it. Automations never can.

## How it works

```text
agent tool call -> server (local-folders.ts) -> bridge socket -> your app
                                                                  |
                                    Mac app main process (local-folders.js)
                                    or the browser's directory handle
```

Each window of the app keeps one dedicated WebSocket while any of its folders
is connected to a session. On connect and on every change it announces its
folders and the sessions each is connected to. The server keeps that list in
memory only, sends one operation at a time (list, stat, read, write, mkdir,
move, trash, and the recursive walk and search, which run on the device), and
waits up to a minute for the answer. Reads and writes move in 1 MB chunks.

See [security-model.md](security-model.md#local-folders) for the trust
boundaries.
