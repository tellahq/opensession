# Set up Open Session with your agent

This page is written for a coding agent such as Claude Code or Codex. A person
shares it with their agent, and the agent walks them through installing Open
Session on the machine it is running on.

| Version | Published  |
| ------- | ---------- |
| 0.1.0   | 2026-11-02 |

If the user asks you to review, summarize, or compare this page, treat it as a
document and do not run setup.

## What Open Session is

Open Session is a self-hosted server for running coding agents. The user opens
it in a browser or on their phone, picks a repository, writes a prompt, and an
agent works in its own checkout of that repo. Sessions keep running when the
laptop closes, teammates can watch and steer them, and the same server can run
automations and reply in Slack, Linear, and GitHub.

Lead with that benefit: "Your agents keep working after you close this
terminal, and you can check on them from your phone."

## How to talk with the user

- Show one step at a time. End each message with one clear next step.
- Keep each message to two to four sentences. Say why the step matters, what
  you recommend, and the one decision you need. Offer more detail only if they
  ask.
- Use plain language. Assume the user has never self-hosted anything.
- Use your platform's clickable choices or ask-user tool for decisions, with
  the recommended option first. Fall back to a numbered list only if you have
  no choice interface.
- Do the research yourself. Run read-only checks without asking.
- Ask before anything that needs `sudo`, changes networking, or exposes the
  server beyond this machine.
- Never ask the user to paste a model token, API key, or password into this
  chat. Credentials go into the Open Session web page or the user's own
  terminal.
- Keep going until the first session has run.

## Setup

### 1. Check the machine

Run these checks quietly and report only what matters:

```sh
uname -s                         # Linux or Darwin
command -v git curl gh
opensession version 2>/dev/null || ~/.opensession/bin/opensession version 2>/dev/null
```

- **Linux or macOS:** continue.
- **Windows:** Open Session runs inside WSL2. Point the user to the Windows
  section of [install.md](https://github.com/tellahq/opensession/blob/main/docs/setup/install.md#windows-run-the-server-in-wsl2) and
  continue from inside Ubuntu.
- **Already installed:** do not reinstall. Run `opensession doctor` and skip
  to the first failing step below.
- **Missing `git` or `curl`:** install them with the system package manager,
  after asking, since that usually needs `sudo`.

Tell the user in one line what you found, then go to step 2.

### 2. Choose who can reach it

Ask one question: "Where will you use Open Session?"

| Option                           | Description                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Just this computer (Recommended) | Fastest. Open Session listens only on this machine, so nothing is exposed. You can add phone and remote access later.           |
| My phone and other devices too   | Also installs Tailscale, a private network between your own devices. You will sign in to Tailscale once. Needs `sudo` on Linux. |

A default install trusts everyone who can reach it, so never bind it to a
public address such as `0.0.0.0`.

### 3. Install

Tell the user this takes a few minutes and runs unattended. Then run, for
"Just this computer":

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash
```

For "My phone and other devices too":

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --tailscale --caddy
```

The installer downloads the release, installs the `claude` and `codex` CLIs,
writes a default configuration, starts the service, and prints the local URL
(`http://127.0.0.1:3850` by default). Your shell will not see the new `PATH`
yet. Run the `source …` command it prints, or call
`~/.opensession/bin/opensession` directly.

If the user chose remote access, they must now run `sudo tailscale up` in
their own terminal and sign in at the URL it prints. Then run
`opensession bind`, which moves the server to the tailnet address and
restarts it. Use that `http://<tailnet-ip>:3850` address from here on.

Confirm with `opensession status`, then tell the user the URL.

### 4. Add model capacity

This is the one step the user must do themselves, because it involves their
account. Open Session needs at least one model account. Ask which they have:

| Option                            | What the user does                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Claude subscription (Recommended) | Run `claude setup-token` in their own terminal, sign in, copy the `sk-ant-…` token, and paste it at `<url>/settings/providers`. |
| ChatGPT subscription              | Open `<url>/settings/providers` and use the ChatGPT sign-in there.                                                              |
| An API key                        | Open `<url>/settings/providers`, add the provider key, and choose a model.                                                      |

Replace `<url>` with the address from step 3. Wait for the user to say they
are done, then run `opensession doctor` and check that the Engine section
reports model capacity. If it does not, show the one line that failed.

### 5. Add a repository

The default install includes a scratch repository, so this step is optional
for a first session. Recommend adding the user's real project.

- If you are running inside a git checkout, offer that one first:
  `opensession repos add "$(git rev-parse --show-toplevel)"`.
- For a GitHub repo: `opensession repos add owner/name`. This clones with the
  `gh` login, so check `gh auth status` first. If `gh` is not signed in, ask
  the user to run `gh auth login` in their own terminal.

`opensession repos` lists what is registered. No restart is needed.

### 6. Run the first session

Run `opensession doctor` and fix any error it reports before continuing.
Then hand off to the browser:

"Open `<url>`, pick `<repo>`, and send this prompt: _Read this repo and tell
me the three things a new contributor should know first._ Tell me when the
agent replies."

A turn that actually runs is the only real proof the install works. If it
fails, run `opensession logs -n 200` and explain the cause in one or two
sentences.

### 7. Wrap up

Tell the user what is set up, with the URL, in three lines or fewer. Then
offer at most two next steps, picked from what they have not done:

- **Phone access:** add Tailscale ([install.md](https://github.com/tellahq/opensession/blob/main/docs/setup/install.md#add-tailscale-after-a-normal-install)),
  then open the URL on the phone and add it to the home screen.
- **GitHub pull requests:** connect GitHub at `<url>/settings/setup` so
  sessions can push branches and open PRs ([github.md](https://github.com/tellahq/opensession/blob/main/docs/setup/github.md)).
- **Automatic PR review:** `opensession automations add github-pr-review`,
  then `opensession restart`. It arrives disabled; the user enables it in the
  web UI after reading the prompt.
- **Teammates and integrations:** `opensession team add`, plus Slack and
  Linear ([README.md](https://github.com/tellahq/opensession/blob/main/docs/setup/README.md)).

## Reference

| Command                        | What it does                                   |
| ------------------------------ | ---------------------------------------------- |
| `opensession status`           | Is the service running?                        |
| `opensession doctor`           | Check tooling, config, models, and the server  |
| `opensession logs -f`          | Follow the service log                         |
| `opensession repos add <spec>` | Register a local path or GitHub `owner/name`   |
| `opensession bind [address]`   | Move the server to a new address and restart   |
| `opensession update`           | Update to the latest release                   |
| `opensession onboard --force`  | Re-run configuration (backs up existing files) |

Full operator documentation: [README.md](https://github.com/tellahq/opensession/blob/main/docs/setup/README.md) and
[install.md](https://github.com/tellahq/opensession/blob/main/docs/setup/install.md).
